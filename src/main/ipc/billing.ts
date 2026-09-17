import { ipcMain, shell } from 'electron';
import { getDb } from '../db/schema';
import { loadEnv } from '../supabase/env';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from '../supabase/publicConfig';


function readSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function endpoint(fn: string): { url: string; anon: string } {
  loadEnv();
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || PUBLIC_SUPABASE_URL;
  const anon = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || PUBLIC_SUPABASE_ANON_KEY;
  return { url: `${base.replace(/\/$/, '')}/functions/v1/${fn}`, anon };
}

async function callBilling(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const secret = readSetting('admin_secret');
  if (!secret) return { success: false, error: 'Admin secret not set. Unlock the owner console first.' };
  
  const license_key = (payload.license_key as string) || readSetting('license_key') || '';
  const { url, anon } = endpoint('billing');
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: anon, Authorization: `Bearer ${anon}` },
      body: JSON.stringify({ admin_secret: secret, action, ...payload, license_key }),
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { success: false, error: (data.error as string) || `HTTP ${res.status}` };
    return { success: true, ...data };
  } catch (err) {
    return { success: false, error: `Could not reach billing server: ${String(err)}` };
  }
}

export function registerBillingHandlers(): void {
  ipcMain.handle('billing:status', (_e, licenseKey?: string) => callBilling('status', { license_key: licenseKey }));

  
  ipcMain.handle('billing:checkout', async (_e, opts: { license_key?: string; plan: string; cycle: string }) => {
    const r = await callBilling('checkout', { license_key: opts?.license_key, plan: opts?.plan, cycle: opts?.cycle });
    if (r.success && typeof r.url === 'string') { try { await shell.openExternal(r.url); } catch {  } }
    return r;
  });

  
  ipcMain.handle('billing:portal', async (_e, licenseKey?: string) => {
    const r = await callBilling('portal', { license_key: licenseKey });
    if (r.success && typeof r.url === 'string') { try { await shell.openExternal(r.url); } catch {  } }
    return r;
  });
}
