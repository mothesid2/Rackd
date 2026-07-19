import { getSupabase } from '../supabase/client';
import { getLocationId } from '../supabase/sync';
import { getDb } from '../db/schema';
import { isPrinterConfigured, printPickupReceipt } from './printer';

/**
 * Auto-print online pickup receipts (spec item 9).
 *
 * Polls the cloud for PAID online orders at this register's location that haven't
 * been printed yet, atomically claims each (so exactly one register prints, even
 * with several online), and prints a PREPAID pickup receipt — no cashier action.
 * Only registers that actually have a printer configured participate.
 *
 * These orders live only in the cloud (`online_orders`); they are never recorded
 * as local `transactions`, so they are inherently excluded from the cash-drawer
 * X/Z reconciliation. Online revenue is reported cloud-side (Owner Console +
 * manager portal).
 */
const POLL_MS = 30_000;
let timer: NodeJS.Timeout | null = null;

async function cycle(): Promise<void> {
  if (!isPrinterConfigured()) return; // no printer here — another register prints
  const sb = getSupabase();
  if (!sb) return;
  const locationId = getLocationId();
  if (!locationId) return;

  const { data: orders, error } = await sb
    .from('online_orders')
    .select('id, order_number, customer_name, customer_phone, subtotal, tax, online_fee, total, created_at, online_order_items(name, qty, line_total)')
    .eq('location_id', locationId)
    .is('receipt_printed_at', null)
    .in('status', ['new', 'preparing', 'ready'])
    .order('created_at', { ascending: true })
    .limit(10);
  if (error || !orders?.length) return;

  const config = (getDb().prepare('SELECT * FROM receipt_config WHERE id = 1').get() as Record<string, unknown>) || {};

  for (const o of orders as Record<string, unknown>[]) {
    // Atomic claim: only the register whose UPDATE flips the null flag prints.
    const { data: claimed } = await sb
      .from('online_orders')
      .update({ receipt_printed_at: new Date().toISOString() })
      .eq('id', o.id as string)
      .is('receipt_printed_at', null)
      .select('id');
    if (!claimed?.length) continue; // another register already claimed it

    try {
      const items = (o.online_order_items as { name: string; qty: number; line_total: number }[] | null) || [];
      await printPickupReceipt(
        {
          order_number: (o.order_number as string) || String(o.id).slice(0, 8),
          customer_name: (o.customer_name as string) || null,
          customer_phone: (o.customer_phone as string) || null,
          items: items.map((i) => ({ qty: Number(i.qty) || 0, name: i.name, line_total: Number(i.line_total) || 0 })),
          subtotal: Number(o.subtotal) || 0,
          tax: Number(o.tax) || 0,
          online_fee: Number(o.online_fee) || 0,
          total: Number(o.total) || 0,
          created_at: (o.created_at as string) || null,
        },
        config
      );
      console.log(`[pickup-print] printed online order ${o.order_number}`);
    } catch (e) {
      console.warn('[pickup-print] print failed, releasing claim:', String(e));
      // Release the claim so it can be retried (by us or another register).
      await sb.from('online_orders').update({ receipt_printed_at: null }).eq('id', o.id as string);
    }
  }
}

export function startPickupPrinter(): void {
  if (timer) return;
  const run = () => void cycle().catch((e) => console.warn('[pickup-print] cycle error:', String(e)));
  setTimeout(run, 8000); // shortly after boot
  timer = setInterval(run, POLL_MS);
  console.log('[pickup-print] auto-print worker started (every 30s).');
}
export function stopPickupPrinter(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
