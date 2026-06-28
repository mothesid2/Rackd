import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { assertWritable } from '../supabase/licenseCheck';

export function registerSettingsHandlers(): void {
  ipcMain.handle('settings:getAll', async () => {
    try {
      const db = getDb();
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[];
      const settings: Record<string, string> = {};
      for (const row of rows) settings[row.key] = row.value;
      // Mask sensitive values
      if (settings.twilio_auth_token) settings.twilio_auth_token = '••••••••';
      return { success: true, settings };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('settings:update', async (_event, key: string, value: string) => {
    try {
      const w = assertWritable('settings_change'); if (!w.ok) return { success: false, error: w.error };
      const session = getCurrentSession();
      if (session?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
