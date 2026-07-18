import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { nowCT } from '../utils/time';
import { assertWritable } from '../supabase/licenseCheck';
import { PERMISSION_KEYS, permissionsForUser, pinLockState, requirePermission } from '../permissions';
import type { PermissionKey } from '../permissions';
import { enqueueEmployee, enqueueEmployeePermission } from '../supabase/sync';

function isManager(): boolean {
  return getCurrentSession()?.role === 'manager';
}

export function registerPermissionHandlers(): void {
  // Effective permissions for the current session (renderer gates its UI on these,
  // but the data layer re-checks — the UI is not trusted).
  ipcMain.handle('perms:me', () => {
    const s = getCurrentSession();
    if (!s) return { success: false, error: 'not signed in' };
    return { success: true, role: s.role, userId: s.userId, permissions: permissionsForUser(getDb(), s.userId) };
  });

  ipcMain.handle('perms:keys', () => ({ success: true, keys: PERMISSION_KEYS }));

  // Generic authorization endpoint for UI-driven gated actions (e.g. manual rebate
  // apply). Validates the permission for the current session, applying + logging a
  // manager PIN override when provided. The override audit is written server-side.
  ipcMain.handle('perms:check', (_e, key: string, override?: string) => {
    if (!(PERMISSION_KEYS as readonly string[]).includes(key)) return { success: false, error: 'unknown permission' };
    const r = requirePermission(key as PermissionKey, { override, action: key }, getDb());
    return { success: r.ok, error: r.error, needsOverride: r.needsOverride };
  });

  ipcMain.handle('perms:pinLockState', () => ({ success: true, ...pinLockState(getDb()) }));

  // ── manager: staff + permission administration ─────────────────────────────
  ipcMain.handle('perms:listEmployees', () => {
    if (!isManager()) return { success: false, error: 'Manager access required' };
    const db = getDb();
    const emps = db.prepare(
      "SELECT id, uid, username, name, role, is_active, (pin_hash IS NOT NULL AND pin_hash <> '') AS has_pin FROM users ORDER BY role DESC, username"
    ).all() as Record<string, unknown>[];
    const perms = db.prepare('SELECT employee_uid, permission_key, is_granted, value FROM employee_permissions').all() as
      { employee_uid: string; permission_key: string; is_granted: number; value: number | null }[];
    const byEmp: Record<string, Record<string, { is_granted: boolean; value: number | null }>> = {};
    for (const p of perms) (byEmp[p.employee_uid] ||= {})[p.permission_key] = { is_granted: !!p.is_granted, value: p.value };
    return {
      success: true,
      keys: PERMISSION_KEYS,
      employees: emps.map((e) => ({ ...e, has_pin: !!e.has_pin, permissions: byEmp[e.uid as string] || {} })),
    };
  });

  // Create/update an employee (+ optional PIN reset).
  ipcMain.handle('perms:saveEmployee', (_e, emp: Record<string, unknown>) => {
    if (!isManager()) return { success: false, error: 'Manager access required' };
    const w = assertWritable('employee_manage'); if (!w.ok) return { success: false, error: w.error };
    const db = getDb();
    try {
      const role = emp.role === 'manager' ? 'manager' : 'cashier';
      let id = emp.id as number | undefined;
      let uid = '';
      db.transaction(() => {
        if (id) {
          db.prepare('UPDATE users SET name = ?, role = ?, is_active = ? WHERE id = ?')
            .run((emp.name as string) || null, role, emp.is_active === false ? 0 : 1, id);
          uid = (db.prepare('SELECT uid FROM users WHERE id = ?').get(id) as { uid: string }).uid;
        } else {
          uid = randomUUID();
          const username = String(emp.username || emp.name || ('user_' + uid.slice(0, 6))).trim();
          const r = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, is_active) VALUES (?, ?, ?, ?, '', ?)")
            .run(uid, username, (emp.name as string) || username, role, emp.is_active === false ? 0 : 1);
          id = r.lastInsertRowid as number;
        }
        if (emp.pin) {
          if (String(emp.pin).length < 4) throw new Error('PIN must be at least 4 digits');
          db.prepare('UPDATE users SET pin_hash = ?, pin_fail_count = 0 WHERE id = ?').run(bcrypt.hashSync(String(emp.pin), 10), id);
        }
        enqueueEmployee(emp.id ? 'update' : 'insert', uid, db);
      })();
      return { success: true, id, uid };
    } catch (err) {
      return { success: false, error: String((err as Error)?.message || err) };
    }
  });

  // Toggle a single permission grant (+ optional cap value) for an employee.
  ipcMain.handle('perms:setPermission', (_e, employeeUid: string, key: string, isGranted: boolean, value: number | null) => {
    if (!isManager()) return { success: false, error: 'Manager access required' };
    const w = assertWritable('employee_manage'); if (!w.ok) return { success: false, error: w.error };
    if (!(PERMISSION_KEYS as readonly string[]).includes(key)) return { success: false, error: 'unknown permission' };
    const db = getDb();
    db.transaction(() => {
      const existing = db.prepare('SELECT uid FROM employee_permissions WHERE employee_uid = ? AND permission_key = ?')
        .get(employeeUid, key) as { uid: string } | undefined;
      const uid = existing?.uid || randomUUID();
      db.prepare(
        `INSERT INTO employee_permissions (uid, employee_uid, permission_key, is_granted, value, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(uid) DO UPDATE SET is_granted = excluded.is_granted, value = excluded.value, updated_at = excluded.updated_at`
      ).run(uid, employeeUid, key, isGranted ? 1 : 0, value ?? null, nowCT());
      enqueueEmployeePermission(existing ? 'update' : 'insert', uid, db);
    })();
    return { success: true };
  });

  // Read the append-only override audit (manager only).
  ipcMain.handle('perms:overrideLog', (_e, limit?: number) => {
    if (!isManager()) return { success: false, error: 'Manager access required' };
    const log = getDb().prepare('SELECT * FROM permission_override_log ORDER BY at DESC LIMIT ?')
      .all(Math.min(500, limit || 200));
    return { success: true, log };
  });
}
