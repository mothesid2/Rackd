import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { popCashDrawer, listSerialPorts } from '../services/cashDrawer';
import { nowCT } from '../utils/time';
import { assertWritable } from '../supabase/licenseCheck';
import { enqueueDrawerEvent } from '../supabase/sync';

export function registerDrawerHandlers(): void {
  // ── drawer:open — pop the drawer (manual button or on Cash click) ──────────
  ipcMain.handle('drawer:open', async (_event, note?: string) => {
    try {
      const w = assertWritable('drawer_open'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const session = getCurrentSession();
      const r = await popCashDrawer();
      db.transaction(() => {
        const res = db.prepare(`INSERT INTO drawer_log (cashier_id, cashier_name, event, amount, note) VALUES (?, ?, ?, ?, ?)`)
          .run(session?.userId || null, session?.username || null, 'manual_open', 0,
               r.success ? (note || 'Drawer opened') : `${note || 'Pop'} — ${r.error || 'drawer not opened'}`);
        // Cloud sync (path 5): mirror the drawer event to cash_drawer_sessions_cloud.
        enqueueDrawerEvent(res.lastInsertRowid as number, db);
      })();
      return r;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── drawer:ports — list serial ports (for Settings) ───────────────────────
  ipcMain.handle('drawer:ports', async () => {
    try {
      return { success: true, ports: await listSerialPorts() };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── drawer:summary — current shift cash position ──────────────────────────
  ipcMain.handle('drawer:summary', async () => {
    try {
      const db = getDb();
      const session = getCurrentSession();
      const float = parseFloat(
        (db.prepare("SELECT value FROM settings WHERE key = 'cash_float'").get() as { value: string } | undefined)?.value || '200'
      ) || 200;

      const shift = db.prepare(
        `SELECT * FROM shift_totals WHERE cashier_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`
      ).get(session?.userId || 0) as
        { starting_cash: number; cash_total: number; card_total: number; sale_count: number; opened_at: string } | undefined;

      const startingCash = shift?.starting_cash ?? float;
      const cashSales = shift?.cash_total ?? 0;       // already nets cash refunds
      const expectedInDrawer = startingCash + cashSales;
      const suggestedDrop = Math.max(0, cashSales);   // deposit cash sales, leave the float

      return {
        success: true,
        summary: {
          starting_cash: startingCash,
          cash_sales: cashSales,
          card_sales: shift?.card_total ?? 0,
          sale_count: shift?.sale_count ?? 0,
          expected_in_drawer: expectedInDrawer,
          suggested_drop: suggestedDrop,
          float_after_drop: startingCash,
          opened_at: shift?.opened_at ?? null,
          has_shift: !!shift,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── drawer:log — recent drawer events ─────────────────────────────────────
  ipcMain.handle('drawer:log', async (_event, limit?: number) => {
    try {
      const db = getDb();
      const rows = db.prepare(
        `SELECT * FROM drawer_log ORDER BY created_at DESC, id DESC LIMIT ?`
      ).all(Math.min(limit || 50, 200));
      return { success: true, log: rows };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── drawer:drop — record an end-of-shift cash drop ────────────────────────
  ipcMain.handle('drawer:drop', async (_event, amount: number, note?: string) => {
    try {
      const w = assertWritable('drawer_open'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const session = getCurrentSession();
      db.transaction(() => {
        const res = db.prepare(`INSERT INTO drawer_log (cashier_id, cashier_name, event, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(session?.userId || null, session?.username || null, 'cash_drop', amount || 0, note || 'End-of-shift drop', nowCT());
        // Cloud sync (path 5): mirror the drawer event to cash_drawer_sessions_cloud.
        enqueueDrawerEvent(res.lastInsertRowid as number, db);
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
