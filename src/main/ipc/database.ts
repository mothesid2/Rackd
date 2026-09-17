import { ipcMain } from 'electron';
import { queryClient } from '../db/queryClient';


export function registerDatabaseHandlers(): void {
  
  ipcMain.handle('db:query', (_event, sql: string, params: unknown[] = []) => {
    try {
      return { success: true, rows: queryClient.all(sql, ...params) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('db:get', (_event, sql: string, params: unknown[] = []) => {
    try {
      return { success: true, row: queryClient.get(sql, ...params) ?? null };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('db:run', (_event, sql: string, params: unknown[] = []) => {
    try {
      const r = queryClient.run(sql, ...params);
      return { success: true, changes: r.changes, lastInsertRowid: Number(r.lastInsertRowid) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
