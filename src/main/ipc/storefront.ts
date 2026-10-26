import { ipcMain } from 'electron';
import { getSupabase } from '../supabase/client';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { getEmployee } from '../permissions';
import { enqueueStockMovement } from '../supabase/sync';
import { nowCT } from '../utils/time';


const UNABLE_TO_FULFILL_REASONS = ['out_of_stock', 'item_damaged', 'id_compliance', 'store_closing', 'other'];

interface OnlineOrderRow { id: string; subtotal?: number; tax?: number }
interface OnlineItemRow { barcode: string | null; name: string; qty: number; unit_price: number; line_total: number }


function recordOnlinePickupLocally(order: OnlineOrderRow, items: OnlineItemRow[], cashierId: number | null): void {
  const db = getDb();
  if (!order?.id) return;
  if (db.prepare('SELECT 1 FROM transactions WHERE online_order_id = ?').get(order.id)) return; 
  const subtotal = Number(order.subtotal) || 0;
  const tax = Number(order.tax) || 0;
  const taxRate = subtotal > 0 ? tax / subtotal : 0;
  const total = subtotal + tax; 
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
        enqueueStockMovement(prod.id, -it.qty, 'sale', db); 
      }
    }
  })();
}



interface OrderRow {
  id: string; order_number: string; status: string; total: number;
  created_at: string; ready_at: string | null;
  online_order_items?: { name: string; qty: number }[];
}

// Reservations (Storefront Manager). The cashier loads one into the normal POS cart and takes payment at the register
// like any sale, so it stays in X/Z. After the sale completes the POS links reservation -> sale (pos_link_reservation_sale).
interface StagedReservation { id: string; code: string; customer_name: string | null; lines: { barcode: string | null; name: string; category: string | null; qty: number; unit_price: number }[] }
let staged: StagedReservation | null = null;

export function registerStorefrontHandlers(): void {
  ipcMain.handle('storefront:reservations', async () => {
    const sb = getSupabase();
    if (!sb) return { success: false, error: 'Cloud not configured' };
    const { data, error } = await sb
      .from('reservations')
      .select('id, code, customer_name, status, subtotal, fee_amount, total, hold_expires_at, created_at, reservation_items(item_id, name, category, qty, unit_price, is_removed)')
      .in('status', ['new', 'confirmed', 'ready'])
      .order('created_at', { ascending: true });
    if (error) return { success: false, error: error.message };
    return { success: true, reservations: data || [] };
  });

  ipcMain.handle('storefront:stageReservation', async (_e, args: { id: string }) => {
    const sb = getSupabase();
    if (!sb) return { success: false, error: 'Cloud not configured' };
    if (!getCurrentSession()?.userId) return { success: false, error: 'Sign in before loading a pickup.' };
    const { data: r, error } = await sb.from('reservations')
      .select('id, code, customer_name, status, reservation_items(item_id, name, category, qty, unit_price, is_removed)')
      .eq('id', args?.id).maybeSingle();
    if (error || !r) return { success: false, error: error?.message || 'Reservation not found' };
    if (!['new', 'confirmed', 'ready'].includes((r as { status: string }).status)) return { success: false, error: 'This reservation is already closed.' };
    const rows = ((r as { reservation_items: { item_id: string | null; name: string; category: string | null; qty: number; unit_price: number; is_removed: boolean }[] }).reservation_items || []).filter((i) => !i.is_removed);
    const ids = rows.map((i) => i.item_id).filter((x): x is string => !!x);
    const barcodes = new Map<string, string | null>();
    if (ids.length) {
      const { data: its } = await sb.from('storefront_items').select('id, pos_product_id').in('id', ids);
      for (const it of (its as { id: string; pos_product_id: string | null }[]) || []) barcodes.set(it.id, it.pos_product_id);
    }
    staged = {
      id: (r as { id: string }).id, code: (r as { code: string }).code, customer_name: (r as { customer_name: string | null }).customer_name,
      lines: rows.map((i) => ({ barcode: (i.item_id && barcodes.get(i.item_id)) || null, name: i.name, category: i.category, qty: i.qty, unit_price: Number(i.unit_price) })),
    };
    return { success: true };
  });

  // The POS page picks the staged reservation up once, when it opens.
  ipcMain.handle('storefront:takeStaged', () => { const s = staged; staged = null; return { success: true, reservation: s }; });

  ipcMain.handle('storefront:linkSale', async (_e, args: { reservation_id: string; sale_id: string | number }) => {
    const sb = getSupabase();
    if (!sb) return { success: false, error: 'Cloud not configured' };
    const session = getCurrentSession();
    if (!session?.userId) return { success: false, error: 'No employee is signed in.' };
    const emp = getEmployee(getDb(), session.userId);
    if (!emp) return { success: false, error: 'Could not resolve the signed-in employee.' };
    const { error } = await sb.rpc('pos_link_reservation_sale', {
      p_id: args?.reservation_id, p_sale: String(args?.sale_id ?? ''), p_employee_uid: emp.uid, p_employee_name: emp.name,
    });
    if (error) {
      if (/invalid_transition/.test(error.message)) return { success: false, error: 'This reservation was already closed.' };
      return { success: false, error: error.message };
    }
    return { success: true };
  });

  
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

  
  
  
  
  
  
  ipcMain.handle('storefront:advance', async (_e, args: { order_id: string; status: 'preparing' | 'ready' | 'cancelled'; cancel_reason?: string }) => {
    const sb = getSupabase();
    if (!sb) return { success: false, error: 'Cloud not configured' };
    const { order_id, status, cancel_reason } = args || ({} as { order_id: string; status: string; cancel_reason?: string });
    if (!order_id || !['preparing', 'ready', 'cancelled'].includes(status)) return { success: false, error: 'Invalid request' };

    if (status === 'cancelled') {
      const session = getCurrentSession();
      if (!session || (session.role !== 'manager' && session.role !== 'admin')) {
        return { success: false, error: 'Only a manager or admin can cancel and refund an online order.' };
      }
      if (!cancel_reason || !UNABLE_TO_FULFILL_REASONS.includes(cancel_reason)) {
        return { success: false, error: 'A reason (unable to fulfill) is required to cancel and refund.' };
      }
    }

    const { data, error } = await sb.functions.invoke('storefront-order-ready', {
      body: { order_id, status, cancel_reason },
    });
    if (error) return { success: false, error: error.message };
    return { success: true, result: data };
  });

  
  
  
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
