import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { popCashDrawer, listSerialPorts } from '../services/cashDrawer';
import { nowCT } from '../utils/time';
import { assertWritable } from '../supabase/licenseCheck';
import { enqueueDrawerEvent } from '../supabase/sync';
import { requirePermission } from '../permissions';
import { findCurrentOpenShift, currentCashFloat } from '../shiftTotals';

export function registerDrawerHandlers(): void {
  
  ipcMain.handle('drawer:open', async (_event, note?: string, opts?: { noSale?: boolean; override?: string }) => {
    try {
      const w = assertWritable('drawer_open'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const session = getCurrentSession();
      
      
      if (opts?.noSale) {
        const perm = requirePermission('open_drawer_no_sale', { override: opts.override, action: 'open_drawer_no_sale' }, db);
        if (!perm.ok) return { success: false, error: perm.error, needsOverride: perm.needsOverride };
      }
      const r = await popCashDrawer();
      db.transaction(() => {
        const res = db.prepare(`INSERT INTO drawer_log (cashier_id, cashier_name, event, amount, note) VALUES (?, ?, ?, ?, ?)`)
          .run(session?.userId || null, session?.username || null, 'manual_open', 0,
               r.success ? (note || 'Drawer opened') : `${note || 'Pop'} — ${r.error || 'drawer not opened'}`);
        
        enqueueDrawerEvent(res.lastInsertRowid as number, db);
      })();
      return r;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('drawer:ports', async () => {
    try {
      return { success: true, ports: await listSerialPorts() };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('drawer:summary', async () => {
    try {
      const db = getDb();
      const session = getCurrentSession();
      const float = currentCashFloat(db);

      
      
      
      
      
      
      const shift = findCurrentOpenShift<{ id: number; starting_cash: number; cash_total: number; card_total: number; sale_count: number; opened_at: string }>(session?.userId || 0, db);

      const startingCash = shift?.starting_cash ?? float;
      const cashSales = shift?.cash_total ?? 0;       
      const expectedInDrawer = startingCash + cashSales;
      const suggestedDrop = Math.max(0, cashSales);   

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

  
  ipcMain.handle('drawer:drop', async (_event, amount: number, note?: string) => {
    try {
      const w = assertWritable('drawer_open'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const session = getCurrentSession();
      db.transaction(() => {
        const res = db.prepare(`INSERT INTO drawer_log (cashier_id, cashier_name, event, amount, note, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
          .run(session?.userId || null, session?.username || null, 'cash_drop', amount || 0, note || 'End-of-shift drop', nowCT());
        
        enqueueDrawerEvent(res.lastInsertRowid as number, db);
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
