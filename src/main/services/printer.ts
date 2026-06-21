import ThermalPrinter from 'node-thermal-printer';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { getDb } from '../db/schema';
import { fmtCT } from '../utils/time';

const { printer: ThermalPrinterClass, types } = ThermalPrinter;

const W = 42; // receipt column width (characters)

function formatCurrency(n: number): string {
  const val = Number(n);
  return (val < 0 ? '-$' : '$') + Math.abs(val).toFixed(2);
}

function padLine(left: string, right: string, width = W): string {
  const spaces = width - left.length - right.length;
  return left + ' '.repeat(Math.max(1, spaces)) + right;
}

function center(text: string, width = W): string {
  const pad = Math.max(0, Math.floor((width - text.length) / 2));
  return ' '.repeat(pad) + text;
}

function cardLabel(transaction: Record<string, unknown>): string {
  const last4 = transaction.last4 as string | undefined;
  const auth = transaction.auth_code as string | undefined;
  const cardType = (transaction.card_type as string || '').toUpperCase();
  const parts: string[] = [];
  if (cardType) parts.push(cardType);
  else parts.push('CARD');
  if (last4) parts.push(`****${last4}`);
  return parts.join(' ');
}

export async function printReceiptForTxn(
  transaction: Record<string, unknown>,
  items: Record<string, unknown>[],
  config: Record<string, unknown>
): Promise<{ success: boolean; error?: string; saved_to?: string }> {
  const db = getDb();
  const settingsRow = db.prepare("SELECT value FROM settings WHERE key = 'printer_interface'").get() as { value: string } | undefined;
  const printerInterface = settingsRow?.value || 'printer';

  const isRefund = (transaction.total as number) < 0;
  const lines = buildReceiptLines(transaction, items, config, isRefund);
  const receiptText = lines.join('\n');

  // Always save to file as backup
  const receiptsDir = path.join(app.getPath('userData'), 'receipts');
  if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });
  const filePath = path.join(receiptsDir, `receipt-${transaction.id}.txt`);
  fs.writeFileSync(filePath, receiptText, 'utf8');

  // Attempt thermal print (Star or Epson)
  if (printerInterface !== 'none') {
    try {
      const typeRow = db.prepare("SELECT value FROM settings WHERE key = 'printer_type'").get() as { value: string } | undefined;
      const printerType = typeRow?.value === 'star' ? types.STAR : types.EPSON;

      const printer = new ThermalPrinterClass({
        type: printerType,
        interface: printerInterface,
        removeSpecialCharacters: false,
        lineCharacter: '-',
      });

      const isConnected = await printer.isPrinterConnected();
      if (isConnected) {
        const storeName = (config.store_name as string) || 'Store';

        // ── Header ──────────────────────────────────
        printer.alignCenter();
        printer.bold(true);
        printer.setTextSize(1, 1);
        printer.println(storeName);
        printer.setTextNormal();
        printer.bold(false);
        if (config.address) printer.println(config.address as string);
        if (config.phone) printer.println(config.phone as string);
        printer.drawLine();

        if (isRefund) {
          printer.bold(true);
          printer.println('*** RETURN / REFUND ***');
          printer.bold(false);
        }

        // ── Transaction meta ─────────────────────────
        printer.alignLeft();
        printer.println(`Txn #${transaction.id}   ${fmtCT(transaction.created_at as string)}`);
        printer.println(`Cashier: ${transaction.cashier_name || 'N/A'}`);
        if (transaction.customer_name) {
          printer.println(`Customer: ${transaction.customer_name}`);
        }
        printer.drawLine();

        // ── Line items ───────────────────────────────
        for (const item of items) {
          const qty = item.qty as number;
          const unitPrice = item.unit_price as number;
          const lineTotal = item.line_total as number;
          const name = String(item.product_name || 'Item');
          printer.println(name.substring(0, W));
          const lineStr = `  ${qty} x ${formatCurrency(unitPrice)}`;
          printer.println(padLine(lineStr, formatCurrency(lineTotal)));
        }

        // ── Totals ───────────────────────────────────
        printer.drawLine();
        const subtotalForReceipt = (transaction.subtotal as number);
        const tipAmt = (transaction.tip_amount as number) || 0;
        const taxRate = transaction.tax_rate as number;
        printer.println(padLine('Subtotal:', formatCurrency(subtotalForReceipt)));
        if ((transaction.discount_amount as number) > 0) {
          printer.println(padLine('Discount:', `-${formatCurrency(transaction.discount_amount as number)}`));
        }
        if (tipAmt > 0) {
          printer.println(padLine('Tip:', formatCurrency(tipAmt)));
        }
        printer.println(padLine(`Tax (${(taxRate * 100).toFixed(2)}%):`, formatCurrency(transaction.tax_amount as number)));
        printer.bold(true);
        printer.println(padLine(isRefund ? 'REFUND TOTAL:' : 'TOTAL:', formatCurrency(transaction.total as number)));
        printer.bold(false);
        printer.drawLine();

        // ── Payment ──────────────────────────────────
        if (transaction.payment_method === 'cash') {
          printer.println(padLine('CASH', ''));
          printer.println(padLine('Tendered:', formatCurrency(transaction.cash_tendered as number)));
          printer.println(padLine('Change:', formatCurrency(transaction.change_given as number)));
        } else if (transaction.payment_method === 'card' || transaction.payment_method === 'split') {
          printer.println(padLine(cardLabel(transaction), ''));
          if (transaction.auth_code) {
            printer.println(`Auth Code:  ${transaction.auth_code}`);
          }
          if (transaction.last4) {
            printer.println(`Card #:     ****${transaction.last4}`);
          }
          if (transaction.terminal_ref && transaction.terminal_ref !== transaction.auth_code) {
            printer.println(`Ref:        ${transaction.terminal_ref}`);
          }
          if (transaction.signature_data) {
            printer.println('Signature captured on terminal');
          }
        }

        // ── Footer ───────────────────────────────────
        printer.drawLine();
        printer.alignCenter();
        if (config.footer_message) printer.println(config.footer_message as string);
        if (transaction.is_gold) {
          printer.bold(true);
          printer.println('★ GOLD MEMBER ★');
          printer.bold(false);
        }
        if ((transaction.points_earned as number) > 0 || transaction.points_balance != null) {
          printer.println(`Points earned: ${transaction.points_earned || 0}  Balance: ${transaction.points_balance ?? 0}`);
        }
        const minAgeT = (config.min_age as number) ?? 21;
        if (minAgeT > 0) printer.println(`Must be ${minAgeT}+ to purchase.`);
        printer.println(`Thank you for shopping ${storeName}!`);
        printer.partialCut();   // Star partial cut (leaves small tab)
        await printer.execute();
        return { success: true };
      }
    } catch (_e) {
      // Fall through to file fallback
    }
  }

  return { success: true, saved_to: filePath };
}

function buildReceiptLines(
  transaction: Record<string, unknown>,
  items: Record<string, unknown>[],
  config: Record<string, unknown>,
  isRefund = false
): string[] {
  const lines: string[] = [];
  const sep = '─'.repeat(W);
  const storeName = (config.store_name as string) || 'Store';

  lines.push(center(storeName));
  if (config.address) lines.push(center(config.address as string));
  if (config.phone)   lines.push(center(config.phone as string));
  lines.push(sep);

  if (isRefund) lines.push(center('*** RETURN / REFUND ***'));

  lines.push(`Txn #${transaction.id}   ${fmtCT(transaction.created_at as string)}`);
  lines.push(`Cashier: ${transaction.cashier_name || 'N/A'}`);
  if (transaction.customer_name) lines.push(`Customer: ${transaction.customer_name}`);
  lines.push(sep);

  for (const item of items) {
    const qty = item.qty as number;
    const unitPrice = item.unit_price as number;
    const lineTotal = item.line_total as number;
    lines.push(String(item.product_name || 'Item').substring(0, W));
    lines.push(padLine(`  ${qty} x ${formatCurrency(unitPrice)}`, formatCurrency(lineTotal)));
  }

  lines.push(sep);
  const taxRate = transaction.tax_rate as number;
  const tipAmt = (transaction.tip_amount as number) || 0;
  lines.push(padLine('Subtotal:', formatCurrency(transaction.subtotal as number)));
  if ((transaction.discount_amount as number) > 0) {
    lines.push(padLine('Discount:', `-${formatCurrency(transaction.discount_amount as number)}`));
  }
  if (tipAmt > 0) {
    lines.push(padLine('Tip:', formatCurrency(tipAmt)));
  }
  lines.push(padLine(`Tax (${(taxRate * 100).toFixed(2)}%):`, formatCurrency(transaction.tax_amount as number)));
  lines.push(padLine(isRefund ? 'REFUND TOTAL:' : 'TOTAL:', formatCurrency(transaction.total as number)));
  lines.push(sep);

  if (transaction.payment_method === 'cash') {
    lines.push('CASH');
    lines.push(padLine('Tendered:', formatCurrency(transaction.cash_tendered as number)));
    lines.push(padLine('Change:', formatCurrency(transaction.change_given as number)));
  } else if (transaction.payment_method === 'card' || transaction.payment_method === 'split') {
    lines.push(cardLabel(transaction));
    if (transaction.auth_code) lines.push(`Auth Code:  ${transaction.auth_code}`);
    if (transaction.last4)     lines.push(`Card #:     ****${transaction.last4}`);
    if (transaction.signature_data) lines.push('Signature captured on terminal');
  }

  lines.push(sep);
  if (transaction.is_gold) lines.push(center('★ GOLD MEMBER ★'));
  if ((transaction.points_earned as number) > 0 || transaction.points_balance != null) {
    lines.push(center(`Points earned: ${transaction.points_earned || 0}  Balance: ${transaction.points_balance ?? 0}`));
  }
  if (config.footer_message) lines.push(center(config.footer_message as string));
  const minAgeLine = (config.min_age as number) ?? 21;
  if (minAgeLine > 0) lines.push(center(`Must be ${minAgeLine}+ to purchase.`));
  lines.push(center(`Thank you for shopping ${storeName}!`));

  return lines;
}

/**
 * Pop the cash drawer.
 *
 * Standard retail wiring: the cash drawer plugs into the receipt printer's
 * RJ11/RJ12 "kick" port and is opened by sending an ESC/POS kick pulse through
 * the printer. So this reuses the configured receipt printer connection.
 * If no printer is connected (or interface = none), it returns a soft failure
 * and the caller just logs it — the drawer can still be opened with its key.
 */
export async function openCashDrawer(): Promise<{ success: boolean; error?: string }> {
  const db = getDb();
  const printerInterface = (db.prepare("SELECT value FROM settings WHERE key = 'printer_interface'").get() as { value: string } | undefined)?.value || 'printer';
  if (printerInterface === 'none') {
    return { success: false, error: 'No receipt printer configured (the drawer pops through the printer).' };
  }
  try {
    const printerType = (db.prepare("SELECT value FROM settings WHERE key = 'printer_type'").get() as { value: string } | undefined)?.value === 'star'
      ? types.STAR : types.EPSON;
    const printer = new ThermalPrinterClass({
      type: printerType,
      interface: printerInterface,
      removeSpecialCharacters: false,
      lineCharacter: '-',
    });
    const connected = await printer.isPrinterConnected();
    if (!connected) return { success: false, error: 'Receipt printer not reachable.' };
    printer.openCashDrawer();
    await printer.execute();
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/**
 * Build a plain-text SMS receipt (short form).
 */
export function buildSmsReceipt(
  transaction: Record<string, unknown>,
  items: Record<string, unknown>[],
  config: Record<string, unknown>
): string {
  const storeName = (config.store_name as string) || 'Store';
  const phone = (config.phone as string) || '';
  const isRefund = (transaction.total as number) < 0;

  const itemLines = items.map(i =>
    `  ${i.qty}x ${i.product_name} ${formatCurrency(i.line_total as number)}`
  ).join('\n');

  const payLine = transaction.payment_method === 'cash'
    ? `Cash (Change: ${formatCurrency(transaction.change_given as number)})`
    : `${cardLabel(transaction)}${transaction.auth_code ? ` Auth:${transaction.auth_code}` : ''}`;

  return [
    `${storeName}${phone ? ' | ' + phone : ''}`,
    `${isRefund ? 'REFUND' : 'Receipt'} #${transaction.id}  ${fmtCT(transaction.created_at as string)}`,
    '',
    itemLines,
    '',
    `Subtotal: ${formatCurrency(transaction.subtotal as number)}`,
    `Tax:      ${formatCurrency(transaction.tax_amount as number)}`,
    `TOTAL:    ${formatCurrency(transaction.total as number)}`,
    `Payment:  ${payLine}`,
    '',
    ((config.min_age as number) ?? 21) > 0
      ? `Thank you! Must be ${(config.min_age as number) ?? 21}+ to purchase.`
      : 'Thank you!',
  ].join('\n');
}
