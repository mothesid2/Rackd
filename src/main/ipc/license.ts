import { ipcMain } from 'electron';
import { computeStatus, refreshLicense, assertWritable, type LicenseStatus, type WriteAction } from '../supabase/licenseCheck';

/** Shape the internal LicenseStatus into the flat object the renderer expects. */
function shape(s: LicenseStatus) {
  return {
    mode: s.mode,
    readOnly: s.readOnly,
    reason: s.reason,
    tier: s.tier,
    features: s.features,
    banner: s.banner, // { level, message }
    expires_at: s.expiresAt,
    last_checked_at: s.lastCheckAt,
    cache_age_hours: s.hoursSinceCheck,
  };
}

export function registerLicenseHandlers(): void {
  // Current license state (from cache; instant, no network).
  ipcMain.handle('license:status', () => {
    try {
      return { success: true, status: shape(computeStatus()) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Force a fresh check from Supabase, ignoring the cache; resets the 72h clock.
  ipcMain.handle('license:refresh', async () => {
    try {
      return { success: true, status: shape(await refreshLicense()) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Server-side write guard. Throws (rejects the IPC promise) with the exact
  // reason when read-only, so callers can surface the lockdown message.
  ipcMain.handle('license:assert-writable', (_event, action: WriteAction) => {
    const verdict = assertWritable(action);
    if (!verdict.ok) throw new Error(verdict.error);
    return { ok: true };
  });
}
