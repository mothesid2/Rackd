import { ipcMain } from 'electron';
import { computeStatus, refreshLicense, assertWritable, type LicenseStatus, type WriteAction } from '../supabase/licenseCheck';


function shape(s: LicenseStatus) {
  return {
    mode: s.mode,
    readOnly: s.readOnly,
    reason: s.reason,
    tier: s.tier,
    features: s.features,
    banner: s.banner, 
    expires_at: s.expiresAt,
    last_checked_at: s.lastCheckAt,
    cache_age_hours: s.hoursSinceCheck,
  };
}

export function registerLicenseHandlers(): void {
  
  ipcMain.handle('license:status', () => {
    try {
      return { success: true, status: shape(computeStatus()) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('license:refresh', async () => {
    try {
      return { success: true, status: shape(await refreshLicense()) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  ipcMain.handle('license:assert-writable', (_event, action: WriteAction) => {
    const verdict = assertWritable(action);
    if (!verdict.ok) throw new Error(verdict.error);
    return { ok: true };
  });
}
