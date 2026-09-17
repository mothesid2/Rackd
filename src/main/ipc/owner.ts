import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/schema';
import { loadCachedLicense, refreshDisplayConfig } from '../supabase/licenseCheck';
import { loadEnv } from '../supabase/env';


function isDemoBuild(): boolean {
  loadEnv();
  return process.env.DEMO_MODE === '1' || process.env.RACKD_DEMO === '1';
}


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
function deleteSetting(key: string): void {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}

function pinValid(pin: unknown): boolean {
  const hash = readSetting(KEY_PIN);
  return !!hash && bcrypt.compareSync(String(pin ?? ''), hash);
}

interface AdSlide {
  image: string;
  headline: string;
  body: string;
}


function readAds(): AdSlide[] {
  const raw = readSetting('display_ads');
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) {
        return arr.map((s) => ({
          image: String(s?.image || ''),
          headline: String(s?.headline || ''),
          body: String(s?.body || ''),
        }));
      }
    } catch {
      
    }
  }
  
  const lines = (readSetting('display_promo_text') || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const img = readSetting('display_ads_image') || '';
  if (!lines.length && !img) return [];
  return lines.length
    ? lines.map((l, i) => ({ image: i === 0 ? img : '', headline: l, body: '' }))
    : [{ image: img, headline: '', body: '' }];
}

export function registerOwnerHandlers(): void {
  
  ipcMain.handle('app:isDemo', () => ({ success: true, demo: isDemoBuild() }));

  ipcMain.handle('owner:hasPin', () => ({ success: true, hasPin: !!readSetting(KEY_PIN) }));

  
  
  ipcMain.handle('owner:resetPin', () => {
    if (!isDemoBuild()) return { success: false, error: 'PIN reset is only available in the demo build' };
    deleteSetting(KEY_PIN);
    return { success: true };
  });

  ipcMain.handle('owner:verifyPin', (_e, pin: string) => {
    if (!readSetting(KEY_PIN)) return { success: false, error: 'No owner PIN set' };
    return { success: pinValid(pin) };
  });

  
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

  
  
  ipcMain.handle('owner:getDisplayConfig', async () => {
    
    
    try { await refreshDisplayConfig(); } catch {  }
    
    
    const dc = loadCachedLicense()?.display_config;
    if (dc && (dc.promo_enabled || (Array.isArray(dc.ads) && dc.ads.length))) {
      return {
        success: true,
        source: 'cloud',
        config: {
          promo_enabled: !!dc.promo_enabled,
          ads: Array.isArray(dc.ads) ? dc.ads : [],
          ads_interval: Number(dc.ads_interval) || 8,
        },
      };
    }
    return {
      success: true,
      source: 'local',
      config: {
        promo_enabled: readSetting('display_promo_enabled') === '1',
        ads: readAds(),
        ads_interval: Number(readSetting('display_ads_interval')) || 8,
      },
    };
  });

  
  ipcMain.handle(
    'owner:setDisplayConfig',
    (_e, pin: string, config: { promo_enabled?: boolean; ads?: AdSlide[]; ads_interval?: number }) => {
      if (!pinValid(pin)) return { success: false, error: 'Owner PIN required' };
      writeSetting('display_promo_enabled', config?.promo_enabled ? '1' : '0');
      const ads: AdSlide[] = Array.isArray(config?.ads)
        ? config.ads
            .slice(0, 20)
            .map((s) => ({ image: String(s?.image || ''), headline: String(s?.headline || ''), body: String(s?.body || '') }))
            .filter((s) => s.image || s.headline || s.body)
        : [];
      writeSetting('display_ads', JSON.stringify(ads));
      const iv = Math.max(3, Math.min(60, Number(config?.ads_interval) || 8));
      writeSetting('display_ads_interval', String(iv));
      return { success: true };
    }
  );
}
