import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/schema';
import { loadEnv } from '../supabase/env';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '../supabase/publicConfig';

/**
 * Owner admin console back-end. Provisions tenants/licenses by proxying to the
 * `admin` Edge Function, which holds the service role. The shared ADMIN_SECRET
 * is stored locally on the owner's machine (behind the Owner PIN) and never
 * shipped in a client build.
 */
function readSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
function writeSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
function ownerPinValid(pin: unknown): boolean {
  const hash = readSetting('owner_pin_hash');
  return !!hash && bcrypt.compareSync(String(pin ?? ''), hash);
}

function endpoint(): { url: string; anon: string } {
  loadEnv();
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || PUBLIC_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || PUBLIC_SUPABASE_ANON_KEY;
  return { url: `${base.replace(/\/$/, '')}/functions/v1/admin`, anon };
}

async function callAdmin(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const secret = readSetting('admin_secret');
  if (!secret) return { success: false, error: 'Admin secret not set. Enter it in the console.' };
  const { url, anon } = endpoint();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${anon}` },
      body: JSON.stringify({ admin_secret: secret, action, ...payload }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { success: false, error: (data.error as string) || `HTTP ${res.status}` };
    return { success: true, ...data };
  } catch (err) {
    return { success: false, error: `Could not reach admin server: ${String(err)}` };
  }
}

export function registerAdminHandlers(): void {
  ipcMain.handle('admin:hasSecret', () => ({ success: true, hasSecret: !!readSetting('admin_secret') }));

  ipcMain.handle('admin:setSecret', (_e, pin: string, secret: string) => {
    if (!ownerPinValid(pin)) return { success: false, error: 'Owner PIN required' };
    writeSetting('admin_secret', String(secret || '').trim());
    return { success: true };
  });

  ipcMain.handle('admin:list', () => callAdmin('list', {}));
  ipcMain.handle('admin:create', (_e, payload: Record<string, unknown>) => callAdmin('create', payload || {}));
  ipcMain.handle('admin:update', (_e, payload: Record<string, unknown>) => callAdmin('update', payload || {}));
  ipcMain.handle('admin:delete', (_e, licenseKey: string) => callAdmin('delete', { license_key: licenseKey }));
  ipcMain.handle('admin:setAds', (_e, licenseKey: string, displayConfig: unknown) =>
    callAdmin('setAds', { license_key: licenseKey, display_config: displayConfig })
  );
  ipcMain.handle('admin:freeSeat', (_e, licenseKey: string, machineId: string) =>
    callAdmin('freeSeat', { license_key: licenseKey, machine_id: machineId })
  );
}
