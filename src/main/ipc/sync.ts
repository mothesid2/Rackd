import { ipcMain } from 'electron';
import {
  triggerSyncNow,
  getSyncStatus,
  getOnline,
  getDeadLetters,
  retryDeadLetter,
  clearDeadLetter,
  resyncAllInventory,
} from '../supabase/sync';

/** Sync health + dead-letter management for the renderer / manager PWA. */
export function registerSyncHandlers(): void {
  const status = () => ({ ...getSyncStatus(), is_online: getOnline() });

  // Manually run a sync cycle now.
  ipcMain.handle('sync:trigger', async () => {
    try {
      await triggerSyncNow();
      return { success: true, status: status() };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Re-push a snapshot of ALL inventory to the cloud, then run a cycle. Fixes the
  // Manager Portal / Owner Console showing stale or empty inventory after a re-key.
  ipcMain.handle('sync:resyncAll', async () => {
    try {
      const n = resyncAllInventory();
      await triggerSyncNow();
      return { success: true, queued: n };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Current sync health stats.
  ipcMain.handle('sync:status', () => {
    try {
      return { success: true, status: status() };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // All dead-letter records for admin review.
  ipcMain.handle('sync:dead-letters', () => {
    try {
      return { success: true, rows: getDeadLetters() };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Retry one dead-letter, then kick a cycle.
  ipcMain.handle('sync:retry-dead-letter', async (_event, id: number) => {
    try {
      const changes = retryDeadLetter(id);
      if (changes > 0) void triggerSyncNow();
      return { success: true, retried: changes };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Permanently abandon one dead-letter (kept for audit, never retried).
  ipcMain.handle('sync:clear-dead-letter', (_event, id: number) => {
    try {
      return { success: true, cleared: clearDeadLetter(id) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
