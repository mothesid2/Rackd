import { ipcMain } from 'electron';
import { DateTime } from 'luxon';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { nowCT, todayCT, getBusinessTZ, businessDayStart, businessDayBounds, scheduledBusinessDayStart } from '../utils/time';
import { enqueueLocalRow, enqueueInventorySnapshot, enqueueStockMovement, enqueueCustomer, enqueueSync, getLocationId, getTenantId, getRegisterId } from '../supabase/sync';
import { getSupabase, isSupabaseConfigured } from '../supabase/client';
import { assertWritable } from '../supabase/licenseCheck';
import { requirePermission } from '../permissions';
import { findCurrentOpenShift, getOrOpenCurrentShift, currentCashFloat } from '../shiftTotals';


const REFUND_WINDOW_DAYS = 7;


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
  description?: string;   
  category?: string;      
}

interface CreateTransactionData {
  customer_id?: number;
  items: TransactionItem[];
  subtotal: number;
  tax_rate: number;
  tax_amount: number;
  discount_amount: number;
  manual_discount?: number;    
  discount_override?: string;  
  override?: string;           
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
  original_txn_id?: number; 
  age_check?: {
    customer_name?: string; dob?: string; age_at_sale?: number;
    min_age?: number; result?: string; method?: string;
  };
}



function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function computeRefundTax(
  subtotal: number,
  origSubtotal: number,
  origTaxAmount: number,
  taxRate: number
): { tax: number; total: number } {
  
  
  
  
  
  
  
  
  const tax = origSubtotal > 0 ? origTaxAmount * (subtotal / origSubtotal) : round2(subtotal * taxRate);
  const total = -(subtotal + tax);
  return { tax, total };
}

function loyaltyTier(lifetime: number, gold: boolean): string {
  if (gold || lifetime >= 1500) return 'Gold';
  if (lifetime >= 500) return 'Silver';
  return 'Member';
}


export function deleteTransactionReversed(db: ReturnType<typeof getDb>, id: number): { success: boolean; error?: string } {
  try {
    db.transaction(() => {
      const txn = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id) as {
        cashier_id: number; total: number; tax_amount: number;
        payment_method: string;
      } | undefined;
      if (!txn) throw new Error('Transaction not found');

      const items = db.prepare(
        'SELECT id, product_id, qty FROM transaction_items WHERE transaction_id = ?'
      ).all(id) as { id: number; product_id: number | null; qty: number }[];

      
      for (const item of items) {
        if (item.product_id != null) {
          db.prepare('UPDATE products SET stock_qty = stock_qty + ?, updated_at = ? WHERE id = ?')
            .run(item.qty, nowCT(), item.product_id);
          
          enqueueStockMovement(item.product_id, item.qty, 'return', db);
        }
      }

      
      
      
      
      
      
      
      
      if (isSupabaseConfigured()) {
        const tenantId = getTenantId(db);
        const registerId = getRegisterId(db);
        for (const item of items) {
          enqueueSync('transaction_items', item.id, 'delete', { id: item.id, tenant_id: tenantId, register_id: registerId }, db);
        }
        enqueueSync('transactions', id, 'delete', { id, tenant_id: tenantId, register_id: registerId }, db);
      }

      
      
      
      
      const shift = findCurrentOpenShift(txn.cashier_id, db);

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

      
      
      
      
      
      const ledgerRows = db.prepare(
        `SELECT customer_id, change, reason FROM loyalty_ledger WHERE transaction_id = ?`
      ).all(id) as { customer_id: number; change: number; reason: string }[];
      const byCustomer = new Map<number, { balanceDelta: number; lifetimeDelta: number }>();
      for (const r of ledgerRows) {
        const cur = byCustomer.get(r.customer_id) || { balanceDelta: 0, lifetimeDelta: 0 };
        cur.balanceDelta += r.change;
        if (r.reason === 'earn' || r.reason === 'earn_2x') cur.lifetimeDelta += r.change; 
        byCustomer.set(r.customer_id, cur);
      }
      for (const [customerId, delta] of byCustomer) {
        db.prepare(
          `UPDATE customers SET loyalty_points = MAX(0, loyalty_points - ?), lifetime_points = MAX(0, lifetime_points - ?), updated_at = ? WHERE id = ?`
        ).run(delta.balanceDelta, delta.lifetimeDelta, nowCT(), customerId);
        
        
        enqueueCustomer('update', customerId, db);
      }
      db.prepare('DELETE FROM loyalty_ledger WHERE transaction_id = ?').run(id);

      
      
      
      
      db.prepare('UPDATE age_checks SET transaction_id = NULL WHERE transaction_id = ?').run(id);

      db.prepare('DELETE FROM transaction_items WHERE transaction_id = ?').run(id);
      db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
    })();

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export function registerTransactionHandlers(): void {
  ipcMain.handle('transactions:getAll', async (_event, filters?: {
    customer_name?: string; start_date?: string; end_date?: string;
    start_ts?: string; end_ts?: string;
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
      
      
      
      
      
      
      
      
      
      if (filters?.start_ts) {
        sql += ' AND t.created_at >= ?';
        params.push(filters.start_ts);
      } else if (filters?.start_date) {
        sql += ' AND t.created_at >= ?';
        params.push(businessDayBounds(filters.start_date, db).start);
      }
      if (filters?.end_ts) {
        sql += ' AND t.created_at < ?';
        params.push(filters.end_ts);
      } else if (filters?.end_date) {
        sql += ' AND t.created_at < ?';
        params.push(businessDayBounds(filters.end_date, db).end);
      }
      
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

  
  
  
  
  
  
  
  
  
  
  
  
  ipcMain.handle('transactions:getAllLocation', async (_event, filters?: {
    start_date?: string; end_date?: string; start_ts?: string; end_ts?: string;
    page?: number; per_page?: number; source?: 'online' | 'in_store';
  }) => {
    try {
      const locationId = getLocationId();
      if (!locationId) return { success: false, error: 'This register is not assigned to a location yet.' };
      const supabase = getSupabase();
      if (!supabase) return { success: false, error: 'Cloud not configured — location-wide receipts need internet.' };

      const page = filters?.page || 1;
      const perPage = filters?.per_page || 10;
      const from = (page - 1) * perPage;
      const to = from + perPage - 1;

      let q = supabase.from('transactions_cloud').select('*', { count: 'exact' }).eq('location_id', locationId);
      
      
      
      const dbForBounds = getDb();
      if (filters?.start_ts) q = q.gte('created_at', filters.start_ts);
      else if (filters?.start_date) q = q.gte('created_at', businessDayBounds(filters.start_date, dbForBounds).start);
      if (filters?.end_ts) q = q.lt('created_at', filters.end_ts);
      else if (filters?.end_date) q = q.lt('created_at', businessDayBounds(filters.end_date, dbForBounds).end);
      if (filters?.source === 'online') q = q.eq('order_source', 'online');
      else if (filters?.source === 'in_store') q = q.neq('order_source', 'online');
      q = q.order('created_at', { ascending: false }).range(from, to);

      const { data, error, count } = await q;
      if (error) return { success: false, error: error.message };

      const transactions = (data || []).map((t: Record<string, unknown>) => ({
        ...t,
        customer_name: null,
        cashier_name: `Register ${String(t.register_id || '').slice(0, 8)}`,
      }));
      return { success: true, transactions, total: count || 0, page, perPage };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('transactions:getOneLocation', async (_event, id: number, registerId: string) => {
    try {
      const supabase = getSupabase();
      if (!supabase) return { success: false, error: 'Cloud not configured.' };
      const { data: transaction, error: tErr } = await supabase
        .from('transactions_cloud').select('*').eq('id', id).eq('register_id', registerId).maybeSingle();
      if (tErr) return { success: false, error: tErr.message };
      if (!transaction) return { success: false, error: 'Transaction not found' };

      const { data: items, error: iErr } = await supabase
        .from('transaction_items_cloud').select('*').eq('transaction_id', id).eq('register_id', registerId);
      if (iErr) return { success: false, error: iErr.message };

      
      
      
      
      
      
      
      
      const productIds = [...new Set((items || []).map((i) => i.product_id).filter((v) => v != null))] as number[];
      const nameById = new Map<number, string>();
      if (productIds.length) {
        const tenantId = getTenantId(getDb());
        const { data: products } = await supabase
          .from('inventory_cloud').select('id, name')
          .eq('tenant_id', tenantId).eq('register_id', registerId).in('id', productIds);
        for (const p of products || []) nameById.set(p.id as number, p.name as string);
      }

      return {
        success: true,
        transaction: { ...transaction, customer_name: null, cashier_name: `Register ${String(registerId).slice(0, 8)}` },
        items: (items || []).map((i: Record<string, unknown>) => ({
          ...i,
          product_name: (i.product_id != null && nameById.get(i.product_id as number)) || i.description || i.category || 'Item',
        })),
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('transactions:create', async (_event, data: CreateTransactionData) => {
    try {
      const w = assertWritable('sale'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const session = getCurrentSession();

      
      
      const overridePin = data.override ?? data.discount_override;
      
      const manualDisc = Number(data.manual_discount) || 0;
      if (manualDisc > 0) {
        const pct = data.subtotal > 0 ? (manualDisc / data.subtotal) * 100 : 0;
        const perm = requirePermission('apply_discount', { override: overridePin, action: 'apply_discount', requestedValue: pct }, db);
        if (!perm.ok) return { success: false, error: perm.error, needsOverride: perm.needsOverride };
      }
      
      if (data.items.some((it) => it.product_id && isPriceOverride(db, it))) {
        const perm = requirePermission('override_price', { override: overridePin, action: 'override_price' }, db);
        if (!perm.ok) return { success: false, error: perm.error, needsOverride: perm.needsOverride };
      }

      const txn = db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO transactions
            (cashier_id, customer_id, subtotal, tax_rate, tax_amount, discount_amount, total,
             payment_method, payment_status, cash_tendered, change_given, auth_code, last4,
             terminal_ref, tip_amount, signature_data, card_type, original_txn_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          
          
          
          
          data.original_txn_id || null,
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

          
          
          
          
          
          if (item.variant_id) {
            db.prepare(`UPDATE product_variants SET stock_qty = MAX(0, stock_qty - ?) WHERE id = ?`)
              .run(item.qty, item.variant_id);
          } else if (item.product_id) {
            db.prepare(`UPDATE products SET stock_qty = MAX(0, stock_qty - ?), updated_at = ? WHERE id = ?`)
              .run(item.qty, nowCT(), item.product_id);
            affectedProductIds.add(item.product_id);
            
            
            
            
            enqueueStockMovement(item.product_id, -item.qty, item.qty < 0 ? 'return' : 'sale', db);
          }
        }

        
        
        
        
        
        
        if (session?.userId) {
          const shiftId = getOrOpenCurrentShift(session.userId, db, currentCashFloat(db));
          const cashDelta = data.payment_method === 'cash' ? data.total : 0;
          const cardDelta = data.payment_method === 'card' ? data.total : 0;
          db.prepare(`
            UPDATE shift_totals
            SET cash_total = cash_total + ?, card_total = card_total + ?,
                sale_count = sale_count + 1, tax_total = tax_total + ?
            WHERE id = ?
          `).run(cashDelta, cardDelta, data.tax_amount, shiftId);
        }

        
        if (data.promo_code) {
          db.prepare(
            `UPDATE promo_codes SET used = 1, redeemed_at = ?, redeemed_txn_id = ? WHERE code = ? AND used = 0`
          ).run(nowCT(), txnId, data.promo_code.trim().toUpperCase());
        }

        
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

        
        let loyalty: { earned: number; redeemed: number; balance: number; tier: string; bonus_2x: boolean } | null = null;
        if (data.customer_id) {
          const cust = db.prepare('SELECT loyalty_points, lifetime_points, gold_member FROM customers WHERE id = ?')
            .get(data.customer_id) as { loyalty_points: number; lifetime_points: number; gold_member: number } | undefined;
          if (cust) {
            let balance = cust.loyalty_points || 0;
            let lifetime = cust.lifetime_points || 0;
            const redeemed = Math.max(0, Math.min(data.points_redeemed || 0, balance));

            
            const isTuesday = DateTime.now().setZone(getBusinessTZ()).weekday === 2;
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

            
            const gold = cust.gold_member ? 1 : (lifetime >= 1500 ? 1 : 0);
            db.prepare(`UPDATE customers SET loyalty_points = ?, lifetime_points = ?, gold_member = ?, updated_at = ? WHERE id = ?`)
              .run(balance, lifetime, gold, nowCT(), data.customer_id);
            
            enqueueCustomer('update', data.customer_id, db);

            loyalty = { earned, redeemed, balance, tier: loyaltyTier(lifetime, !!gold), bonus_2x: isTuesday && earned > 0 };
          }
        }

        
        
        enqueueLocalRow('transactions', 'insert', txnId, db);
        for (const itemId of itemIds) enqueueLocalRow('transaction_items', 'insert', itemId, db);
        
        for (const pid of affectedProductIds) enqueueInventorySnapshot(pid, 'sale', db);

        return { txnId, loyalty };
      });

      const { txnId, loyalty } = txn();

      
      
      if (data.payment_method === 'cash' || data.payment_method === 'split') {
        try {
          db.prepare(`INSERT INTO drawer_log (cashier_id, cashier_name, event, amount, note) VALUES (?, ?, ?, ?, ?)`)
            .run(session?.userId || null, session?.username || null, 'cash_sale',
                 data.cash_tendered || data.total, `Txn #${txnId}`);
        } catch {  }
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
      return deleteTransactionReversed(db, id);
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
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
          
          
          
          
          orig_subtotal: (txn.subtotal as number) || 0, orig_tax_amount: (txn.tax_amount as number) || 0,
          payment_method: txn.payment_method, customer, within_window: withinWindow,
          window_days: REFUND_WINDOW_DAYS, items,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  
  ipcMain.handle('transactions:refundItems', async (_event, payload: {
    original_txn_id: number; manager_pin: string; items: { product_id: number; qty: number }[];
    
    
    
    
    
    
    auth_code?: string; last4?: string; card_type?: string; terminal_ref?: string; signature_data?: string;
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
        subtotal = round2(subtotal);

        
        
        
        
        
        
        if (orig.payment_method === 'card' && !payload?.auth_code) {
          throw new Error('Card refunds require the terminal to approve the reversal first — no auth code received. Nothing was refunded.');
        }

        const taxRate = (orig.tax_rate as number) || 0;
        const origSubtotal = (orig.subtotal as number) || 0;
        const origTaxAmount = (orig.tax_amount as number) || 0;
        const { tax, total } = computeRefundTax(subtotal, origSubtotal, origTaxAmount, taxRate);

        const res = db.prepare(`
          INSERT INTO transactions
            (cashier_id, customer_id, subtotal, tax_rate, tax_amount, discount_amount, total,
             payment_method, payment_status, original_txn_id, auth_code, last4, card_type,
             terminal_ref, signature_data, created_at)
          VALUES (?, ?, ?, ?, ?, 0, ?, ?, 'completed', ?, ?, ?, ?, ?, ?, ?)
        `).run(
          session?.userId || orig.cashier_id, orig.customer_id ?? null, -subtotal, taxRate, -tax, total,
          orig.payment_method, origId,
          payload?.auth_code || null, payload?.last4 || null, payload?.card_type || null,
          payload?.terminal_ref || null, payload?.signature_data || null,
          nowCT()
        );
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
      
      
      
      
      const start = businessDayStart(db);

      const summary = db.prepare(`
        SELECT
          COALESCE(SUM(total), 0) AS revenue,
          COALESCE(SUM(total - tax_amount - discount_amount), 0) AS gross_revenue,
          COUNT(*) AS sale_count
        FROM transactions
        WHERE created_at >= ? AND payment_status = 'completed'
      `).get(start) as { revenue: number; gross_revenue: number; sale_count: number };

      
      const cogResult = db.prepare(`
        SELECT COALESCE(SUM(ti.qty * p.cost), 0) AS cogs
        FROM transaction_items ti
        JOIN products p ON ti.product_id = p.id
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.created_at >= ? AND t.payment_status = 'completed'
      `).get(start) as { cogs: number };

      const profit = summary.revenue - cogResult.cogs;

      const topItem = db.prepare(`
        SELECT p.name, SUM(ti.qty) AS units_sold
        FROM transaction_items ti
        JOIN products p ON ti.product_id = p.id
        JOIN transactions t ON ti.transaction_id = t.id
        WHERE t.created_at >= ? AND t.payment_status = 'completed'
        GROUP BY ti.product_id
        ORDER BY units_sold DESC
        LIMIT 1
      `).get(start) as { name: string; units_sold: number } | undefined;

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

  
  
  
  
  
  
  ipcMain.handle('transactions:todayOverviewLocation', async () => {
    try {
      const locationId = getLocationId();
      if (!locationId) return { success: false, error: 'This register is not assigned to a location yet.' };
      const supabase = getSupabase();
      if (!supabase) return { success: false, error: 'Cloud not configured.' };
      const db = getDb();
      let tenantId: string;
      try { tenantId = getTenantId(db); } catch { return { success: false, error: 'Not licensed.' }; }

      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      const pStart = scheduledBusinessDayStart(db);
      const { data, error } = await supabase.rpc('location_today_overview', { p_tenant: tenantId, p_location: locationId, p_start: pStart });
      if (error) return { success: false, error: error.message };
      return { success: true, overview: data };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
