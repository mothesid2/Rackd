import { ipcMain } from 'electron';
import { getDb } from '../db/schema';


export function registerLayoutHandlers(): void {
  ipcMain.handle('layout:getForRole', (_e, role: string) => {
    try {
      const db = getDb();
      const row = db.prepare('SELECT report_slots, tile_order, updated_at FROM pos_layout_config WHERE role = ?').get(role) as
        { report_slots: string | null; tile_order: string | null; updated_at: string } | undefined;
      const safeParse = (s: string | null): unknown[] | null => {
        if (!s) return null;
        try { const a = JSON.parse(s); return Array.isArray(a) ? a : null; } catch { return null; }
      };
      return {
        success: true,
        layout: {
          report_slots: row ? safeParse(row.report_slots) : null,
          tile_order: row ? safeParse(row.tile_order) : null,
          updated_at: row?.updated_at || null,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
