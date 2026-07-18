import type Database from 'better-sqlite3';
import { getDb } from './db/schema';

/**
 * POS session model (item 2).
 *
 * Two layers sit on top of the existing auth/permission system:
 *
 *  1. BUSINESS-DAY session (kiosk-level, persisted in `settings`): opened by the
 *     first FULL manager username/password login of the day and kept open — across
 *     app restarts — until the kiosk is explicitly closed out (Z-report / end-of-day).
 *     While it's open, staff sign in with just their PIN; once it's closed, the next
 *     sign-in again requires a manager username + password.
 *
 *  2. Inactivity re-auth (in-memory): after 15 minutes with no activity, the acting
 *     employee must re-enter their PIN before the next action. This re-authenticates
 *     the employee session only — it does NOT close the day or drop back to the
 *     manager username/password login.
 *
 * This module owns only the day-open flags + the activity clock (pure, no imports of
 * auth/permissions) so it can be used from both without an import cycle.
 */

const IDLE_LIMIT_MS = 15 * 60 * 1000; // 15 minutes

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

// ── business-day session (persisted) ────────────────────────────────────────
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
  return {
    open: isDayOpen(db),
    openedAt: readSetting(KEY_OPENED_AT, db),
    openedById: readSetting(KEY_OPENED_BY_ID, db) ? Number(readSetting(KEY_OPENED_BY_ID, db)) : null,
    openedByName: readSetting(KEY_OPENED_BY_NAME, db),
  };
}

/** Open the business day (called on the first manager username/password login). */
export function openDay(managerId: number, managerName: string, db: Database.Database = getDb()): void {
  writeSetting(KEY_OPEN, '1', db);
  writeSetting(KEY_OPENED_AT, new Date().toISOString(), db);
  writeSetting(KEY_OPENED_BY_ID, String(managerId), db);
  writeSetting(KEY_OPENED_BY_NAME, managerName, db);
}

/** Close the business day (Z-report / explicit end-of-day). Next sign-in needs a manager. */
export function closeDay(db: Database.Database = getDb()): void {
  for (const k of [KEY_OPEN, KEY_OPENED_AT, KEY_OPENED_BY_ID, KEY_OPENED_BY_NAME]) deleteSetting(k, db);
  clearActivity();
}

// ── inactivity clock (in-memory) ────────────────────────────────────────────
// 0 = no active employee session (nothing to lock). Set on every sign-in / touch.
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
/** True once an employee has been idle past the limit (needs a PIN re-auth). */
export function isIdleLocked(): boolean {
  return lastActivityAt > 0 && Date.now() - lastActivityAt > IDLE_LIMIT_MS;
}

export const IDLE_LIMIT = IDLE_LIMIT_MS;
