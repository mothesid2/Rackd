import { ipcMain } from 'electron';
import { DateTime } from 'luxon';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { businessDayBounds, currentBusinessDate } from '../utils/time';



const DEAD_STOCK_DAYS = 60; 

function requireManager(): { ok: true } | { ok: false; error: string } {
  const s = getCurrentSession();
  if (!s || s.role !== 'manager') return { ok: false, error: 'Manager access required' };
  return { ok: true };
}

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso.replace(' ', 'T') + (iso.includes('Z') ? '' : 'Z'));
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

interface DeadRow {
  id: number; sku: string | null; product_name: string; category: string | null;
  vendor: string | null; stock_qty: number; cost: number; price: number;
  last_sold: string | null; created_at: string;
}


function suggestAction(days: number, hasVendor: boolean): { action: string; reason: string } {
  if (days >= 180)
    return { action: 'write_off', reason: `No sale in ${days} days — unlikely to move; write off or deep-clearance.` };
  if (days >= 120 && hasVendor)
    return { action: 'return_to_vendor', reason: `No sale in ${days} days and a vendor is on file — ask about a return/credit.` };
  if (days >= 120)
    return { action: 'clearance_price', reason: `No sale in ${days} days — mark down to clear the shelf.` };
  if (days >= 90)
    return { action: 'bundle', reason: `No sale in ${days} days — bundle with a fast mover to shift units.` };
  return { action: 'run_promo', reason: `No sale in ${days} days — a short promo may re-activate demand.` };
}

export function registerAnalyticsHandlers(): void {
  
  ipcMain.handle('analytics:deadStock', () => {
    const g = requireManager(); if (!g.ok) return { success: false, error: g.error };
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT p.id, p.barcode AS sku, p.name AS product_name, p.category, p.vendor,
               p.stock_qty, p.cost, p.price, p.created_at,
               (SELECT MAX(t.created_at)
                  FROM transaction_items ti
                  JOIN transactions t ON t.id = ti.transaction_id
                 WHERE ti.product_id = p.id AND t.total >= 0) AS last_sold
          FROM products p
         WHERE p.stock_qty > 0
      `).all() as DeadRow[];

      const report = rows.map((r) => {
        
        const sinceSale = daysSince(r.last_sold);
        const sinceAdded = daysSince(r.created_at) ?? 0;
        const days = sinceSale ?? sinceAdded;
        const cost_value = +(r.stock_qty * (r.cost || 0)).toFixed(2);
        const s = suggestAction(days, !!(r.vendor && r.vendor.trim()));
        return {
          product_id: r.id,
          sku: r.sku || '—',
          product_name: r.product_name,
          category: r.category || '',
          vendor: r.vendor || '',
          current_stock: r.stock_qty,
          unit_cost: r.cost || 0,
          price: r.price || 0,
          last_sold_date: r.last_sold,
          never_sold: sinceSale == null,
          days_since_last_sale: days,
          cost_value,
          suggested_action: s.action,
          suggested_action_reason: s.reason,
        };
      })
      .filter((x) => x.days_since_last_sale >= DEAD_STOCK_DAYS)
      .sort((a, b) => b.cost_value - a.cost_value); 

      const oldest = report.reduce<null | typeof report[number]>(
        (m, x) => (!m || x.days_since_last_sale > m.days_since_last_sale ? x : m), null);

      return {
        success: true,
        threshold_days: DEAD_STOCK_DAYS,
        report,
        summary: {
          total_dead_stock_skus: report.length,
          total_dead_stock_units: report.reduce((s, x) => s + x.current_stock, 0),
          total_dead_stock_cost_value: +report.reduce((s, x) => s + x.cost_value, 0).toFixed(2),
          oldest_dead_stock_sku: oldest?.sku ?? null,
          oldest_days_since_last_sale: oldest?.days_since_last_sale ?? null,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  ipcMain.handle('analytics:employeePerformance', (_e, opts?: { start_date?: string; end_date?: string }) => {
    const g = requireManager(); if (!g.ok) return { success: false, error: g.error };
    try {
      return { success: true, ...computeEmployeePerformance(getDb(), opts) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}


export function computeEmployeePerformance(db: ReturnType<typeof getDb>, opts?: { start_date?: string; end_date?: string }) {
      
      
      
      
      
      
      const endLabel = opts?.end_date || currentBusinessDate(db);
      const startLabel = opts?.start_date || (DateTime.fromISO(endLabel).minus({ days: 30 }).toISODate() as string);
      const { start } = businessDayBounds(startLabel, db);
      const { end } = businessDayBounds(endLabel, db);

      
      
      const base = db.prepare(`
        SELECT t.cashier_id AS employee_id,
               COALESCE(u.username, 'Unknown') AS employee_name,
               COUNT(*) AS total_transactions,
               COALESCE(SUM(t.total), 0) AS total_revenue,
               SUM(CASE WHEN t.total < 0 THEN 1 ELSE 0 END) AS voids_count,
               SUM(CASE WHEN t.discount_amount > 0 THEN 1 ELSE 0 END) AS discounts_applied_count,
               COALESCE(SUM(t.discount_amount), 0) AS discounts_total_value,
               COALESCE(MAX(ABS(t.total)), 0) AS max_txn
          FROM transactions t
          LEFT JOIN users u ON u.id = t.cashier_id
         WHERE t.created_at >= ? AND t.created_at < ?
         GROUP BY t.cashier_id
      `).all(start, end) as Array<{
        employee_id: number; employee_name: string; total_transactions: number;
        total_revenue: number; voids_count: number; discounts_applied_count: number;
        discounts_total_value: number; max_txn: number;
      }>;

      const itemsStmt = db.prepare(`
        SELECT COALESCE(SUM(ti.qty), 0) AS units
          FROM transaction_items ti
          JOIN transactions t ON t.id = ti.transaction_id
         WHERE t.cashier_id = ? AND t.created_at >= ? AND t.created_at < ?
      `);
      const topStmt = db.prepare(`
        SELECT COALESCE(p.name, 'Item') AS name, SUM(ti.qty) AS units
          FROM transaction_items ti
          JOIN transactions t ON t.id = ti.transaction_id
          LEFT JOIN products p ON p.id = ti.product_id
         WHERE t.cashier_id = ? AND t.created_at >= ? AND t.created_at < ? AND t.total >= 0
         GROUP BY ti.product_id
         ORDER BY units DESC
         LIMIT 3
      `);

      const storeRevenue = base.reduce((s, r) => s + r.total_revenue, 0);
      const storeAvg = base.length ? storeRevenue / base.length : 0;

      const report = base.map((r) => {
        const avg = r.total_transactions ? r.total_revenue / r.total_transactions : 0;
        const items = (itemsStmt.get(r.employee_id, start, end) as { units: number }).units || 0;
        const top = topStmt.all(r.employee_id, start, end) as Array<{ name: string; units: number }>;

        const voidRate = r.total_transactions ? r.voids_count / r.total_transactions : 0;
        const discountRate = r.total_revenue > 0 ? r.discounts_total_value / r.total_revenue : 0;
        const flags: string[] = [];
        if (voidRate > 0.05) flags.push('high_void_rate');
        if (discountRate > 0.15) flags.push('high_discount_rate');
        if (avg > 0 && r.max_txn > 3 * avg) flags.push('outlier_transaction');

        return {
          employee_id: r.employee_id,
          employee_name: r.employee_name,
          total_transactions: r.total_transactions,
          total_revenue: +r.total_revenue.toFixed(2),
          avg_transaction_value: +avg.toFixed(2),
          total_items_sold: items,
          voids_count: r.voids_count,
          discounts_applied_count: r.discounts_applied_count,
          discounts_total_value: +r.discounts_total_value.toFixed(2),
          top_3_products_sold: top,
          performance_vs_store_avg: storeAvg > 0
            ? +(((r.total_revenue - storeAvg) / storeAvg) * 100).toFixed(1) : 0,
          flags,
        };
      })
      .sort((a, b) => b.total_revenue - a.total_revenue)
      .map((r, i) => ({ rank: i + 1, ...r }));

  return {
    range: { start_date: startLabel, end_date: endLabel },
    store_total_revenue: +storeRevenue.toFixed(2),
    store_avg_revenue_per_employee: +storeAvg.toFixed(2),
    report,
  };
}
