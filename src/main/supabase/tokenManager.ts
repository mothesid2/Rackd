import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from '../db/schema';
import { loadCachedLicense } from './licenseCheck';
import { loadEnv } from './env';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from './publicConfig';


const KEY_TOKEN = 'auth_token';
const KEY_TOKEN_EXP = 'auth_token_exp'; 
const KEY_TOKEN_FETCH_LOG = 'auth_token_last_fetch'; 

const REFRESH_BEFORE_MS = 60 * 60 * 1000; 
const AUTO_CHECK_MS = 15 * 60 * 1000; 

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
  
  
  const base = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || PUBLIC_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || PUBLIC_SUPABASE_ANON_KEY;
  if (!base || !anonKey) return null;
  return { url: `${base.replace(/\/$/, '')}/functions/v1/jwt-issuer`, anonKey };
}


const RESERVED_REGISTER_IDS = new Set(['manager']);


export function getMachineId(db: Database.Database = getDb()): string {
  let id = readSetting('machine_id', db);
  
  if (!id || RESERVED_REGISTER_IDS.has(id)) {
    id = randomUUID();
    writeSetting('machine_id', id, db);
  }
  return id;
}


function kioskLockedLocation(db: Database.Database = getDb()): string | null {
  return readSetting('kiosk_locked_location_id', db);
}


export async function fetchToken(
  licenseKey: string,
  locationId?: string | null
): Promise<{ token: string; expires_at: string }> {
  const cfg = functionUrl();
  if (!cfg) throw new Error('Supabase not configured — cannot fetch auth token.');
  const location = locationId === undefined ? kioskLockedLocation() : locationId;
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
    },
    body: JSON.stringify({ license_key: licenseKey, machine_id: getMachineId(), location_id: location ?? undefined }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`jwt-issuer ${res.status}: ${body || res.statusText}`);
  }
  const data = (await res.json()) as { token: string; expires_at: string };
  if (!data?.token) throw new Error('jwt-issuer returned no token');
  return data;
}


export async function listLocations(
  licenseKey: string
): Promise<{ locations: { id: string; name: string; is_storefront_enabled?: boolean }[]; kind: string; tenant_id: string }> {
  const cfg = functionUrl();
  if (!cfg) throw new Error('Supabase not configured — cannot list locations.');
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: cfg.anonKey,
      Authorization: `Bearer ${cfg.anonKey}`,
    },
    body: JSON.stringify({ license_key: licenseKey, list_locations: true }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`jwt-issuer ${res.status}: ${body || res.statusText}`);
  }
  const data = (await res.json()) as { locations?: { id: string; name: string; is_storefront_enabled?: boolean }[]; kind?: string; tenant_id?: string };
  return { locations: data.locations ?? [], kind: data.kind ?? 'register', tenant_id: data.tenant_id ?? '' };
}


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


export async function getValidToken(db: Database.Database = getDb()): Promise<string> {
  const token = readSetting(KEY_TOKEN, db);
  const expRaw = readSetting(KEY_TOKEN_EXP, db);
  const now = Date.now();
  const expMs = expRaw ? Date.parse(expRaw) : NaN;

  if (token && !Number.isNaN(expMs) && now < expMs - REFRESH_BEFORE_MS) {
    return token; 
  }

  try {
    return await fetchAndCache(db);
  } catch (err) {
    
    if (token && !Number.isNaN(expMs) && now < expMs) {
      writeSetting(KEY_TOKEN_FETCH_LOG, `${new Date().toISOString()} unreachable — using cache`, db);
      return token;
    }
    writeSetting(KEY_TOKEN_FETCH_LOG, `${new Date().toISOString()} failed: ${String(err)}`, db);
    throw new Error(`No valid auth token (issuer unreachable and cache expired): ${String(err)}`);
  }
}

let autoTimer: NodeJS.Timeout | null = null;


export function startTokenAutoRefresh(): void {
  if (autoTimer) return;
  void getValidToken().catch(() => {
    
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
