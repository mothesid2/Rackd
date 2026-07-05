import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { fetchToken, cacheToken } from '../supabase/tokenManager';
import { refreshLicense, computeStatus } from '../supabase/licenseCheck';
import { isSupabaseConfigured } from '../supabase/client';

/**
 * License activation — the onboarding gate for a register.
 *
 * The operator enters their license key (tied to their account/tenant). We
 * validate it against the jwt-issuer Edge Function; on success the returned JWT
 * carries tenant_id + tier + features, which we cache so this install is now
 * bound to that tenant and can sync to the cloud. Multiple registers activated
 * with the same key share a tenant_id and therefore the same cloud data.
 *
 * The same key → tenant → tier/features model is what the (future) Vercel web
 * store and phone reporting app will reuse.
 */
function writeSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
function readSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

function decodeJwtClaims(token: string): Record<string, unknown> | null {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Synchronous check used by the boot sequence: is this install bound to a license? */
export function isActivated(): boolean {
  const raw = readSetting('license_cache');
  if (!raw) return false;
  try {
    return !!(JSON.parse(raw) as { license_key?: string }).license_key;
  } catch {
    return false;
  }
}

export function registerActivationHandlers(): void {
  // Whether cloud onboarding is required (Supabase configured but not yet activated).
  ipcMain.handle('license:activationState', () => ({
    success: true,
    configured: isSupabaseConfigured(),
    activated: isActivated(),
  }));

  // Bind this install to a license key.
  ipcMain.handle('license:activate', async (_event, licenseKey: string) => {
    const key = String(licenseKey || '').trim();
    if (!key) return { success: false, error: 'Enter your license key.' };
    if (!isSupabaseConfigured()) return { success: false, error: 'Cloud is not configured on this build.' };

    try {
      const { token, expires_at } = await fetchToken(key);
      const claims = decodeJwtClaims(token);
      if (!claims || !claims.tenant_id) return { success: false, error: 'Invalid response from license server.' };

      cacheToken(token, expires_at);
      writeSetting(
        'license_cache',
        JSON.stringify({
          active: true,
          tier: (claims.tier as string) ?? null,
          features: Array.isArray(claims.features) ? claims.features : [],
          expires_at: null,
          tenant_id: claims.tenant_id,
          license_key: key,
        })
      );
      writeSetting('license_last_check', new Date().toISOString());

      // Pull the full license row (expires_at, etc.) now that we hold a JWT.
      await refreshLicense().catch(() => {});
      const status = computeStatus();
      return { success: true, tier: status.tier, features: status.features, tenant_id: claims.tenant_id };
    } catch (err) {
      const msg = String(err);
      if (/\b401\b|invalid or inactive/i.test(msg)) return { success: false, error: 'License key invalid or inactive.' };
      if (/\b403\b|seat limit/i.test(msg)) {
        return { success: false, error: 'This license has reached its machine limit. Deactivate another register or contact support to add seats.' };
      }
      if (/\b429\b/.test(msg)) return { success: false, error: 'Too many attempts — wait a minute and try again.' };
      return { success: false, error: 'Could not reach the license server. Check the internet connection and try again.' };
    }
  });

  // Unbind (switch account / re-key a register). Owner action.
  ipcMain.handle('license:deactivate', () => {
    const db = getDb();
    for (const k of ['license_cache', 'license_key', 'auth_token', 'auth_token_exp', 'license_last_check']) {
      try { db.prepare('DELETE FROM settings WHERE key = ?').run(k); } catch { /* ignore */ }
    }
    return { success: true };
  });
}
