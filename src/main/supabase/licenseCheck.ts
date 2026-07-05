import type Database from 'better-sqlite3';
import { getDb } from '../db/schema';
import { getSupabase, isSupabaseConfigured } from './client';

/**
 * License enforcement — local-first with a 72-hour offline grace window.
 *
 * Flow: on launch we load the cached license from the local `settings` table,
 * then attempt a (non-blocking) Supabase refresh. A successful check resets the
 * 72h clock. If Supabase is unreachable we keep running on the cached license
 * until the grace window lapses, then lock to read-only.
 *
 * Local-first guarantee: if Supabase is NOT configured, licensing is disabled
 * entirely (full access) — the POS must never be bricked by an optional cloud
 * feature. Enforcement only applies once a real Supabase project is wired up.
 */

const KEY_LICENSE = 'license_cache'; // JSON LicenseRecord
const KEY_LAST_CHECK = 'license_last_check'; // ISO timestamp of last SUCCESSFUL cloud check
const KEY_LICENSE_ID = 'license_key'; // optional per-install license id to filter on

const GRACE_WARN_HOURS = 48;
const GRACE_LIMIT_HOURS = 72;
const DAILY_MS = 24 * 60 * 60 * 1000;

export interface LicenseRecord {
  active: boolean;
  tier: string | null;
  features: string[];
  expires_at: string | null; // ISO; null = no hard expiry
  tenant_id: string | null; // needed to scope cloud writes (sync worker injects this)
  license_key: string | null;
  // Owner-managed customer-display / ads config, set centrally in the admin console.
  display_config?: { promo_enabled?: boolean; ads?: unknown[]; ads_interval?: number } | null;
}

export type LicenseMode = 'full' | 'read_only';
export type LicenseReason =
  | 'ok' // active, recently verified
  | 'unenforced' // Supabase not configured -> licensing off
  | 'grace_warning' // active but verification overdue (>=48h)
  | 'invalid' // license.active === false
  | 'expired' // past expires_at
  | 'cache_expired' // couldn't verify within 72h (or never verified)
  | 'unlicensed'; // no license on record

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

// Every write action in the system, blocked when the license is read-only. The
// renderer disables the matching buttons; the main process also refuses these
// server-side (no silent failures). This list is intentionally complete so new
// handlers map to an existing action without editing this file again.
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

// ── settings-table helpers (db is injectable for tests) ─────────────────────
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

// ── pure status computation (testable without a DB or network) ──────────────
/**
 * Derive the license status from raw inputs. Kept pure so it can be exercised
 * across every scenario in isolation.
 */
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

  // Cloud not configured -> licensing disabled, full local-first access.
  if (!configured) return full('unenforced', { level: 'none', message: '' });

  // Configured but this install has never held a license yet (pre-provisioning).
  // Do NOT brick it — enforcement kicks in only once a license has been seen and
  // then lapses (invalid / expired / stale cache below).
  if (!cached) return full('unlicensed', { level: 'none', message: '' });

  // Hard states from the license record itself.
  if (!cached.active) return lock('invalid', 'License inactive — contact your administrator');
  if (cached.expires_at && new Date(cached.expires_at).getTime() <= now.getTime()) {
    return lock('expired', 'License inactive — contact your administrator');
  }

  // Grace window based on time since last successful verification.
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

/** Current status from cached state + configuration. */
export function computeStatus(now: Date = new Date(), db: Database.Database = getDb()): LicenseStatus {
  return computeStatusFrom(loadCachedLicense(db), getLastCheck(db), isSupabaseConfigured(), now);
}

// ── write guard (server-side enforcement) ───────────────────────────────────
export function assertWritable(action: WriteAction): { ok: true } | { ok: false; error: string } {
  const status = computeStatus();
  if (!status.readOnly) return { ok: true };
  // Surface the specific reason so callers can show "no silent failures" messaging.
  return { ok: false, error: status.banner.message || 'Action unavailable — license inactive.' };
}

// ── cloud refresh ───────────────────────────────────────────────────────────
function normalize(row: Record<string, unknown>): LicenseRecord {
  const features = row.features;
  return {
    active: Boolean(row.active),
    tier: (row.tier as string) ?? null,
    features: Array.isArray(features) ? (features as string[]) : [],
    expires_at: (row.expires_at as string) ?? null,
    tenant_id: (row.tenant_id as string) ?? null,
    license_key: (row.license_key as string) ?? null,
    display_config: (row.display_config as LicenseRecord['display_config']) ?? null,
  };
}

/** Fetch this install's license from Supabase. Returns null if unreachable/absent. */
export async function fetchLicenseFromCloud(): Promise<LicenseRecord | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  try {
    const licenseId = readSetting(KEY_LICENSE_ID);
    let query = supabase.from('licenses').select('*').limit(1);
    if (licenseId) query = supabase.from('licenses').select('*').eq('id', licenseId).limit(1);
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

/** Refresh from Supabase and, on success, update the cache + reset the 72h clock. */
export async function refreshLicense(): Promise<LicenseStatus> {
  const rec = await fetchLicenseFromCloud();
  if (rec) {
    writeSetting(KEY_LICENSE, JSON.stringify(rec));
    writeSetting(KEY_LAST_CHECK, new Date().toISOString());
    console.log('[license] verified with Supabase — grace clock reset.');
  } else if (isSupabaseConfigured()) {
    console.warn('[license] could not verify with Supabase — using cached license within grace window.');
  }
  return computeStatus();
}

let dailyTimer: NodeJS.Timeout | null = null;

/**
 * Startup hook (step 2–5 of the launch sequence): load cached license, then
 * kick off a non-blocking cloud refresh, and schedule a daily re-check.
 * Returns the immediately-known status (from cache) so the UI can lock/unlock
 * without waiting on the network.
 */
export function startLicenseChecks(): LicenseStatus {
  const initial = computeStatus();
  void refreshLicense().catch(() => {
    /* non-blocking; cached status already returned */
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
