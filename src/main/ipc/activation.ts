import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { fetchToken, cacheToken, listLocations } from '../supabase/tokenManager';
import { refreshLicense, computeStatus } from '../supabase/licenseCheck';
import { isSupabaseConfigured } from '../supabase/client';


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


export function isActivated(): boolean {
  const raw = readSetting('license_cache');
  if (!raw) return false;
  try {
    return !!(JSON.parse(raw) as { license_key?: string }).license_key;
  } catch {
    return false;
  }
}


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


async function bindLicense(key: string, locationId: string | null): Promise<{ success: boolean; error?: string; tier?: string | null; features?: string[]; tenant_id?: string }> {
  const { token, expires_at } = await fetchToken(key, locationId);
  const claims = decodeJwtClaims(token);
  if (!claims || !claims.tenant_id) return { success: false, error: 'Invalid response from license server.' };

  cacheToken(token, expires_at);
  if (locationId) {
    writeSetting('kiosk_locked_location_id', locationId);
    writeSetting('kiosk_setup_complete', '1');
  }
  writeSetting('license_key', key); 
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

  
  await refreshLicense().catch(() => {});
  
  
  try {
    const { triggerSyncNow, resyncAllInventory } = require('../supabase/sync') as typeof import('../supabase/sync');
    
    resyncAllInventory();
    await triggerSyncNow();
  } catch {  }
  const status = computeStatus();
  return { success: true, tier: status.tier, features: status.features, tenant_id: claims.tenant_id as string };
}

export function registerActivationHandlers(): void {
  
  ipcMain.handle('license:activationState', () => ({
    success: true,
    configured: isSupabaseConfigured(),
    activated: isActivated(),
  }));

  
  
  ipcMain.handle('license:activate', async (_event, licenseKey: string) => {
    
    
    
    
    
    const key = String(licenseKey || '').trim().toUpperCase();
    if (!key) return { success: false, error: 'Enter your license key.' };
    if (!isSupabaseConfigured()) return { success: false, error: 'Cloud is not configured on this build.' };

    try {
      const { locations, kind } = await listLocations(key);
      if (kind === 'business') {
        if (locations.length === 0) {
          return { success: false, error: 'No locations exist for this business yet. Add one in the Owner Console, then activate this kiosk.' };
        }
        if (locations.length > 1) {
          
          return { success: true, needsLocation: true, locations: locations.map((l) => ({ id: l.id, name: l.name })) };
        }
        
        return await bindLicense(key, locations[0].id);
      }
      
      return await bindLicense(key, null);
    } catch (err) {
      return { success: false, error: activationError(err) };
    }
  });

  
  ipcMain.handle('license:selectLocation', async (_event, licenseKey: string, locationId: string) => {
    const key = String(licenseKey || '').trim().toUpperCase();
    const loc = String(locationId || '').trim();
    if (!key || !loc) return { success: false, error: 'Pick a location to continue.' };
    if (!isSupabaseConfigured()) return { success: false, error: 'Cloud is not configured on this build.' };
    try {
      return await bindLicense(key, loc);
    } catch (err) {
      return { success: false, error: activationError(err) };
    }
  });

  
  
  ipcMain.handle('license:deactivate', () => {
    const db = getDb();
    for (const k of ['license_cache', 'license_key', 'auth_token', 'auth_token_exp', 'license_last_check', 'kiosk_locked_location_id', 'kiosk_setup_complete']) {
      try { db.prepare('DELETE FROM settings WHERE key = ?').run(k); } catch {  }
    }
    return { success: true };
  });
}
