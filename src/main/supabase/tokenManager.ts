import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/schema';
import { loadCachedLicense } from './licenseCheck';
import { loadEnv } from './env';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from './publicConfig';

/**
 * Per-install auth token lifecycle. Fetches a signed JWT from the jwt-issuer
 * Edge Function, caches it (with expiry) in the local `settings` table, and
 * serves a valid token to the Supabase client — refreshing proactively 1h
 * before expiry and tolerating the Edge Function being briefly unreachable by
 * falling back to the still-valid cached token.
 *
 * When no valid token can be produced, getValidToken() throws so the client
 * falls back to anon (RLS blocks) and the license engine can lock to read-only.
 */
const KEY_TOKEN = 'auth_token';
const KEY_TOKEN_EXP = 'auth_token_exp'; // ISO string
const KEY_TOKEN_FETCH_LOG = 'auth_token_last_fetch'; // for diagnostics/startup log

const REFRESH_BEFORE_MS = 60 * 60 * 1000; // refresh within 1h of expiry
const AUTO_CHECK_MS = 15 * 60 * 1000; // re-check every 15 min

function readSetting(key: string, db: Database.Database = getDb()): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}
function writeSetting(key: string, value: string, db: Database.Database = getDb()): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}

function functionUrl(): { url: string; anonKey: string } | null {
  loadEnv();
  // .env overrides in dev; otherwise the baked public config (so the packaged
  // installer can reach the Edge Function without a local .env).
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !anonKey) return null;
  return { url: `${base.replace(/\/$/, '')}/functions/v1/jwt-issuer`, anonKey };
}

/** Stable per-install id used to count/limit machines (seats) per license key. */
export function getMachineId(db: Database.Database = getDb()): string {
  let id = readSetting('machine_id', db);
  if (!id) {
    id = randomUUID();
    writeSetting('machine_id', id, db);
  }
  return id;
}

/** Call the jwt-issuer Edge Function and return the signed token + expiry. */
export async function fetchToken(licenseKey: string): Promise<{ token: string; expires_at: string }> {
  const cfg = functionUrl();
  if (!cfg) throw new Error('Supabase not configured — cannot fetch auth token.');
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
    },
    body: JSON.stringify({ license_key: licenseKey, machine_id: getMachineId() }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`jwt-issuer ${res.status}: ${body || res.statusText}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  if (!data?.token) throw new Error('jwt-issuer returned no token');
  return data;
}

/** Persist a token + expiry to the local settings table. */
export function cacheToken(token: string, expiresAt: string, db: Database.Database = getDb()): void {
  writeSetting(KEY_TOKEN, token, db);
  writeSetting(KEY_TOKEN_EXP, expiresAt, db);
}

function licenseKeyFromCache(db: Database.Database): string | null {
  return loadCachedLicense(db)?.license_key ?? null;
}

async function fetchAndCache(db: Database.Database): Promise<string> {
  const licenseKey = licenseKeyFromCache(db);
  if (!licenseKey) throw new Error('No license_key cached — run a license check first.');
  const { token, expires_at } = await fetchToken(licenseKey);
  cacheToken(token, expires_at, db);
  writeSetting(KEY_TOKEN_FETCH_LOG, `${new Date().toISOString()} ok`, db);
  return token;
}

/**
 * Return a usable token:
 *  - cached token with >1h remaining -> use it
 *  - within 1h of expiry or expired   -> fetch fresh
 *  - Edge Function unreachable         -> fall back to cached if still valid
 *  - cached also expired/absent        -> throw (client falls back to anon; lockdown)
 */
export async function getValidToken(db: Database.Database = getDb()): Promise<string> {
  const token = readSetting(KEY_TOKEN, db);
  const expRaw = readSetting(KEY_TOKEN_EXP, db);
  const now = Date.now();
  const expMs = expRaw ? Date.parse(expRaw) : NaN;

  if (token && !Number.isNaN(expMs) && now < expMs - REFRESH_BEFORE_MS) {
    return token; // comfortably valid
  }

  try {
    return await fetchAndCache(db);
  } catch (err) {
    // Unreachable/failed: use the cached token if it hasn't expired yet.
    if (token && !Number.isNaN(expMs) && now < expMs) {
      writeSetting(KEY_TOKEN_FETCH_LOG, `${new Date().toISOString()} unreachable — using cache`, db);
      return token;
    }
    writeSetting(KEY_TOKEN_FETCH_LOG, `${new Date().toISOString()} failed: ${String(err)}`, db);
    throw new Error(`No valid auth token (issuer unreachable and cache expired): ${String(err)}`);
  }
}

let autoTimer: NodeJS.Timeout | null = null;

/** Start proactive refresh: tries getValidToken now and every 15 min (refreshes within 1h of expiry). */
export function startTokenAutoRefresh(): void {
  if (autoTimer) return;
  void getValidToken().catch(() => {
    /* non-blocking; logged to settings */
  });
  autoTimer = setInterval(() => {
    void getValidToken().catch(() => {});
  }, AUTO_CHECK_MS);
}

export function stopTokenAutoRefresh(): void {
  if (autoTimer) {
    clearInterval(autoTimer);
    autoTimer = null;
  }
}

export function lastTokenFetchLog(db: Database.Database = getDb()): string | null {
  return readSetting(KEY_TOKEN_FETCH_LOG, db);
}
