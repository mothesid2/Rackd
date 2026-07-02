import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/schema';

/**
 * Owner gate — a PIN only the business owner knows, separate from the client's
 * manager login. Guards owner-only configuration (customer-display / ads /
 * rebates) so a store manager cannot change it. The PIN is stored hashed in the
 * local settings table.
 */
const KEY_PIN = 'owner_pin_hash';

function readSetting(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
function writeSetting(key: string, value: string): void {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}

function pinValid(pin: unknown): boolean {
  const hash = readSetting(KEY_PIN);
  return !!hash && bcrypt.compareSync(String(pin ?? ''), hash);
}

export function registerOwnerHandlers(): void {
  ipcMain.handle('owner:hasPin', () => ({ success: true, hasPin: !!readSetting(KEY_PIN) }));

  ipcMain.handle('owner:verifyPin', (_e, pin: string) => {
    if (!readSetting(KEY_PIN)) return { success: false, error: 'No owner PIN set' };
    return { success: pinValid(pin) };
  });

  // Create or change the owner PIN. If one exists, the current PIN is required.
  ipcMain.handle('owner:setPin', (_e, newPin: string, currentPin?: string) => {
    try {
      const existing = readSetting(KEY_PIN);
      if (existing && !bcrypt.compareSync(String(currentPin ?? ''), existing)) {
        return { success: false, error: 'Current owner PIN is incorrect' };
      }
      if (!newPin || String(newPin).length < 4) {
        return { success: false, error: 'PIN must be at least 4 digits' };
      }
      writeSetting(KEY_PIN, bcrypt.hashSync(String(newPin), 10));
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Owner-only customer-display config: rotating ad/rebate messages + optional
  // banner image shown on the idle display.
  ipcMain.handle('owner:getDisplayConfig', () => ({
    success: true,
    config: {
      promo_enabled: readSetting('display_promo_enabled') === '1',
      promo_text: readSetting('display_promo_text') || '', // one ad/rebate message per line
      ads_image: readSetting('display_ads_image') || '',
      ads_interval: Number(readSetting('display_ads_interval')) || 8, // seconds per slide
    },
  }));

  // Writing the config is PIN-guarded server-side, not just hidden in the UI.
  ipcMain.handle(
    'owner:setDisplayConfig',
    (_e, pin: string, config: { promo_enabled?: boolean; promo_text?: string; ads_image?: string; ads_interval?: number }) => {
      if (!pinValid(pin)) return { success: false, error: 'Owner PIN required' };
      writeSetting('display_promo_enabled', config?.promo_enabled ? '1' : '0');
      writeSetting('display_promo_text', String(config?.promo_text || ''));
      writeSetting('display_ads_image', String(config?.ads_image || ''));
      const iv = Math.max(3, Math.min(60, Number(config?.ads_interval) || 8));
      writeSetting('display_ads_interval', String(iv));
      return { success: true };
    }
  );
}
