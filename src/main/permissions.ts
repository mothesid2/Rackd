import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getDb } from './db/schema';
import { getCurrentSession } from './ipc/auth';
import { nowCT } from './utils/time';
import { getMachineId } from './supabase/tokenManager';
import { enqueueOverrideLog } from './supabase/sync';



export const PERMISSION_KEYS = [
  'apply_discount', 'process_refund', 'override_price', 'inventory_adjust',
  'view_reports', 'manage_rebates', 'open_drawer_no_sale', 'clock_others',
] as const;
export type PermissionKey = (typeof PERMISSION_KEYS)[number];


export const MENU_KEYS = [
  'access_merchandise', 'access_receipts', 'access_customer_lookup', 'access_pickups',
] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

const MAX_PIN_FAILS = 5;
const LOCKOUT_MINUTES = 5;

function readSetting(db: Database.Database, key: string): string | null {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
function writeSetting(db: Database.Database, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export interface EmployeeRef { id: number; uid: string; name: string; username: string; role: string; }

export function getEmployee(db: Database.Database, userId: number): EmployeeRef | null {
  const u = db.prepare('SELECT id, uid, name, username, role FROM users WHERE id = ?').get(userId) as
    | { id: number; uid: string | null; name: string | null; username: string; role: string } | undefined;
  if (!u) return null;
  return { id: u.id, uid: u.uid || '', name: u.name || u.username, username: u.username, role: u.role };
}


export function userHasPermission(db: Database.Database, userId: number, key: PermissionKey): { granted: boolean; value: number | null } {
  const u = db.prepare('SELECT uid, role FROM users WHERE id = ?').get(userId) as { uid: string; role: string } | undefined;
  if (!u) return { granted: false, value: null };
  if (u.role === 'manager') return { granted: true, value: null };
  const p = db.prepare('SELECT is_granted, value FROM employee_permissions WHERE employee_uid = ? AND permission_key = ?')
    .get(u.uid, key) as { is_granted: number; value: number | null } | undefined;
  return { granted: !!p?.is_granted, value: p?.value ?? null };
}


export function permissionsForUser(db: Database.Database, userId: number): Record<string, { granted: boolean; value: number | null }> {
  const out: Record<string, { granted: boolean; value: number | null }> = {};
  for (const k of PERMISSION_KEYS) out[k] = userHasPermission(db, userId, k);
  return out;
}


export function menuAccessForUser(db: Database.Database, userId: number, key: MenuKey): boolean {
  const u = db.prepare('SELECT uid, role FROM users WHERE id = ?').get(userId) as { uid: string; role: string } | undefined;
  if (!u) return false;
  if (u.role === 'manager' || u.role === 'admin') return true;
  const p = db.prepare('SELECT is_granted FROM employee_permissions WHERE employee_uid = ? AND permission_key = ?')
    .get(u.uid, key) as { is_granted: number } | undefined;
  return p === undefined ? true : !!p.is_granted;
}


export function menuAccessForUserAll(db: Database.Database, userId: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of MENU_KEYS) out[k] = menuAccessForUser(db, userId, k);
  return out;
}


export function pinLockState(db: Database.Database): { locked: boolean; until: string | null } {
  const until = readSetting(db, 'pin_locked_until');
  if (until && new Date(until).getTime() > Date.now()) return { locked: true, until };
  return { locked: false, until: null };
}
function recordPinFail(db: Database.Database, context: string): string | null {
  const n = (parseInt(readSetting(db, 'pin_fail_count') || '0', 10) || 0) + 1;
  writeSetting(db, 'pin_fail_count', String(n));
  if (n >= MAX_PIN_FAILS) {
    const until = new Date(Date.now() + LOCKOUT_MINUTES * 60000).toISOString();
    writeSetting(db, 'pin_locked_until', until);
    writeSetting(db, 'pin_fail_count', '0');
    logEvent(db, { action_attempted: context, was_approved: false, event_type: 'pin_lockout' });
    return until;
  }
  return null;
}
function resetPinFail(db: Database.Database): void {
  writeSetting(db, 'pin_fail_count', '0');
  writeSetting(db, 'pin_locked_until', '');
}


export interface LogEntry {
  acting_employee_uid?: string | null; acting_employee_name?: string | null;
  action_attempted: string; required_permission?: string | null;
  authorizing_manager_uid?: string | null; authorizing_manager_name?: string | null;
  was_approved: boolean; event_type?: 'override' | 'pin_lockout'; transaction_id?: number | null;
}
export function logEvent(db: Database.Database, e: LogEntry): void {
  const uid = randomUUID();
  db.prepare(
    `INSERT INTO permission_override_log (uid, at, acting_employee_uid, acting_employee_name, action_attempted,
       required_permission, authorizing_manager_uid, authorizing_manager_name, was_approved, event_type, transaction_id, register_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    uid, nowCT(), e.acting_employee_uid ?? null, e.acting_employee_name ?? null, e.action_attempted,
    e.required_permission ?? null, e.authorizing_manager_uid ?? null, e.authorizing_manager_name ?? null,
    e.was_approved ? 1 : 0, e.event_type || 'override', e.transaction_id ?? null, getMachineId(db)
  );
  try { enqueueOverrideLog(uid, db); } catch {  }
}



export function verifyPin(db: Database.Database, pin: string): { ok: boolean; employee?: EmployeeRef; error?: string; lockedUntil?: string } {
  const lock = pinLockState(db);
  if (lock.locked) return { ok: false, error: 'PIN entry is locked. Try again shortly.', lockedUntil: lock.until || undefined };
  const pinStr = String(pin || '');
  if (!pinStr) return { ok: false, error: 'Enter a PIN' };
  const rows = db.prepare("SELECT id, uid, name, username, role, pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND pin_hash <> ''")
    .all() as { id: number; uid: string; name: string | null; username: string; role: string; pin_hash: string }[];
  for (const u of rows) {
    if (bcrypt.compareSync(pinStr, u.pin_hash)) {
      resetPinFail(db);
      return { ok: true, employee: { id: u.id, uid: u.uid, name: u.name || u.username, username: u.username, role: u.role } };
    }
  }
  const until = recordPinFail(db, 'sign_in');
  return { ok: false, error: until ? 'Too many attempts — PIN entry locked.' : 'Incorrect PIN', lockedUntil: until || undefined };
}


export function verifyPinForUser(
  db: Database.Database,
  userId: number,
  pin: string
): { ok: boolean; employee?: EmployeeRef; error?: string; lockedUntil?: string } {
  const lock = pinLockState(db);
  if (lock.locked) return { ok: false, error: 'PIN entry is locked. Try again shortly.', lockedUntil: lock.until || undefined };
  const pinStr = String(pin || '');
  if (!pinStr) return { ok: false, error: 'Enter a PIN' };
  const u = db.prepare("SELECT id, uid, name, username, role, pin_hash FROM users WHERE id = ? AND is_active = 1 AND pin_hash IS NOT NULL AND pin_hash <> ''")
    .get(userId) as { id: number; uid: string; name: string | null; username: string; role: string; pin_hash: string } | undefined;
  if (u && bcrypt.compareSync(pinStr, u.pin_hash)) {
    resetPinFail(db);
    return { ok: true, employee: { id: u.id, uid: u.uid, name: u.name || u.username, username: u.username, role: u.role } };
  }
  const until = recordPinFail(db, 'sign_in');
  return { ok: false, error: until ? 'Too many attempts — PIN entry locked.' : 'Incorrect PIN', lockedUntil: until || undefined };
}


function verifyManagerPin(db: Database.Database, pin: string): EmployeeRef | null {
  if (pinLockState(db).locked) return null;
  const rows = db.prepare("SELECT id, uid, name, username, role, pin_hash FROM users WHERE is_active = 1 AND role = 'manager' AND pin_hash IS NOT NULL AND pin_hash <> ''")
    .all() as { id: number; uid: string; name: string | null; username: string; role: string; pin_hash: string }[];
  for (const m of rows) {
    if (bcrypt.compareSync(String(pin || ''), m.pin_hash)) {
      resetPinFail(db);
      return { id: m.id, uid: m.uid, name: m.name || m.username, username: m.username, role: m.role };
    }
  }
  recordPinFail(db, 'override');
  return null;
}


export interface PermCtx { override?: string; action: string; transactionId?: number; requestedValue?: number; }
export interface PermResult { ok: boolean; error?: string; needsOverride?: boolean; viaOverride?: boolean; needsReauth?: boolean; }


export function requirePermission(key: PermissionKey, ctx: PermCtx, db: Database.Database = getDb()): PermResult {
  
  
  
  const { isIdleLocked } = require('./daySession') as typeof import('./daySession');
  if (isIdleLocked()) return { ok: false, needsReauth: true, error: 'Session locked after inactivity — re-enter your PIN to continue.' };

  const session = getCurrentSession();
  const actor = session?.userId ? getEmployee(db, session.userId) : null;
  const eff = session?.userId ? userHasPermission(db, session.userId, key) : { granted: false, value: null };

  
  const overCap = key === 'apply_discount' && eff.granted && eff.value != null && ctx.requestedValue != null && ctx.requestedValue > eff.value;
  if (eff.granted && !overCap) return { ok: true };

  if (!ctx.override) return { ok: false, needsOverride: true, error: 'Manager authorization required' };

  const mgr = verifyManagerPin(db, ctx.override);
  if (!mgr) {
    logEvent(db, { acting_employee_uid: actor?.uid, acting_employee_name: actor?.name, action_attempted: ctx.action, required_permission: key, was_approved: false, transaction_id: ctx.transactionId });
    return { ok: false, error: 'Invalid manager PIN' };
  }
  logEvent(db, {
    acting_employee_uid: actor?.uid, acting_employee_name: actor?.name, action_attempted: ctx.action, required_permission: key,
    authorizing_manager_uid: mgr.uid, authorizing_manager_name: mgr.name, was_approved: true, transaction_id: ctx.transactionId,
  });
  return { ok: true, viaOverride: true };
}
