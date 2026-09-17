import { app, ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { getDb } from './db/schema';
import { getSupabase } from './supabase/client';
import { getTenantId, getLocationId, getRegisterId } from './supabase/sync';
import { currentBusinessDayWindow } from './utils/time';



function readSetting(key: string, db: Database.Database): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
function writeSetting(key: string, value: string, db: Database.Database): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function updateChannel(db: Database.Database): string {
  return readSetting('update_channel', db) === 'staging' ? 'staging' : 'production';
}

const DIAG_INTERVAL_MS = 30 * 60 * 1000; 
const KEY_LAST_DIAG = 'last_diag_report_at';


export async function runDiagnosticReport(): Promise<void> {
  try {
    const db = getDb();
    const lastRun = readSetting(KEY_LAST_DIAG, db);
    if (lastRun && Date.now() - new Date(lastRun).getTime() < DIAG_INTERVAL_MS) return;

    let tenantId: string;
    try { tenantId = getTenantId(db); } catch { return; } 
    const locationId = getLocationId(db);
    const registerId = getRegisterId(db);
    const supabase = getSupabase();
    if (!supabase) return;

    const win = currentBusinessDayWindow(db);
    const local = db.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS revenue
       FROM transactions WHERE created_at >= ? AND payment_status = 'completed'`
    ).get(win.start) as { n: number; revenue: number };
    const localAll = db.prepare(
      `SELECT COUNT(*) AS n, MIN(created_at) AS mn, MAX(created_at) AS mx FROM transactions`
    ).get() as { n: number; mn: string | null; mx: string | null };

    let cloudToday: { n: number; revenue: number; byRegister: Record<string, { n: number; revenue: number }> } | null = null;
    if (locationId) {
      const { data, error } = await supabase
        .from('transactions_cloud')
        .select('register_id, total')
        .eq('tenant_id', tenantId)
        .eq('location_id', locationId)
        .eq('payment_status', 'completed')
        .gte('created_at', win.start);
      if (!error && data) {
        const byRegister: Record<string, { n: number; revenue: number }> = {};
        let revenue = 0;
        for (const row of data as { register_id: string | null; total: number }[]) {
          const r = row.register_id || '(none)';
          if (!byRegister[r]) byRegister[r] = { n: 0, revenue: 0 };
          byRegister[r].n++;
          const t = Number(row.total) || 0;
          byRegister[r].revenue += t;
          revenue += t;
        }
        cloudToday = { n: data.length, revenue, byRegister };
      }
    }

    const report = {
      window_start: win.start,
      window_end: win.end,
      local_today: local,
      local_all_time: localAll,
      cloud_today: cloudToday,
      sync: {
        last_sync_attempted_at: readSetting('last_sync_attempted_at', db),
        last_sync_succeeded_at: readSetting('last_sync_succeeded_at', db),
        last_sync_error: readSetting('last_sync_error', db),
        
        
        last_reconcile_result: (() => {
          const raw = readSetting('last_reconcile_result', db);
          try { return raw ? JSON.parse(raw) : null; } catch { return raw; }
        })(),
      },
      day_session: {
        open: readSetting('day_session_open', db) === '1',
        opened_at: readSetting('day_session_opened_at', db),
      },
    };

    await supabase.from('diagnostic_reports').insert({
      tenant_id: tenantId,
      location_id: locationId,
      register_id: registerId,
      app_version: app.getVersion(),
      app_packaged: app.isPackaged,
      update_channel: updateChannel(db),
      report,
    });

    writeSetting(KEY_LAST_DIAG, new Date().toISOString(), db);
  } catch (err) {
    console.warn('[diagnostics] runDiagnosticReport failed (non-fatal):', String(err));
  }
}


export function startDiagnosticsWorker(): void {
  setTimeout(() => void runDiagnosticReport(), 10_000);
  setInterval(() => void runDiagnosticReport(), 5 * 60 * 1000); 
}


const ERROR_RATE_WINDOW_MS = 60 * 60 * 1000; 
const MAX_ERRORS_PER_WINDOW = 20; 
let errorCount = 0;
let errorWindowStart = 0;
const recentMessages = new Map<string, number>(); 


export async function reportError(
  source: 'renderer' | 'main',
  message: string,
  stack?: string | null,
  context?: Record<string, unknown>
): Promise<void> {
  try {
    const now = Date.now();
    if (now - errorWindowStart > ERROR_RATE_WINDOW_MS) { errorWindowStart = now; errorCount = 0; }
    if (errorCount >= MAX_ERRORS_PER_WINDOW) return;

    const dedupeKey = `${source}:${message}`.slice(0, 500);
    const lastSent = recentMessages.get(dedupeKey);
    if (lastSent && now - lastSent < 5 * 60 * 1000) return; 
    recentMessages.set(dedupeKey, now);

    const db = getDb();
    let tenantId: string;
    try { tenantId = getTenantId(db); } catch { return; }
    const supabase = getSupabase();
    if (!supabase) return;

    errorCount++;
    await supabase.from('error_reports').insert({
      tenant_id: tenantId,
      location_id: getLocationId(db),
      register_id: getRegisterId(db),
      app_version: app.getVersion(),
      source,
      page: (context?.page as string) ?? null,
      message: String(message).slice(0, 4000),
      stack: stack ? String(stack).slice(0, 8000) : null,
      context: context ?? null,
    });
  } catch (err) {
    console.warn('[diagnostics] reportError failed (non-fatal):', String(err));
  }
}


export function registerDiagnosticsHandlers(): void {
  ipcMain.handle('diagnostics:reportError', (_e, args: { message: string; stack?: string; page?: string }) => {
    void reportError('renderer', args?.message || 'Unknown renderer error', args?.stack, { page: args?.page });
    return { success: true };
  });
}
