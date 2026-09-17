import type Database from 'better-sqlite3';
import { getDb } from '../db/schema';
import { getSupabase, isSupabaseConfigured } from './client';



const KEY_LICENSE = 'license_cache'; 
const KEY_LAST_CHECK = 'license_last_check'; 
const KEY_LICENSE_KEY = 'license_key'; 
const KEY_KIOSK_LOCATION = 'kiosk_locked_location_id'; 

const GRACE_WARN_HOURS = 48;
const GRACE_LIMIT_HOURS = 72;
const DAILY_MS = 24 * 60 * 60 * 1000;

export interface LicenseRecord {
  active: boolean;
  tier: string | null;
  features: string[];
  expires_at: string | null; 
  tenant_id: string | null; 
  location_id: string | null; 
  license_key: string | null;
  
  display_config?: { promo_enabled?: boolean; ads?: unknown[]; ads_interval?: number } | null;
  
  
  
  twilio_account_sid?: string | null;
  twilio_auth_token?: string | null;
  twilio_from_number?: string | null;
}

export type LicenseMode = 'full' | 'read_only';
export type LicenseReason =
  | 'ok' 
  | 'unenforced' 
  | 'grace_warning' 
  | 'invalid' 
  | 'expired' 
  | 'cache_expired' 
  | 'unlicensed'; 

export type BannerLevel = 'none' | 'warning' | 'error';

export interface LicenseStatus {
  mode: LicenseMode;
  readOnly: boolean;
  reason: LicenseReason;
  banner: { level: BannerLevel; message: string };
  tier: string | null;
  features: string[];
  lastCheckAt: string | null;
  hoursSinceCheck: number | null;
  expiresAt: string | null;
}


export const BLOCKED_ACTIONS = [
  'sale',
  'return',
  'void',
  'inventory_edit',
  'customer_edit',
  'employee_manage',
  'settings_change',
  'drawer_open',
  'drawer_drop',
  'receipt_print',
  'invoice_edit',
  'sms_send',
  'scan_data_submit',
  'loyalty_redeem',
  'promo_run',
] as const;
export type WriteAction = (typeof BLOCKED_ACTIONS)[number];


function readSetting(key: string, db: Database.Database = getDb()): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

function writeSetting(key: string, value: string, db: Database.Database = getDb()): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

export function loadCachedLicense(db: Database.Database = getDb()): LicenseRecord | null {
  const raw = readSetting(KEY_LICENSE, db);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LicenseRecord;
  } catch {
    return null;
  }
}

function getLastCheck(db: Database.Database = getDb()): Date | null {
  const raw = readSetting(KEY_LAST_CHECK, db);
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}



export function computeStatusFrom(
  cached: LicenseRecord | null,
  lastCheck: Date | null,
  configured: boolean,
  now: Date = new Date()
): LicenseStatus {
  const hoursSinceCheck = lastCheck ? (now.getTime() - lastCheck.getTime()) / 3.6e6 : null;
  const base = {
    tier: cached?.tier ?? null,
    features: cached?.features ?? [],
    lastCheckAt: lastCheck ? lastCheck.toISOString() : null,
    hoursSinceCheck,
    expiresAt: cached?.expires_at ?? null,
  };

  const full = (reason: LicenseReason, banner: LicenseStatus['banner']): LicenseStatus => ({
    mode: 'full',
    readOnly: false,
    reason,
    banner,
    ...base,
  });
  const lock = (reason: LicenseReason, message: string): LicenseStatus => ({
    mode: 'read_only',
    readOnly: true,
    reason,
    banner: { level: 'error', message },
    ...base,
  });

  
  if (!configured) return full('unenforced', { level: 'none', message: '' });

  
  
  
  if (!cached) return full('unlicensed', { level: 'none', message: '' });

  
  if (!cached.active) return lock('invalid', 'License inactive — contact your administrator');
  if (cached.expires_at && new Date(cached.expires_at).getTime() <= now.getTime()) {
    return lock('expired', 'License inactive — contact your administrator');
  }

  
  if (hoursSinceCheck === null || hoursSinceCheck >= GRACE_LIMIT_HOURS) {
    return lock('cache_expired', 'Unable to verify license — reconnect to the internet to continue');
  }
  if (hoursSinceCheck >= GRACE_WARN_HOURS) {
    return full('grace_warning', {
      level: 'warning',
      message: 'License verification overdue — connect to internet soon to avoid interruption',
    });
  }

  return full('ok', { level: 'none', message: '' });
}


export function computeStatus(now: Date = new Date(), db: Database.Database = getDb()): LicenseStatus {
  return computeStatusFrom(loadCachedLicense(db), getLastCheck(db), isSupabaseConfigured(), now);
}


export function assertWritable(action: WriteAction): { ok: true } | { ok: false; error: string } {
  const status = computeStatus();
  if (!status.readOnly) return { ok: true };
  
  return { ok: false, error: status.banner.message || 'Action unavailable — license inactive.' };
}


function normalize(row: Record<string, unknown>): LicenseRecord {
  const features = row.features;
  return {
    active: Boolean(row.active),
    tier: (row.tier as string) ?? null,
    features: Array.isArray(features) ? (features as string[]) : [],
    expires_at: (row.expires_at as string) ?? null,
    tenant_id: (row.tenant_id as string) ?? null,
    location_id: (row.location_id as string) ?? null,
    license_key: (row.license_key as string) ?? null,
    display_config: (row.display_config as LicenseRecord['display_config']) ?? null,
    twilio_account_sid: (row.twilio_account_sid as string) ?? null,
    twilio_auth_token: (row.twilio_auth_token as string) ?? null,
    twilio_from_number: (row.twilio_from_number as string) ?? null,
  };
}


export function getKioskLock(db: Database.Database = getDb()): string | null {
  return readSetting(KEY_KIOSK_LOCATION, db) ?? null;
}


export async function fetchLicenseFromCloud(): Promise<LicenseRecord | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    
    
    
    const licenseKey = readSetting(KEY_LICENSE_KEY);
    let query = supabase.from('licenses').select('*').limit(1);
    if (licenseKey) query = supabase.from('licenses').select('*').eq('license_key', licenseKey).limit(1);
    const { data, error } = await query.maybeSingle();
    if (error) {
      console.warn('[license] cloud fetch error:', error.message);
      return null;
    }
    return data ? normalize(data as Record<string, unknown>) : null;
  } catch (err) {
    console.warn('[license] cloud fetch failed:', String(err));
    return null;
  }
}


export async function refreshLicense(): Promise<LicenseStatus> {
  const rec = await fetchLicenseFromCloud();
  if (rec) {
    
    
    
    const lock = getKioskLock();
    if (lock && !rec.location_id) rec.location_id = lock;
    writeSetting(KEY_LICENSE, JSON.stringify(rec));
    writeSetting(KEY_LAST_CHECK, new Date().toISOString());
    
    
    
    writeSetting('twilio_account_sid', rec.twilio_account_sid ?? '');
    writeSetting('twilio_auth_token', rec.twilio_auth_token ?? '');
    writeSetting('twilio_from_number', rec.twilio_from_number ?? '');
    console.log('[license] verified with Supabase — grace clock reset.');
  } else if (isSupabaseConfigured()) {
    console.warn('[license] could not verify with Supabase — using cached license within grace window.');
  }
  return computeStatus();
}


let lastDisplayRefresh = 0;
export async function refreshDisplayConfig(minIntervalMs = 15000): Promise<void> {
  if (!isSupabaseConfigured()) return;
  const now = Date.now();
  if (now - lastDisplayRefresh < minIntervalMs) return;
  lastDisplayRefresh = now;
  const rec = await fetchLicenseFromCloud();
  if (!rec) return; 
  const cached = loadCachedLicense();
  if (cached) {
    
    cached.display_config = rec.display_config ?? null;
    writeSetting(KEY_LICENSE, JSON.stringify(cached));
  } else {
    writeSetting(KEY_LICENSE, JSON.stringify(rec));
  }
}

let dailyTimer: NodeJS.Timeout | null = null;


export function startLicenseChecks(): LicenseStatus {
  const initial = computeStatus();
  void refreshLicense().catch(() => {
    
  });
  if (!dailyTimer && isSupabaseConfigured()) {
    dailyTimer = setInterval(() => void refreshLicense().catch(() => {}), DAILY_MS);
  }
  return initial;
}

export function stopLicenseChecks(): void {
  if (dailyTimer) {
    clearInterval(dailyTimer);
    dailyTimer = null;
  }
}
