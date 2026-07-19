import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { fetchToken, cacheToken, listLocations } from '../supabase/tokenManager';
import { refreshLicense, computeStatus } from '../supabase/licenseCheck';
import { isSupabaseConfigured } from '../supabase/client';

/**
 * License activation — the onboarding gate for a register.
 *
 * Business-key model: the operator enters their BUSINESS key (one per business).
 *   • A kind='business' key with >1 location prompts a ONE-TIME location picker;
 *     picking a location mints a location-scoped token and LOCKS this kiosk to
 *     that location (kiosk_locked_location_id). There is no in-app way to change
 *     it afterward — only a remote reset from the Owner Console clears it.
 *   • A single-location business auto-selects that location.
 *   • Legacy per-location keys (kind='register') and manager codes activate in one
 *     step exactly as before (no picker).
 *
 * On success the returned JWT carries tenant_id (+ location_id for a kiosk) + tier
 * + features, cached so this install is bound to that tenant/location and can sync.
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

/** Map a jwt-issuer error to a user-facing activation message. */
function activationError(err: unknown): string {
  const msg = String(err);
  if (/\b401\b|invalid or inactive/i.test(msg)) return 'License key invalid or inactive.';
  if (/\b403\b|seat limit/i.test(msg)) {
    return 'This license has reached its machine limit. Free a seat from the Owner Console or contact support to add seats.';
  }
  if (/does not belong to this business/i.test(msg)) return 'That location is not part of this business. Try again.';
  if (/\b429\b/.test(msg)) return 'Too many attempts — wait a minute and try again.';
  return 'Could not reach the license server. Check the internet connection and try again.';
}

/**
 * Complete binding: fetch a token (location-scoped when locationId is given),
 * cache it + the license, and lock the kiosk to the location. Shared by the
 * legacy one-step path and the business-key location-selection path.
 */
async function bindLicense(key: string, locationId: string | null): Promise<{ success: boolean; error?: string; tier?: string | null; features?: string[]; tenant_id?: string }> {
  const { token, expires_at } = await fetchToken(key, locationId);
  const claims = decodeJwtClaims(token);
  if (!claims || !claims.tenant_id) return { success: false, error: 'Invalid response from license server.' };

  cacheToken(token, expires_at);
  if (locationId) {
    writeSetting('kiosk_locked_location_id', locationId);
    writeSetting('kiosk_setup_complete', '1');
  }
  writeSetting('license_key', key); // scopes the cloud license fetch to this key
  writeSetting(
    'license_cache',
    JSON.stringify({
      active: true,
      tier: (claims.tier as string) ?? null,
      features: Array.isArray(claims.features) ? claims.features : [],
      expires_at: null,
      tenant_id: claims.tenant_id,
      location_id: (claims.location_id as string) ?? locationId ?? null,
      license_key: key,
    })
  );
  writeSetting('license_last_check', new Date().toISOString());

  // Pull the full license row (expires_at, display_config, etc.) now that we hold a JWT.
  await refreshLicense().catch(() => {});
  // Pull the business's staff immediately so the provisioned admin credential works
  // right after setup (the login screen expects an existing account, not "create").
  try {
    const { triggerSyncNow } = require('../supabase/sync') as typeof import('../supabase/sync');
    await triggerSyncNow();
  } catch { /* non-fatal — the 60s worker will pull shortly */ }
  const status = computeStatus();
  return { success: true, tier: status.tier, features: status.features, tenant_id: claims.tenant_id as string };
}

export function registerActivationHandlers(): void {
  // Whether cloud onboarding is required (Supabase configured but not yet activated).
  ipcMain.handle('license:activationState', () => ({
    success: true,
    configured: isSupabaseConfigured(),
    activated: isActivated(),
  }));

  // Step 1: validate the key. A multi-location business returns the picker list
  // (needsLocation); everything else binds immediately.
  ipcMain.handle('license:activate', async (_event, licenseKey: string) => {
    const key = String(licenseKey || '').trim();
    if (!key) return { success: false, error: 'Enter your license key.' };
    if (!isSupabaseConfigured()) return { success: false, error: 'Cloud is not configured on this build.' };

    try {
      const { locations, kind } = await listLocations(key);
      if (kind === 'business') {
        if (locations.length === 0) {
          return { success: false, error: 'No locations exist for this business yet. Add one in the Owner Console, then activate this kiosk.' };
        }
        if (locations.length > 1) {
          // Defer binding until the operator picks a location.
          return { success: true, needsLocation: true, locations: locations.map((l) => ({ id: l.id, name: l.name })) };
        }
        // Single location — auto-select and lock.
        return await bindLicense(key, locations[0].id);
      }
      // Legacy per-location register key or manager code: one-step bind, no lock.
      return await bindLicense(key, null);
    } catch (err) {
      return { success: false, error: activationError(err) };
    }
  });

  // Step 2 (business, multi-location): lock this kiosk to the chosen location.
  ipcMain.handle('license:selectLocation', async (_event, licenseKey: string, locationId: string) => {
    const key = String(licenseKey || '').trim();
    const loc = String(locationId || '').trim();
    if (!key || !loc) return { success: false, error: 'Pick a location to continue.' };
    if (!isSupabaseConfigured()) return { success: false, error: 'Cloud is not configured on this build.' };
    try {
      return await bindLicense(key, loc);
    } catch (err) {
      return { success: false, error: activationError(err) };
    }
  });

  // Unbind (switch account / re-key a register, or a remote reset). Clears the
  // kiosk location lock too so setup starts fresh.
  ipcMain.handle('license:deactivate', () => {
    const db = getDb();
    for (const k of ['license_cache', 'license_key', 'auth_token', 'auth_token_exp', 'license_last_check', 'kiosk_locked_location_id', 'kiosk_setup_complete']) {
      try { db.prepare('DELETE FROM settings WHERE key = ?').run(k); } catch { /* ignore */ }
    }
    return { success: true };
  });
}
