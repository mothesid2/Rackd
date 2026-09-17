import { ipcMain } from 'electron';
import {
  triggerSyncNow,
  getSyncStatus,
  getOnline,
  getDeadLetters,
  retryDeadLetter,
  clearDeadLetter,
  resyncAllInventory,
  resyncAllTransactions,
  getTenantId,
  getLocationId,
  getRegisterId,
} from '../supabase/sync';
import { getDb } from '../db/schema';


export function registerSyncHandlers(): void {
  const status = () => ({ ...getSyncStatus(), is_online: getOnline() });

  
  ipcMain.handle('sync:trigger', async () => {
    try {
      await triggerSyncNow();
      return { success: true, status: status() };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  
  
  
  ipcMain.handle('sync:resyncAll', async () => {
    try {
      const n = resyncAllInventory() + resyncAllTransactions();
      await triggerSyncNow();
      return { success: true, queued: n };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('sync:status', () => {
    try {
      return { success: true, status: status() };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('sync:dead-letters', () => {
    try {
      return { success: true, rows: getDeadLetters() };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('sync:retry-dead-letter', async (_event, id: number) => {
    try {
      const changes = retryDeadLetter(id);
      if (changes > 0) void triggerSyncNow();
      return { success: true, retried: changes };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('sync:clear-dead-letter', (_event, id: number) => {
    try {
      return { success: true, cleared: clearDeadLetter(id) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  
  
  
  
  
  ipcMain.handle('sync:diagnostics', () => {
    try {
      const db = getDb();
      let tenantId: string | null = null;
      try { tenantId = getTenantId(db); } catch {  }
      const cursors = db.prepare('SELECT table_name, last_pulled_at, updated_at FROM sync_cursors ORDER BY table_name').all();
      return {
        success: true,
        tenant_id: tenantId,
        location_id: getLocationId(db),
        register_id: getRegisterId(db),
        cursors,
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
