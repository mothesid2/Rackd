import { ipcMain } from 'electron';
import { getSupabase } from '../supabase/client';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { getEmployee } from '../permissions';
import { enqueueStockMovement } from '../supabase/sync';
import { nowCT } from '../utils/time';

interface OnlineOrderRow { id: string; subtotal?: number; tax?: number }
interface OnlineItemRow { barcode: string | null; name: string; qty: number; unit_price: number; line_total: number }

/**
 * Record a fulfilled online order as a LOCAL "Online — Prepaid" transaction (spec
 * item 9): counted in the POS's sales/revenue + inventory, but excluded from the
 * cash-drawer X/Z (payment_method NULL, order_source='online'). The store's sale is
 * merchandise only (subtotal + tax) — the 5% online fee is platform revenue, not the
 * store's. Idempotent on online_order_id. Local-only (the order already lives in the
 * cloud); only the stock movement syncs so a location's registers converge.
 */
function recordOnlinePickupLocally(order: OnlineOrderRow, items: OnlineItemRow[], cashierId: number | null): void {
  const db = getDb();
  if (!order?.id) return;
  if (db.prepare('SELECT 1 FROM transactions WHERE online_order_id = ?').get(order.id)) return; // already recorded
  const subtotal = Number(order.subtotal) || 0;
  const tax = Number(order.tax) || 0;
  const taxRate = subtotal > 0 ? tax / subtotal : 0;
  const total = subtotal + tax; // store's merchandise sale (fee excluded)
  db.transaction(() => {
    const res = db.prepare(
      `INSERT INTO transactions
         (cashier_id, customer_id, subtotal, tax_rate, tax_amount, discount_amount, total,
          payment_method, payment_status, order_source, online_order_id, created_at)
       VALUES (?, NULL, ?, ?, ?, 0, ?, NULL, 'completed', 'online', ?, ?)`
    ).run(cashierId, subtotal, taxRate, tax, total, order.id, nowCT());
    const txnId = res.lastInsertRowid as number;
    for (const it of items) {
      const prod = it.barcode
        ? (db.prepare('SELECT id FROM products WHERE barcode = ? LIMIT 1').get(it.barcode) as { id: number } | undefined)
        : undefined;
      db.prepare(
        `INSERT INTO transaction_items (transaction_id, product_id, variant_id, qty, unit_price, line_total, description, category)
         VALUES (?, ?, NULL, ?, ?, ?, ?, NULL)`
      ).run(txnId, prod?.id ?? null, it.qty, it.unit_price, it.line_total, it.name);
      if (prod?.id) {
        db.prepare('UPDATE products SET stock_qty = MAX(0, stock_qty - ?), updated_at = ? WHERE id = ?').run(it.qty, nowCT(), prod.id);
        enqueueStockMovement(prod.id, -it.qty, 'sale', db); // syncs the delta to location peers
      }
    }
  })();
}

// Register-side view of the online storefront: the in-store PICKUP queue for THIS
// location and the compliance pickup (second 21+ ID check, employee-attributed and
// audited). Online orders live only in the cloud, so these talk to Supabase with
// the register's license token; RLS scopes reads/writes to the register's location.

interface OrderRow {
  id: string; order_number: string; status: string; total: number;
  created_at: string; ready_at: string | null;
  online_order_items?: { name: string; qty: number }[];
}

export function registerStorefrontHandlers(): void {
  // Open pickup queue for this register's location (new | preparing | ready).
  ipcMain.handle('storefront:queue', async () => {
    const sb = getSupabase();
    if (!sb) return { success: false, error: 'Cloud not configured' };
    const { data, error } = await sb
      .from('online_orders')
      .select('id, order_number, status, total, created_at, ready_at, online_order_items(name, qty)')
      .in('status', ['new', 'preparing', 'ready'])
      .order('created_at', { ascending: true });
    if (error) return { success: false, error: error.message };
    return { success: true, orders: (data as OrderRow[]) || [] };
  });

  // Advance an order to preparing/ready. Routes through the edge function so the
  // customer gets the "ready" SMS (and refund/stock-restore on cancel) server-side.
  ipcMain.handle('storefront:advance', async (_e, args: { order_id: string; status: 'preparing' | 'ready' | 'cancelled'; cancel_reason?: string }) => {
    const sb = getSupabase();
    if (!sb) return { success: false, error: 'Cloud not configured' };
    const { order_id, status, cancel_reason } = args || ({} as { order_id: string; status: string });
    if (!order_id || !['preparing', 'ready', 'cancelled'].includes(status)) return { success: false, error: 'Invalid request' };
    const { data, error } = await sb.functions.invoke('storefront-order-ready', {
      body: { order_id, status, cancel_reason },
    });
    if (error) return { success: false, error: error.message };
    return { success: true, result: data };
  });

  // COMPLIANCE: complete a pickup. Requires a logged-in employee and an explicit
  // in-person ID-checked confirmation. Attribution + the append-only audit are
  // written server-side by complete_online_pickup().
  ipcMain.handle('storefront:completePickup', async (_e, args: { order_id: string; id_checked: boolean }) => {
    const sb = getSupabase();
    if (!sb) return { success: false, error: 'Cloud not configured' };
    const { order_id, id_checked } = args || ({} as { order_id: string; id_checked: boolean });
    if (!order_id) return { success: false, error: 'Missing order' };
    if (id_checked !== true) return { success: false, error: 'You must confirm you checked a valid 21+ ID in person.' };

    const session = getCurrentSession();
    if (!session?.userId) return { success: false, error: 'No employee is signed in. Sign in before completing a pickup.' };
    const emp = getEmployee(getDb(), session.userId);
    if (!emp) return { success: false, error: 'Could not resolve the signed-in employee.' };

    const { data, error } = await sb.rpc('complete_online_pickup', {
      p_order: order_id, p_employee_uid: emp.uid, p_employee_name: emp.name, p_id_checked: true,
    });
    if (error) {
      const m = error.message || String(error);
      if (/id_check_required/.test(m)) return { success: false, error: 'The ID check must be confirmed.' };
      if (/not_pickable/.test(m)) return { success: false, error: 'This order was already picked up or cancelled.' };
      if (/not_authorized|not_staff/.test(m)) return { success: false, error: 'This order belongs to another store.' };
      return { success: false, error: m };
    }

    // Record the fulfilled order in the POS's local sales + inventory as an
    // "Online — Prepaid" transaction (excluded from the cash drawer). Non-fatal.
    try {
      const { data: items } = await sb.from('online_order_items')
        .select('barcode, name, qty, unit_price, line_total').eq('order_id', order_id);
      recordOnlinePickupLocally(data as OnlineOrderRow, (items as OnlineItemRow[]) || [], session.userId);
    } catch (e) {
      console.warn('[storefront] local online-sale record failed (non-fatal):', String(e));
    }
    return { success: true, order: data, employee: emp.name };
  });
}
