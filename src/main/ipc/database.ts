import { ipcMain } from 'electron';
import { queryClient } from '../db/queryClient';

/**
 * Generic database access for the renderer. The renderer must NEVER import
 * better-sqlite3 directly — it calls these channels, which run in the main
 * process where the single db instance lives.
 *
 * This is a desktop, single-tenant-per-install app, so exposing parameterized
 * SQL over IPC is acceptable; always pass values via `params` (bound) rather
 * than string-concatenating them into `sql`.
 */
export function registerDatabaseHandlers(): void {
  // SELECT -> rows
  ipcMain.handle('db:query', (_event, sql: string, params: unknown[] = []) => {
    try {
      return { success: true, rows: queryClient.all(sql, ...params) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // SELECT -> single row
  ipcMain.handle('db:get', (_event, sql: string, params: unknown[] = []) => {
    try {
      return { success: true, row: queryClient.get(sql, ...params) ?? null };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // INSERT / UPDATE / DELETE
  ipcMain.handle('db:run', (_event, sql: string, params: unknown[] = []) => {
    try {
      const r = queryClient.run(sql, ...params);
      return { success: true, changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
