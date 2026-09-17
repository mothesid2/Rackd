import ThermalPrinter from 'node-thermal-printer';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { app } from 'electron';
import { getDb } from '../db/schema';
import { fmtCT } from '../utils/time';

const IS_WIN = process.platform === 'win32';

const { printer: ThermalPrinterClass, types } = ThermalPrinter;

const W = 42; 



let printerDriver: any = null;
function getPrinterDriver(): any {
  if (printerDriver === null) {
    try { printerDriver = require('@thiagoelg/node-printer'); }
    catch { printerDriver = false; }
  }
  return printerDriver || null;
}


const RAW_PRINT_PS1 = `param([Parameter(Mandatory=$true)][string]$PrinterName,[Parameter(Mandatory=$true)][string]$FilePath)
$ErrorActionPreference='Stop'
$bytes=[System.IO.File]::ReadAllBytes($FilePath)
$sig=@'
using System;
using System.Runtime.InteropServices;
public class RawPrinterHelper{
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] public struct DOCINFOW{[MarshalAs(UnmanagedType.LPWStr)] public string pDocName;[MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;[MarshalAs(UnmanagedType.LPWStr)] public string pDataType;}
 [DllImport("winspool.Drv",EntryPoint="OpenPrinterW",SetLastError=true,CharSet=CharSet.Unicode)] public static extern bool OpenPrinter(string s,out IntPtr h,IntPtr d);
 [DllImport("winspool.Drv",EntryPoint="ClosePrinter",SetLastError=true)] public static extern bool ClosePrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="StartDocPrinterW",SetLastError=true,CharSet=CharSet.Unicode)] public static extern bool StartDocPrinter(IntPtr h,int l,ref DOCINFOW di);
 [DllImport("winspool.Drv",EntryPoint="EndDocPrinter",SetLastError=true)] public static extern bool EndDocPrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="StartPagePrinter",SetLastError=true)] public static extern bool StartPagePrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="EndPagePrinter",SetLastError=true)] public static extern bool EndPagePrinter(IntPtr h);
 [DllImport("winspool.Drv",EntryPoint="WritePrinter",SetLastError=true)] public static extern bool WritePrinter(IntPtr h,byte[] b,int c,out int w);
 public static void SendBytes(string printer,byte[] data){
  IntPtr h;
  if(!OpenPrinter(printer,out h,IntPtr.Zero)) throw new Exception("OpenPrinter failed err="+Marshal.GetLastWin32Error());
  try{
   DOCINFOW di=new DOCINFOW(); di.pDocName="rackd receipt"; di.pDataType="RAW";
   if(!StartDocPrinter(h,1,ref di)) throw new Exception("StartDocPrinter failed err="+Marshal.GetLastWin32Error());
   try{
    if(!StartPagePrinter(h)) throw new Exception("StartPagePrinter failed err="+Marshal.GetLastWin32Error());
    int w; if(!WritePrinter(h,data,data.Length,out w)) throw new Exception("WritePrinter failed err="+Marshal.GetLastWin32Error());
    EndPagePrinter(h);
   } finally { EndDocPrinter(h); }
  } finally { ClosePrinter(h); }
 }
}
'@
Add-Type -TypeDefinition $sig -Language CSharp
[RawPrinterHelper]::SendBytes($PrinterName,$bytes)
Write-Output "PRINT_OK"`;

function rawPrintScriptPath(): string {
  const p = path.join(app.getPath('userData'), 'print-raw.ps1');
  try { fs.writeFileSync(p, RAW_PRINT_PS1, 'utf8'); } catch {  }
  return p;
}


function rawPrintWindows(printerName: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `rackd-print-${Date.now()}-${Math.random().toString(36).slice(2)}.bin`);
    try { fs.writeFileSync(tmp, data); } catch (e) { reject(e); return; }
    const ps1 = rawPrintScriptPath();
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ps1, '-PrinterName', printerName, '-FilePath', tmp],
      { timeout: 15000, windowsHide: true },
      (err, stdout, stderr) => {
        try { fs.unlinkSync(tmp); } catch {  }
        if (err || !/PRINT_OK/.test(String(stdout))) {
          reject(new Error(`Raw print failed: ${String(stderr || err || 'unknown').trim().substring(0, 300)}`));
        } else resolve();
      });
  });
}



export function listInstalledPrinters(): Promise<{ name: string; isDefault: boolean; status: string }[]> {
  if (IS_WIN) {
    return new Promise((resolve) => {
      execFile('powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command',
         'Get-CimInstance Win32_Printer | Select-Object Name,Default,PrinterStatus | ConvertTo-Json -Compress'],
        { timeout: 8000, windowsHide: true },
        (err, stdout) => {
          if (err) { resolve([]); return; }
          try {
            let arr = JSON.parse(stdout || '[]');
            if (!Array.isArray(arr)) arr = [arr];
            
            resolve(arr.map((p: any) => ({ name: String(p.Name), isDefault: !!p.Default, status: String(p.PrinterStatus ?? '') }))
                       .filter((p: { name: string }) => p.name && p.name !== 'undefined'));
          } catch { resolve([]); }
        });
    });
  }
  
  const drv = getPrinterDriver();
  if (!drv) return Promise.resolve([]);
  try {
    let def = '';
    try { def = drv.getDefaultPrinterName() || ''; } catch {  }
    
    return Promise.resolve((drv.getPrinters() || []).map((p: any) => ({
      name: p.name,
      isDefault: p.name === def,
      status: Array.isArray(p.status) ? p.status.join(',') : String(p.status || ''),
    })));
  } catch { return Promise.resolve([]); }
}


function buildPrinterFromSettings(): any | null {
  const db = getDb();
  const get = (k: string, d = '') =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value ?? d;
  const iface = (get('printer_interface', '') || '').trim();
  if (!iface || iface.toLowerCase() === 'none') return null;
  
  
  
  const type = get('printer_type', 'epson') === 'star' ? types.STAR : types.EPSON;
  const base = { type, removeSpecialCharacters: false, lineCharacter: '-' };
  if (/^tcp:\/\//i.test(iface)) {
    return new ThermalPrinterClass({ ...base, interface: iface });
  }
  
  if (IS_WIN) {
    
    
    
    
    
    const printer: any = new ThermalPrinterClass({ ...base, interface: 'tcp://127.0.0.1:9100' });
    printer.execute = async () => {
      const buf = printer.getBuffer();
      await rawPrintWindows(iface, buf);
      printer.clear();
    };
    return printer;
  }
  const driver = getPrinterDriver();
  if (!driver) return null;
  return new ThermalPrinterClass({ ...base, interface: `printer:${iface}`, driver });
}


export async function testPrint(): Promise<{ success: boolean; error?: string }> {
  const printer = buildPrinterFromSettings();
  if (!printer) return { success: false, error: 'No receipt printer selected. Pick one in Settings → Receipt Printer.' };
  try {
    printer.alignCenter();
    printer.bold(true); bigText(printer); printer.println('*** TEST PRINT ***'); printer.setTextNormal(); printer.bold(false);
    printer.println('rackd POS');
    printer.println(fmtCT(new Date().toISOString()));
    printer.drawLine();
    printer.alignLeft();
    printer.println('If you can read this, the receipt');
    printer.println('printer is connected and working.');
    printer.drawLine();
    printer.alignCenter();
    printer.println('Cash drawer test:');
    printer.openCashDrawer();
    printer.partialCut();
    await printer.execute();
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}


function bigText(printer: any): void {
  if (typeof printer.setTextSize === 'function') printer.setTextSize(1, 1);
}

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


function wrapWords(text: string, width = W): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && (line.length + 1 + word.length) > width) { out.push(line); line = ''; }
    line = line ? `${line} ${word}` : word;
  }
  if (line) out.push(line);
  return out;
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
  const isRefund = (transaction.total as number) < 0;
  const lines = buildReceiptLines(transaction, items, config, isRefund);
  const receiptText = lines.join('\n');

  
  const receiptsDir = path.join(app.getPath('userData'), 'receipts');
  if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });
  const filePath = path.join(receiptsDir, `receipt-${transaction.id}.txt`);
  fs.writeFileSync(filePath, receiptText, 'utf8');

  
  
  
  const printer = buildPrinterFromSettings();
  if (printer) {
    try {
      {
        const storeName = (config.store_name as string) || 'Store';

        
        printer.alignCenter();
        printer.bold(true);
        bigText(printer);
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

        
        printer.alignLeft();
        printer.println(`Txn #${transaction.id}   ${fmtCT(transaction.created_at as string)}`);
        printer.println(`Cashier: ${transaction.cashier_name || 'N/A'}`);
        if (transaction.customer_name) {
          printer.println(`Customer: ${transaction.customer_name}`);
        }
        printer.drawLine();

        
        for (const item of items) {
          const qty = item.qty as number;
          const unitPrice = item.unit_price as number;
          const lineTotal = item.line_total as number;
          const name = String(item.product_name || 'Item');
          printer.println(name.substring(0, W));
          const lineStr = `  ${qty} x ${formatCurrency(unitPrice)}`;
          printer.println(padLine(lineStr, formatCurrency(lineTotal)));
        }

        
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
        if (config.refund_policy) {
          printer.drawLine();
          for (const l of wrapWords(String(config.refund_policy))) printer.println(l);
        }
        printer.partialCut();   
        await printer.execute();
        return { success: true };
      }
    } catch (_e) {
      
    }
  }

  return { success: true, saved_to: filePath };
}


export async function printZReport(
  report: Record<string, unknown>,
  config: Record<string, unknown>,
  opts: { preview?: boolean } = {}
): Promise<{ success: boolean; error?: string; saved_to?: string }> {
  const preview = !!opts.preview;
  const lines = buildZReportLines(report, config);
  const reportText = lines.join('\n');

  const reportsDir = path.join(app.getPath('userData'), 'z-reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const filePath = path.join(reportsDir, `z-report-${String(report.generated_at).replace(/[:.]/g, '-')}.txt`);
  fs.writeFileSync(filePath, reportText, 'utf8');

  const printer = buildPrinterFromSettings();
  if (printer) {
    try {
      const storeName = (config.store_name as string) || 'Store';
      const brands = (report.by_card_brand as { brand: string; amount: number; count: number }[]) || [];
      const tipPool = report.tip_pool as Record<string, unknown> | undefined;

      printer.alignCenter();
      printer.bold(true);
      bigText(printer);
      printer.println(storeName);
      printer.setTextNormal();
      printer.bold(false);
      if (config.address) printer.println(config.address as string);
      printer.bold(true);
      
      
      
      
      
      printer.println(preview ? 'CLOSING SHIFT SUMMARY' : 'Z REPORT — END OF DAY');
      printer.bold(false);
      printer.drawLine();

      printer.alignLeft();
      printer.println(`Generated: ${fmtCT(report.generated_at as string)}`);
      printer.println(`Shift opened: ${fmtCT(report.shift_opened_at as string)}`);
      printer.println(`Closed by: ${report.cashier_name || 'N/A'}`);
      printer.println(`Transactions: ${report.sale_count}   Avg ticket: ${formatCurrency(report.avg_ticket as number)}`);
      printer.drawLine();

      
      printer.bold(true);
      printer.println('PAYMENT BREAKDOWN');
      printer.bold(false);
      printer.println(padLine('Cash:', formatCurrency(report.cash_total as number)));
      for (const b of brands) {
        printer.println(padLine(`  ${b.brand} (${b.count}):`, formatCurrency(b.amount)));
      }
      if ((report.card_total as number) > 0) {
        printer.println(padLine('Card total:', formatCurrency(report.card_total as number)));
      }
      if ((report.split_total as number) > 0) {
        printer.println(padLine('Split tender:', formatCurrency(report.split_total as number)));
      }
      if ((report.online_total as number) > 0) {
        printer.println(padLine('Online (prepaid):', formatCurrency(report.online_total as number)));
      }
      printer.drawLine();

      
      printer.bold(true);
      printer.println('SALES SUMMARY');
      printer.bold(false);
      printer.println(padLine('Gross sales:', formatCurrency(report.gross_sales as number)));
      printer.println(padLine('Discounts:', `-${formatCurrency(report.discount_total as number)}`));
      printer.println(padLine('Tax collected:', formatCurrency(report.tax_total as number)));
      printer.bold(true);
      printer.println(padLine('NET SALES:', formatCurrency(report.net_sales as number)));
      printer.bold(false);
      if ((report.card_processing_fee_amount as number) > 0) {
        printer.println(padLine(
          `Est. card fee (${report.card_processing_fee_pct}%+${report.card_processing_fee_flat_cents}c):`,
          formatCurrency(report.card_processing_fee_amount as number)
        ));
      }

      
      const byCategory = (report.by_category as { category: string; qty: number; revenue: number }[]) || [];
      if (byCategory.length) {
        printer.drawLine();
        printer.bold(true);
        printer.println('SALES BY DEPARTMENT');
        printer.bold(false);
        for (const c of byCategory) {
          printer.println(padLine(`${c.category} (${c.qty}):`, formatCurrency(c.revenue)));
        }
      }

      
      if (tipPool && (tipPool.total_tips as number) > 0) {
        printer.drawLine();
        printer.bold(true);
        printer.println('TIP POOL');
        printer.bold(false);
        printer.println(padLine('Total tips:', formatCurrency(tipPool.total_tips as number)));
        if ((tipPool.deduction_amount as number) > 0) {
          printer.println(padLine('Processing deduction:', `-${formatCurrency(tipPool.deduction_amount as number)}`));
        }
        printer.println(padLine('Pool distributed:', formatCurrency(tipPool.pool_amount as number)));
        const shares = (tipPool.by_employee as { name: string; hours: number; share: number }[]) || [];
        for (const s of shares) {
          printer.println(padLine(`  ${s.name} (${s.hours.toFixed(1)}h):`, formatCurrency(s.share)));
        }
        if (tipPool.skip_reason) printer.println(String(tipPool.skip_reason).substring(0, W));
      }

      printer.drawLine();
      printer.alignCenter();
      printer.println(preview ? '*** PREVIEW — SHIFT NOT CLOSED ***' : '*** SHIFT CLOSED & RESET ***');
      printer.partialCut();
      await printer.execute();
      return { success: true };
    } catch (_e) {
      
    }
  }

  return { success: true, saved_to: filePath };
}


export async function printPeriodReport(
  report: Record<string, unknown>,
  config: Record<string, unknown>
): Promise<{ success: boolean; error?: string; saved_to?: string }> {
  const summary = (report.summary as Record<string, unknown>) || {};
  const payments = (report.payments as Record<string, unknown>) || {};
  const period = (report.period as Record<string, unknown>) || {};
  const byCategory = (report.by_category as { category: string; qty: number; revenue: number }[]) || [];
  const brands = (payments.brands as { brand: string; amount: number; count: number }[]) || [];
  const otherCard = (payments.other_card as { amount: number; count: number }) || { amount: 0, count: 0 };

  const reportsDir = path.join(app.getPath('userData'), 'period-reports');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const stamp = String(report.generated_at || new Date().toISOString()).replace(/[:.]/g, '-');
  const filePath = path.join(reportsDir, `period-report-${stamp}.txt`);
  fs.writeFileSync(
    filePath,
    [`Period: ${period.start} to ${period.end}`, `Total collected: ${formatCurrency(summary.total_collected as number)}`].join('\n'),
    'utf8'
  );

  const printer = buildPrinterFromSettings();
  if (printer) {
    try {
      const storeName = (config.store_name as string) || 'Store';

      printer.alignCenter();
      printer.bold(true);
      bigText(printer);
      printer.println(storeName);
      printer.setTextNormal();
      printer.bold(false);
      if (config.address) printer.println(config.address as string);
      printer.bold(true);
      printer.println((report.scope === 'location' ? 'LOCATION ' : '') + 'SALES REPORT');
      printer.bold(false);
      printer.drawLine();

      printer.alignLeft();
      printer.println(`Period: ${period.label || `${period.start} to ${period.end}`}`);
      printer.println(`Generated by: ${report.generated_by || 'N/A'}`);
      printer.println(`Transactions: ${summary.count ?? 0}   Avg ticket: ${formatCurrency((summary.avg as number) || 0)}`);
      printer.drawLine();

      
      printer.bold(true);
      printer.println('PAYMENT BREAKDOWN');
      printer.bold(false);
      printer.println(padLine('Cash:', formatCurrency((payments.cash as number) || 0)));
      for (const b of brands) {
        if (b.amount > 0) printer.println(padLine(`  ${b.brand} (${b.count}):`, formatCurrency(b.amount)));
      }
      if (otherCard.amount > 0) printer.println(padLine(`  Other card (${otherCard.count}):`, formatCurrency(otherCard.amount)));
      if ((payments.card_total as number) > 0) {
        printer.println(padLine('Card total:', formatCurrency(payments.card_total as number)));
      }
      printer.drawLine();

      
      printer.bold(true);
      printer.println('SALES SUMMARY');
      printer.bold(false);
      printer.println(padLine('Gross sales:', formatCurrency((summary.gross as number) || 0)));
      printer.println(padLine('Discounts:', `-${formatCurrency((summary.discounts as number) || 0)}`));
      printer.println(padLine('Tax collected:', formatCurrency((summary.tax as number) || 0)));
      printer.bold(true);
      printer.println(padLine('TOTAL COLLECTED:', formatCurrency((summary.total_collected as number) || 0)));
      printer.bold(false);
      printer.println(padLine('Units / transaction:', String(((summary.units_per_txn as number) || 0).toFixed(2))));

      const refunds = (report.refunds as { count: number; total: number }) || { count: 0, total: 0 };
      if (refunds.count > 0) {
        printer.println(padLine('Refunds:', `${refunds.count} / ${formatCurrency(refunds.total)}`));
      }

      
      if (byCategory.length) {
        printer.drawLine();
        printer.bold(true);
        printer.println('SALES BY DEPARTMENT');
        printer.bold(false);
        for (const c of byCategory) {
          printer.println(padLine(`${c.category} (${c.qty}):`, formatCurrency(c.revenue)));
        }
      }

      printer.drawLine();
      printer.alignCenter();
      printer.println(`Generated: ${fmtCT((report.generated_at as string) || new Date().toISOString())}`);
      printer.partialCut();
      await printer.execute();
      return { success: true };
    } catch (_e) {
      
    }
  }

  return { success: true, saved_to: filePath };
}

function buildZReportLines(report: Record<string, unknown>, config: Record<string, unknown>): string[] {
  const lines: string[] = [];
  const storeName = (config.store_name as string) || 'Store';
  lines.push(storeName, 'Z REPORT — END OF DAY', '-'.repeat(W));
  lines.push(`Generated: ${fmtCT(report.generated_at as string)}`);
  lines.push(`Cashier: ${report.cashier_name || 'N/A'}`);
  lines.push(padLine('Cash:', formatCurrency(report.cash_total as number)));
  const brands = (report.by_card_brand as { brand: string; amount: number; count: number }[]) || [];
  for (const b of brands) lines.push(padLine(`  ${b.brand}:`, formatCurrency(b.amount)));
  lines.push(padLine('NET SALES:', formatCurrency(report.net_sales as number)));
  return lines;
}


export function isPrinterConfigured(): boolean {
  return buildPrinterFromSettings() !== null;
}

export interface PickupReceiptOrder {
  order_number: string;
  customer_name?: string | null;
  customer_phone?: string | null;
  items: { qty: number; name: string; line_total: number }[];
  subtotal: number;
  tax: number;
  online_fee: number;
  total: number;
  created_at?: string | null;
}


export async function printPickupReceipt(
  order: PickupReceiptOrder,
  config: Record<string, unknown>
): Promise<{ success: boolean; error?: string; saved_to?: string }> {
  const storeName = (config.store_name as string) || 'Store';
  const sep = '─'.repeat(W);
  const lines: string[] = [];
  lines.push(center(storeName));
  if (config.address) lines.push(center(config.address as string));
  lines.push(sep);
  lines.push(center('*** ONLINE ORDER — PREPAID ***'));
  lines.push(center('PAID ONLINE • DO NOT COLLECT PAYMENT'));
  lines.push(sep);
  lines.push(`Pickup #${order.order_number}`);
  if (order.customer_name) lines.push(`Customer: ${order.customer_name}`);
  if (order.customer_phone) lines.push(`Phone:    ${order.customer_phone}`);
  if (order.created_at) lines.push(`Ordered:  ${fmtCT(order.created_at)}`);
  lines.push(sep);
  for (const it of order.items) {
    lines.push(String(it.name || 'Item').substring(0, W));
    lines.push(padLine(`  ${it.qty} x`, formatCurrency(it.line_total)));
  }
  lines.push(sep);
  lines.push(padLine('Subtotal:', formatCurrency(order.subtotal)));
  lines.push(padLine('Online Order Fee:', formatCurrency(order.online_fee)));
  lines.push(padLine('Tax:', formatCurrency(order.tax)));
  lines.push(padLine('PAID ONLINE:', formatCurrency(order.total)));
  lines.push(sep);
  lines.push(center('★ VERIFY 21+ PHOTO ID AT PICKUP ★'));
  lines.push(center('Hand order to the customer only'));
  lines.push(center('after checking a valid ID.'));
  lines.push(center(`Thank you for shopping ${storeName}!`));
  const receiptText = lines.join('\n');

  const receiptsDir = path.join(app.getPath('userData'), 'receipts');
  if (!fs.existsSync(receiptsDir)) fs.mkdirSync(receiptsDir, { recursive: true });
  const filePath = path.join(receiptsDir, `pickup-${order.order_number}.txt`);
  fs.writeFileSync(filePath, receiptText, 'utf8');

  const printer = buildPrinterFromSettings();
  if (printer) {
    try {
      printer.alignCenter();
      printer.bold(true); bigText(printer); printer.println(storeName); printer.setTextNormal();
      if (config.address) printer.println(config.address as string);
      printer.drawLine();
      printer.bold(true); bigText(printer); printer.println('ONLINE ORDER'); printer.setTextNormal();
      printer.bold(true); printer.println('PREPAID • DO NOT COLLECT PAYMENT'); printer.bold(false);
      printer.drawLine();
      printer.alignLeft();
      printer.bold(true); printer.println(`Pickup #${order.order_number}`); printer.bold(false);
      if (order.customer_name) { printer.bold(true); printer.println(`Customer: ${order.customer_name}`); printer.bold(false); }
      if (order.customer_phone) printer.println(`Phone:    ${order.customer_phone}`);
      if (order.created_at) printer.println(`Ordered:  ${fmtCT(order.created_at)}`);
      printer.drawLine();
      for (const it of order.items) {
        printer.println(String(it.name || 'Item').substring(0, W));
        printer.println(padLine(`  ${it.qty} x`, formatCurrency(it.line_total)));
      }
      printer.drawLine();
      printer.println(padLine('Subtotal:', formatCurrency(order.subtotal)));
      printer.println(padLine('Online Order Fee:', formatCurrency(order.online_fee)));
      printer.println(padLine('Tax:', formatCurrency(order.tax)));
      printer.bold(true); printer.println(padLine('PAID ONLINE:', formatCurrency(order.total))); printer.bold(false);
      printer.drawLine();
      printer.alignCenter();
      printer.bold(true); printer.println('VERIFY 21+ PHOTO ID AT PICKUP'); printer.bold(false);
      printer.println('Release the order only after');
      printer.println('checking a valid ID in person.');
      printer.println(`Thank you for shopping ${storeName}!`);
      printer.partialCut();
      await printer.execute();
      return { success: true };
    } catch {
      
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

  
  if (config.refund_policy) {
    lines.push(sep);
    for (const l of wrapWords(String(config.refund_policy))) lines.push(center(l));
  }

  return lines;
}


export async function openCashDrawer(): Promise<{ success: boolean; error?: string }> {
  const printer = buildPrinterFromSettings();
  if (!printer) {
    return { success: false, error: 'No receipt printer configured (the drawer pops through the printer).' };
  }
  try {
    
    
    
    
    
    printer.append(drawerKickBytes());
    await printer.execute();
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}


function drawerKickBytes(): Buffer {
  const db = getDb();
  const hex = ((db.prepare("SELECT value FROM settings WHERE key = 'drawer_kick_hex'").get() as { value: string } | undefined)?.value || '').trim();
  if (hex) {
    const bytes = hex.split(/[\s,]+/).filter(Boolean).map((h) => parseInt(h, 16));
    if (bytes.length && !bytes.some((b) => isNaN(b))) return Buffer.from(bytes);
  }
  
  return Buffer.from([0x1b, 0x70, 0x00, 0xff, 0xff, 0x1b, 0x70, 0x01, 0xff, 0xff]);
}


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
    ...(config.refund_policy ? ['', String(config.refund_policy)] : []),
  ].join('\n');
}
