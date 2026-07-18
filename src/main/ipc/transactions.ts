import { ipcMain } from 'electron';
import { DateTime } from 'luxon';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { nowCT, todayCT, TZ } from '../utils/time';
import { enqueueLocalRow, enqueueInventorySnapshot, enqueueStockMovement, enqueueCustomer } from '../supabase/sync';
import { assertWritable } from '../supabase/licenseCheck';
import { requirePermission } from '../permissions';

// Refund policy (spec v3, Phase 7). Gift-shop (non-age-restricted) items are
// returnable within this window; tobacco/vapor (age_restricted) and
// discounted/promotional sales are never refundable. Manager-approval for refunds
// is now enforced via the permission engine (process_refund).
const REFUND_WINDOW_DAYS = 7;

/** True if a cart line's unit price differs from the catalog price (a price override). */
function isPriceOverride(db: ReturnType<typeof getDb>, item: TransactionItem): boolean {
  let catalog: number | null = null;
  if (item.variant_id) {
    const v = db.prepare('SELECT price FROM product_variants WHERE id = ?').get(item.variant_id) as { price: number } | undefined;
    catalog = v ? v.price : null;
  } else if (item.product_id) {
    const p = db.prepare('SELECT price FROM products WHERE id = ?').get(item.product_id) as { price: number } | undefined;
    catalog = p ? p.price : null;
  }
  return catalog != null && Math.abs((item.unit_price || 0) - catalog) > 0.005;
}

interface TransactionItem {
  product_id: number | null;
  variant_id?: number;
  qty: number;
  unit_price: number;
  line_total: number;
  description?: string;   // MISC / open-price line label
  category?: string;      // MISC line department (for "by department" reports)
}

interface CreateTransactionData {
  customer_id?: number;
  items: TransactionItem[];
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  discount_amount: number;
  manual_discount?: number;    // cashier-entered discount (permission-gated)
  discount_override?: string;  // legacy alias for `override`
  override?: string;           // manager PIN authorizing any gated action this sale
  total: number;
  payment_method: 'cash' | 'card' | 'split';
  cash_tendered?: number;
  change_given?: number;
  auth_code?: string;
  last4?: string;
  terminal_ref?: string;
  tip_amount?: number;
  signature_data?: string;
  card_type?: string;
  points_redeemed?: number;
  promo_code?: string;
  age_check?: {
    customer_name?: string; dob?: string; age_at_sale?: number;
    min_age?: number; result?: string; method?: string;
  };
}

function loyaltyTier(lifetime: number, gold: boolean): string {
  if (gold || lifetime >= 1500) return 'Gold';
  if (lifetime >= 500) return 'Silver';
  return 'Member';
}

export function registerTransactionHandlers(): void {
  ipcMain.handle('transactions:getAll', async (_event, filters?: {
    customer_name?: string; start_date?: string; end_date?: string;
    page?: number; per_page?: number; source?: 'online' | 'in_store';
  }) => {
    try {
      const db = getDb();
      const page = filters?.page || 1;
      const perPage = filters?.per_page || 10;
      const offset = (page - 1) * perPage;

      let sql = `
        SELECT t.*,
          c.first_name || ' ' || c.last_name AS customer_name,
          u.username AS cashier_name
        FROM transactions t
        LEFT JOIN customers c ON t.customer_id = c.id
        LEFT JOIN users u ON t.cashier_id = u.id
        WHERE 1=1
      `;
      const params: (string | number)[] = [];

      if (filters?.customer_name) {
        sql += ` AND (c.first_name || ' ' || c.last_name) LIKE ?`;
        params.push(`%${filters.customer_name}%`);
      }
      if (filters?.start_date) {
        sql += ' AND substr(t.created_at, 1, 10) >= ?';
        params.push(filters.start_date);
      }
      if (filters?.end_date) {
        sql += ' AND substr(t.created_at, 1, 10) <= ?';
        params.push(filters.end_date);
      }
      // Online — Prepaid filter (the "Online Orders" view in Receipts).
      if (filters?.source === 'online') sql += " AND t.order_source = 'online'";
      else if (filters?.source === 'in_store') sql += " AND COALESCE(t.order_source, 'in_store') <> 'online'";

      const countSql = sql.replace(/SELECT t\.\*.*?FROM/s, 'SELECT COUNT(*) as cnt FROM');
      const countResult = db.prepare(countSql).get(...params) as { cnt: number };

      sql += ' ORDER BY t.created_at DESC LIMIT ? OFFSET ?';
      params.push(perPage, offset);

      const transactions = db.prepare(sql).all(...params);
      return { success: true, transactions, total: countResult.cnt, page, perPage };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('transactions:getOne', async (_event, id: number) => {
    try {
      const db = getDb();
      const transaction = db.prepare(`
        SELECT t.*,
          c.first_name || ' ' || c.last_name AS customer_name,
          u.username AS cashier_name
        FROM transactions t
        LEFT JOIN customers c ON t.customer_id = c.id
        LEFT JOIN users u ON t.cashier_id = u.id
        WHERE t.id = ?
      `).get(id);

      if (!transaction) return { success: false, error: 'Transaction not found' };

      const items = db.prepare(`
        SELECT ti.*, COALESCE(p.name || ' - ' || v.label, p.name, ti.description, ti.category, 'Item') AS product_name
        FROM transaction_items ti
        LEFT JOIN products p ON ti.product_id = p.id
        LEFT JOIN product_variants v ON ti.variant_id = v.id
        WHERE ti.transaction_id = ?
      `).all(id);

      return { success: true, transaction, items };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('transactions:create', async (_event, data: CreateTransactionData) => {
    try {
      const w = assertWritable('sale'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const session = getCurrentSession();

      // Data-layer gates (not bypassable from the UI). A single manager PIN this
      // sale authorizes whichever gate trips.
      const overridePin = data.override ?? data.discount_override;
      // Manual cashier discount beyond the employee's grant/cap (loyalty/promo/rebate excluded).
      const manualDisc = Number(data.manual_discount) || 0;
      if (manualDisc > 0) {
        const pct = data.subtotal > 0 ? (manualDisc / data.subtotal) * 100 : 0;
        const perm = requirePermission('apply_discount', { override: overridePin, action: 'apply_discount', requestedValue: pct }, db);
        if (!perm.ok) return { success: false, error: perm.error, needsOverride: perm.needsOverride };
      }
      // Any product line priced off catalog = a price override.
      if (data.items.some((it) => it.product_id && isPriceOverride(db, it))) {
        const perm = requirePermission('override_price', { override: overridePin, action: 'override_price' }, db);
        if (!perm.ok) return { success: false, error: perm.error, needsOverride: perm.needsOverride };
      }

      const txn = db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO transactions
            (cashier_id, customer_id, subtotal, tax_rate, tax_amount, discount_amount, total,
             payment_method, payment_status, cash_tendered, change_given, auth_code, last4,
             terminal_ref, tip_amount, signature_data, card_type, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          session?.userId || null,
          data.customer_id || null,
          data.subtotal,
          data.tax_rate,
          data.tax_amount,
          data.discount_amount,
          data.total,
          data.payment_method,
          data.cash_tendered || null,
          data.change_given || null,
          data.auth_code || null,
          data.last4 || null,
          data.terminal_ref || null,
          data.tip_amount || 0,
          data.signature_data || null,
          data.card_type || null,
          nowCT()
        );

        const txnId = result.lastInsertRowid as number;

        const itemIds: number[] = [];
        const affectedProductIds = new Set<number>();
        for (const item of data.items) {
          const itemRes = db.prepare(`
            INSERT INTO transaction_items (transaction_id, product_id, variant_id, qty, unit_price, line_total, description, category)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(txnId, item.product_id || null, item.variant_id || null, item.qty, item.unit_price, item.line_total, item.description || null, item.category || null);
          itemIds.push(itemRes.lastInsertRowid as number);

          // Deduct inventory — from the variant if this line is a variant, else the
          // product. MISC/open-price lines have no product_id, so nothing to deduct.
          if (item.variant_id) {
            db.prepare(`UPDATE product_variants SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ?`)
              .run(item.qty, item.variant_id);
          } else if (item.product_id) {
            db.prepare(`UPDATE products SET stock_qty = MAX(0, stock_qty - ?), updated_at = ? WHERE id = ?`)
              .run(item.qty, nowCT(), item.product_id);
            affectedProductIds.add(item.product_id);
            // Phase 2: record the -qty as a shared stock movement so location peers converge.
            enqueueStockMovement(item.product_id, -item.qty, 'sale', db);
          }
        }

        // Update shift totals — auto-create a shift if none is open
        let openShift = db.prepare(
          `SELECT id FROM shift_totals WHERE cashier_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`
        ).get(session?.userId || 0) as { id: number } | undefined;

        if (!openShift && session?.userId) {
          const float = parseFloat(
            (db.prepare("SELECT value FROM settings WHERE key = 'cash_float'").get() as { value: string } | undefined)?.value || '200'
          ) || 200;
          const newShiftResult = db.prepare(
            `INSERT INTO shift_totals (cashier_id, opened_at, starting_cash) VALUES (?, ?, ?)`
          ).run(session.userId, nowCT(), float);
          openShift = { id: newShiftResult.lastInsertRowid as number };
        }

        if (openShift) {
          const cashDelta = data.payment_method === 'cash' ? data.total : 0;
          const cardDelta = data.payment_method === 'card' ? data.total : 0;
          db.prepare(`
            UPDATE shift_totals
            SET cash_total = cash_total + ?, card_total = card_total + ?,
                sale_count = sale_count + 1, tax_total = tax_total + ?
            WHERE id = ?
          `).run(cashDelta, cardDelta, data.tax_amount, openShift.id);
        }

        // ---- Promo code redemption ----
        if (data.promo_code) {
          db.prepare(
            `UPDATE promo_codes SET used = 1, redeemed_at = ?, redeemed_txn_id = ? WHERE code = ? AND used = 0`
          ).run(nowCT(), txnId, data.promo_code.trim().toUpperCase());
        }

        // ---- Age verification audit log ----
        if (data.age_check) {
          const a = data.age_check;
          db.prepare(`
            INSERT INTO age_checks
              (transaction_id, customer_id, cashier_id, cashier_name, customer_name,
               dob, age_at_sale, min_age, result, method)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            txnId, data.customer_id || null, session?.userId || null, session?.username || null,
            a.customer_name || null, a.dob || null, a.age_at_sale ?? null,
            a.min_age ?? null, a.result || null, a.method || null
          );
        }

        // ---- Loyalty points ----
        let loyalty: { earned: number; redeemed: number; balance: number; tier: string; bonus_2x: boolean } | null = null;
        if (data.customer_id) {
          const cust = db.prepare('SELECT loyalty_points, lifetime_points, gold_member FROM customers WHERE id = ?')
            .get(data.customer_id) as { loyalty_points: number; lifetime_points: number; gold_member: number } | undefined;
          if (cust) {
            let balance = cust.loyalty_points || 0;
            let lifetime = cust.lifetime_points || 0;
            const redeemed = Math.max(0, Math.min(data.points_redeemed || 0, balance));

            // Earn: 1 pt/$1, +10% Silver/Gold, 2x on Tuesdays
            const isTuesday = DateTime.now().setZone(TZ).weekday === 2;
            const tierMult = lifetime >= 500 || cust.gold_member ? 1.1 : 1.0;
            const dayMult = isTuesday ? 2 : 1;
            const earned = data.total > 0
              ? Math.floor(Math.floor(data.total) * tierMult * dayMult)
              : 0;

            if (redeemed > 0) {
              balance -= redeemed;
              db.prepare(`INSERT INTO loyalty_ledger (customer_id, transaction_id, change, reason, balance_after)
                          VALUES (?, ?, ?, 'redeem', ?)`).run(data.customer_id, txnId, -redeemed, balance);
            }
            if (earned > 0) {
              balance += earned;
              lifetime += earned;
              db.prepare(`INSERT INTO loyalty_ledger (customer_id, transaction_id, change, reason, balance_after)
                          VALUES (?, ?, ?, ?, ?)`).run(data.customer_id, txnId, earned, isTuesday ? 'earn_2x' : 'earn', balance);
            }

            // Permanent Gold: once earned, never removed
            const gold = cust.gold_member ? 1 : (lifetime >= 1500 ? 1 : 0);
            db.prepare(`UPDATE customers SET loyalty_points = ?, lifetime_points = ?, gold_member = ?, updated_at = ? WHERE id = ?`)
              .run(balance, lifetime, gold, nowCT(), data.customer_id);
            // Phase 3: propagate the loyalty change to the shared per-location book.
            enqueueCustomer('update', data.customer_id, db);

            loyalty = { earned, redeemed, balance, tier: loyaltyTier(lifetime, !!gold), bonus_2x: isTuesday && earned > 0 };
          }
        }

        // Cloud sync (D.1): enqueue the completed sale + its line items. Atomic
        // with the writes above (same transaction); no-op if Supabase is off.
        enqueueLocalRow('transactions', 'insert', txnId, db);
        for (const itemId of itemIds) enqueueLocalRow('transaction_items', 'insert', itemId, db);
        // Path 4: push updated stock levels for sold products to inventory_cloud.
        for (const pid of affectedProductIds) enqueueInventorySnapshot(pid, 'sale', db);

        return { txnId, loyalty };
      });

      const { txnId, loyalty } = txn();

      // Record the cash sale in the drawer activity log (the physical pop happens
      // the moment the cashier presses Cash — see openCashModal in the POS).
      if (data.payment_method === 'cash' || data.payment_method === 'split') {
        try {
          db.prepare(`INSERT INTO drawer_log (cashier_id, cashier_name, event, amount, note) VALUES (?, ?, ?, ?, ?)`)
            .run(session?.userId || null, session?.username || null, 'cash_sale',
                 data.cash_tendered || data.total, `Txn #${txnId}`);
        } catch { /* non-fatal */ }
      }

      return { success: true, id: txnId, loyalty };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('transactions:delete', async (_event, id: number) => {
    try {
      const w = assertWritable('void'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const session = getCurrentSession();
      if (session?.role !== 'manager') {
        return { success: false, error: 'Manager access required' };
      }

      db.transaction(() => {
        const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as {
          cashier_id: number; total: number; tax_amount: number;
          payment_method: string;
        } | undefined;
        if (!txn) throw new Error('Transaction not found');

        const items = db.prepare(
          'SELECT product_id, qty FROM transaction_items WHERE transaction_id = ?'
        ).all(id) as { product_id: number | null; qty: number }[];

        // Restore inventory
        for (const item of items) {
          if (item.product_id != null) {
            db.prepare('UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE id = ?')
              .run(item.qty, nowCT(), item.product_id);
            // Phase 2: record the +qty restock as a shared stock movement.
            enqueueStockMovement(item.product_id, item.qty, 'return', db);
          }
        }

        // Reverse shift totals for the cashier who made the sale
        const shift = db.prepare(
          `SELECT id FROM shift_totals WHERE cashier_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`
        ).get(txn.cashier_id) as { id: number } | undefined;

        if (shift) {
          const cashDelta = txn.payment_method === 'cash' ? txn.total : 0;
          const cardDelta = txn.payment_method === 'card' ? txn.total : 0;
          db.prepare(`
            UPDATE shift_totals
            SET cash_total = MAX(0, cash_total - ?),
                card_total = MAX(0, card_total - ?),
                sale_count = MAX(0, sale_count - 1),
                tax_total  = MAX(0, tax_total - ?)
            WHERE id = ?
          `).run(cashDelta, cardDelta, txn.tax_amount, shift.id);
        }

        db.prepare('DELETE FROM transaction_items WHERE transaction_id = ?').run(id);
        db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
      })();

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Refund lookup (Phase 7): manager code + receipt number -> the original
  // sale, its customer/discount, and each line's refund eligibility. ──────────
  ipcMain.handle('transactions:lookupReceipt', async (_event, receiptNo: string, managerPin: string) => {
    try {
      const db = getDb();
      const perm = requirePermission('process_refund', { override: managerPin, action: 'refund_lookup' }, db);
      if (!perm.ok) return { success: false, error: perm.error, needsOverride: perm.needsOverride };

      const id = parseInt(String(receiptNo ?? '').replace(/[^0-9]/g, ''), 10);
      if (!id) return { success: false, error: 'Enter a valid receipt number' };

      const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
      if (!txn) return { success: false, error: `Receipt #${id} not found` };
      if ((txn.total as number) < 0 || txn.original_txn_id) return { success: false, error: 'That receipt is itself a refund, not a sale' };

      const customer = txn.customer_id
        ? db.prepare('SELECT id, first_name, last_name, phone FROM customers WHERE id = ?').get(txn.customer_id)
        : null;

      const discounted = ((txn.discount_amount as number) || 0) > 0;
      const withinWindow = (Date.now() - new Date(txn.created_at as string).getTime()) <= REFUND_WINDOW_DAYS * 86400000;

      const lines = db.prepare(`
        SELECT ti.id, ti.product_id, ti.qty, ti.unit_price,
               COALESCE(p.name || CASE WHEN v.label IS NOT NULL THEN ' - ' || v.label ELSE '' END, ti.description, 'Item') AS name,
               COALESCE(p.age_restricted, 0) AS age_restricted, p.category
        FROM transaction_items ti
        LEFT JOIN products p ON ti.product_id = p.id
        LEFT JOIN product_variants v ON ti.variant_id = v.id
        WHERE ti.transaction_id = ? AND ti.qty > 0
      `).all(id) as { id: number; product_id: number | null; qty: number; unit_price: number; name: string; age_restricted: number; category: string | null }[];

      // How much of each product was already refunded against this receipt.
      const refunded = db.prepare(`
        SELECT ri.product_id, COALESCE(SUM(ABS(ri.qty)), 0) AS qty
        FROM transaction_items ri JOIN transactions rt ON ri.transaction_id = rt.id
        WHERE rt.original_txn_id = ? GROUP BY ri.product_id
      `).all(id) as { product_id: number; qty: number }[];
      const refundedOf: Record<number, number> = {};
      for (const r of refunded) refundedOf[r.product_id] = r.qty;

      const items = lines.map((l) => {
        const already = l.product_id != null ? (refundedOf[l.product_id] || 0) : 0;
        const remaining = Math.max(0, l.qty - already);
        let refundable = true, reason = 'Returnable within 7 days';
        if (discounted) { refundable = false; reason = 'Discounted/promotional — final sale'; }
        else if (l.age_restricted) { refundable = false; reason = 'Tobacco/vapor — non-refundable'; }
        else if (!withinWindow) { refundable = false; reason = 'Past 7-day return window'; }
        else if (remaining <= 0) { refundable = false; reason = 'Already refunded'; }
        return {
          transaction_item_id: l.id, product_id: l.product_id, name: l.name, qty: l.qty,
          unit_price: l.unit_price, already_refunded: already, refundable_qty: refundable ? remaining : 0,
          refundable, reason,
        };
      });

      return {
        success: true,
        receipt: {
          id, created_at: txn.created_at, discount_amount: (txn.discount_amount as number) || 0,
          tax_rate: (txn.tax_rate as number) || 0,
          payment_method: txn.payment_method, customer, within_window: withinWindow,
          window_days: REFUND_WINDOW_DAYS, items,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── Process a line-level refund (Phase 7). Re-validates policy server-side,
  // writes a negative transaction linked to the original, restocks, reverses the
  // shift, and syncs. ─────────────────────────────────────────────────────────
  ipcMain.handle('transactions:refundItems', async (_event, payload: {
    original_txn_id: number; manager_pin: string; items: { product_id: number; qty: number }[];
  }) => {
    try {
      const w = assertWritable('return'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const session = getCurrentSession();
      const origId = parseInt(String(payload?.original_txn_id), 10);
      const perm = requirePermission('process_refund', { override: payload?.manager_pin, action: 'refund', transactionId: origId }, db);
      if (!perm.ok) return { success: false, error: perm.error, needsOverride: perm.needsOverride };

      const orig = db.prepare('SELECT * FROM transactions WHERE id = ?').get(origId) as Record<string, unknown> | undefined;
      if (!orig) return { success: false, error: 'Original sale not found' };
      if (((orig.discount_amount as number) || 0) > 0) return { success: false, error: 'Discounted/promotional sale — items are final sale' };
      const withinWindow = (Date.now() - new Date(orig.created_at as string).getTime()) <= REFUND_WINDOW_DAYS * 86400000;
      if (!withinWindow) return { success: false, error: 'Past the 7-day return window' };

      const out = db.transaction(() => {
        const refunded = db.prepare(`
          SELECT ri.product_id, COALESCE(SUM(ABS(ri.qty)), 0) AS qty
          FROM transaction_items ri JOIN transactions rt ON ri.transaction_id = rt.id
          WHERE rt.original_txn_id = ? GROUP BY ri.product_id
        `).all(origId) as { product_id: number; qty: number }[];
        const refundedOf: Record<number, number> = {};
        for (const r of refunded) refundedOf[r.product_id] = r.qty;

        const validated: { product_id: number; variant_id: number | null; qty: number; unit_price: number; description: string; category: string | null }[] = [];
        let subtotal = 0;
        for (const req of payload?.items || []) {
          const line = db.prepare(`
            SELECT ti.*, COALESCE(p.age_restricted, 0) AS age_restricted,
                   COALESCE(p.name, ti.description, 'Item') AS name
            FROM transaction_items ti LEFT JOIN products p ON ti.product_id = p.id
            WHERE ti.transaction_id = ? AND ti.product_id = ? AND ti.qty > 0 LIMIT 1
          `).get(origId, req.product_id) as { variant_id: number | null; qty: number; unit_price: number; age_restricted: number; name: string; category: string | null } | undefined;
          if (!line) throw new Error('An item is not on the original receipt');
          if (line.age_restricted) throw new Error(`${line.name} is tobacco/vapor — non-refundable`);
          const remaining = Math.max(0, line.qty - (refundedOf[req.product_id] || 0));
          const qty = Math.min(Math.max(1, parseInt(String(req.qty), 10) || 0), remaining);
          if (qty <= 0) throw new Error(`${line.name} is already fully refunded`);
          subtotal += line.unit_price * qty;
          validated.push({ product_id: req.product_id, variant_id: line.variant_id, qty, unit_price: line.unit_price, description: line.name, category: line.category });
        }
        if (!validated.length) throw new Error('No refundable items selected');

        const taxRate = (orig.tax_rate as number) || 0;
        const tax = +(subtotal * taxRate).toFixed(2);
        const total = -+(subtotal + tax).toFixed(2);

        const res = db.prepare(`
          INSERT INTO transactions (cashier_id, customer_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, original_txn_id, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'completed', ?, ?)
        `).run(session?.userId || orig.cashier_id, orig.customer_id ?? null, -subtotal, taxRate, -tax, total, orig.payment_method, origId, nowCT());
        const refundId = res.lastInsertRowid as number;

        const itemIds: number[] = [];
        for (const v of validated) {
          const ir = db.prepare(`
            INSERT INTO transaction_items (transaction_id, product_id, variant_id, qty, unit_price, line_total, description, category)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(refundId, v.product_id, v.variant_id, -v.qty, v.unit_price, -(v.unit_price * v.qty), v.description, v.category);
          itemIds.push(ir.lastInsertRowid as number);
          db.prepare('UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE id = ?').run(v.qty, nowCT(), v.product_id);
          enqueueStockMovement(v.product_id, v.qty, 'return', db);
        }

        const shift = db.prepare(`SELECT id FROM shift_totals WHERE cashier_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`)
          .get(session?.userId || orig.cashier_id) as { id: number } | undefined;
        if (shift) {
          const cashDelta = orig.payment_method === 'cash' ? subtotal + tax : 0;
          const cardDelta = orig.payment_method === 'card' ? subtotal + tax : 0;
          db.prepare(`UPDATE shift_totals SET cash_total = MAX(0, cash_total - ?), card_total = MAX(0, card_total - ?), tax_total = MAX(0, tax_total - ?) WHERE id = ?`)
            .run(cashDelta, cardDelta, tax, shift.id);
        }

        enqueueLocalRow('transactions', 'insert', refundId, db);
        for (const iid of itemIds) enqueueLocalRow('transaction_items', 'insert', iid, db);

        return { refundId, subtotal, tax, total };
      })();

      return { success: true, ...out };
    } catch (err) {
      return { success: false, error: String((err as Error)?.message || err) };
    }
  });

  ipcMain.handle('transactions:todayOverview', async () => {
    try {
      const db = getDb();
      const today = todayCT();

      const summary = db.prepare(`
        SELECT
          COALESCE(SUM(total), 0) AS revenue,
          COALESCE(SUM(total - tax_amount - discount_amount), 0) AS gross_revenue,
          COUNT(*) AS sale_count
        FROM transactions
        WHERE substr(created_at, 1, 10) = ? AND payment_status = 'completed'
      `).get(today) as { revenue: number; gross_revenue: number; sale_count: number };

      // Profit = revenue - cost of goods sold
      const cogResult = db.prepare(`
        SELECT COALESCE(SUM(ti.qty * p.cost), 0) AS cogs
        FROM transaction_items ti
        JOIN products p ON ti.product_id = p.id
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE substr(t.created_at, 1, 10) = ? AND t.payment_status = 'completed'
      `).get(today) as { cogs: number };

      const profit = summary.revenue - cogResult.cogs;

      const topItem = db.prepare(`
        SELECT p.name, SUM(ti.qty) AS units_sold
        FROM transaction_items ti
        JOIN products p ON ti.product_id = p.id
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE substr(t.created_at, 1, 10) = ? AND t.payment_status = 'completed'
        GROUP BY ti.product_id
        ORDER BY units_sold DESC
        LIMIT 1
      `).get(today) as { name: string; units_sold: number } | undefined;

      const lowStock = db.prepare(`
        SELECT name, stock_qty, low_stock_threshold
        FROM products
        WHERE stock_qty <= low_stock_threshold AND low_stock_alert = 1
        ORDER BY stock_qty ASC
        LIMIT 5
      `).all() as { name: string; stock_qty: number; low_stock_threshold: number }[];

      return {
        success: true,
        overview: {
          revenue: summary.revenue,
          profit,
          sale_count: summary.sale_count,
          top_item: topItem || null,
          low_stock: lowStock,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
