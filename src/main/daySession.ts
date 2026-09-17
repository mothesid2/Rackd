import type Database from 'better-sqlite3';
import { DateTime } from 'luxon';
import { getDb } from './db/schema';


const DEFAULT_TZ = 'America/Chicago';
function businessTZ(db: Database.Database): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'business_timezone'`).get() as { value: string } | undefined;
  return row?.value?.trim() || DEFAULT_TZ;
}



const IDLE_LIMIT_MS = 15 * 60 * 1000; 

const KEY_OPEN = 'day_session_open';
const KEY_OPENED_AT = 'day_session_opened_at';
const KEY_OPENED_BY_ID = 'day_session_opened_by_id';
const KEY_OPENED_BY_NAME = 'day_session_opened_by_name';

function readSetting(key: string, db: Database.Database = getDb()): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
function writeSetting(key: string, value: string, db: Database.Database = getDb()): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}
function deleteSetting(key: string, db: Database.Database = getDb()): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}


export function isDayOpen(db: Database.Database = getDb()): boolean {
  return readSetting(KEY_OPEN, db) === '1';
}

export interface DayInfo {
  open: boolean;
  openedAt: string | null;
  openedById: number | null;
  openedByName: string | null;
}
export function dayInfo(db: Database.Database = getDb()): DayInfo {
  const raw = readSetting(KEY_OPENED_AT, db);
  return {
    open: isDayOpen(db),
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    openedAt: raw ? (DateTime.fromISO(raw).setZone(businessTZ(db)).toISO() as string) : null,
    openedById: readSetting(KEY_OPENED_BY_ID, db) ? Number(readSetting(KEY_OPENED_BY_ID, db)) : null,
    openedByName: readSetting(KEY_OPENED_BY_NAME, db),
  };
}


export function openDay(managerId: number | null, managerName: string, db: Database.Database = getDb()): void {
  writeSetting(KEY_OPEN, '1', db);
  
  
  writeSetting(KEY_OPENED_AT, DateTime.now().setZone(businessTZ(db)).toISO() as string, db);
  writeSetting(KEY_OPENED_BY_ID, managerId == null ? '' : String(managerId), db);
  writeSetting(KEY_OPENED_BY_NAME, managerName, db);
}


export function openDayAutomatic(db: Database.Database = getDb()): void {
  openDay(null, 'Automatic (batch time)', db);
}


export function closeDay(db: Database.Database = getDb()): void {
  for (const k of [KEY_OPEN, KEY_OPENED_AT, KEY_OPENED_BY_ID, KEY_OPENED_BY_NAME]) deleteSetting(k, db);
  clearActivity();
}


let lastActivityAt = 0;

export function touchActivity(): void {
  lastActivityAt = Date.now();
}
export function clearActivity(): void {
  lastActivityAt = 0;
}
export function idleElapsedMs(): number {
  return lastActivityAt ? Date.now() - lastActivityAt : 0;
}

export function isIdleLocked(): boolean {
  return lastActivityAt > 0 && Date.now() - lastActivityAt > IDLE_LIMIT_MS;
}

export const IDLE_LIMIT = IDLE_LIMIT_MS;
