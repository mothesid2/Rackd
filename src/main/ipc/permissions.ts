import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { randomUUID, randomBytes } from 'crypto';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { nowCT } from '../utils/time';
import { assertWritable } from '../supabase/licenseCheck';
import { PERMISSION_KEYS, MENU_KEYS, permissionsForUser, menuAccessForUserAll, pinLockState, requirePermission } from '../permissions';
import type { PermissionKey } from '../permissions';
import { enqueueEmployee, enqueueEmployeePermission, triggerSyncNow } from '../supabase/sync';


function isManager(): boolean {
  const r = getCurrentSession()?.role;
  return r === 'manager' || r === 'admin';
}
function isAdmin(): boolean {
  return getCurrentSession()?.role === 'admin';
}


function genPassword(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ', a = 'abcdefghijkmnpqrstuvwxyz', d = '23456789';
  const pick = (s: string, n: number) => Array.from(randomBytes(n), (b) => s[b % s.length]).join('');
  return `${pick(A, 2)}${pick(a, 4)}-${pick(d, 4)}`;
}

function genUniquePin(db: ReturnType<typeof getDb>, len = 4): string {
  const rows = db.prepare("SELECT pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND pin_hash <> ''").all() as { pin_hash: string }[];
  for (let attempt = 0; attempt < 50; attempt++) {
    const pin = Array.from(randomBytes(len), (b) => String(b % 10)).join('');
    if (!rows.some((r) => bcrypt.compareSync(pin, r.pin_hash))) return pin;
  }
  return String(Date.now()).slice(-len); 
}

export function registerPermissionHandlers(): void {
  
  
  ipcMain.handle('perms:me', () => {
    const s = getCurrentSession();
    if (!s) return { success: false, error: 'not signed in' };
    return {
      success: true, role: s.role, userId: s.userId,
      permissions: permissionsForUser(getDb(), s.userId),
      menuAccess: menuAccessForUserAll(getDb(), s.userId),
    };
  });

  ipcMain.handle('perms:keys', () => ({ success: true, keys: PERMISSION_KEYS, menuKeys: MENU_KEYS }));

  
  
  
  ipcMain.handle('perms:check', (_e, key: string, override?: string) => {
    if (!(PERMISSION_KEYS as readonly string[]).includes(key)) return { success: false, error: 'unknown permission' };
    const r = requirePermission(key as PermissionKey, { override, action: key }, getDb());
    return { success: r.ok, error: r.error, needsOverride: r.needsOverride };
  });

  ipcMain.handle('perms:pinLockState', () => ({ success: true, ...pinLockState(getDb()) }));

  
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
      menuKeys: MENU_KEYS,
      employees: emps.map((e) => ({ ...e, has_pin: !!e.has_pin, permissions: byEmp[e.uid as string] || {} })),
    };
  });

  
  
  
  
  
  
  
  ipcMain.handle('perms:saveEmployee', async (_e, emp: Record<string, unknown>) => {
    if (!isManager()) return { success: false, error: 'Manager access required' };
    const w = assertWritable('employee_manage'); if (!w.ok) return { success: false, error: w.error };
    const db = getDb();
    try {
      const role = emp.role === 'manager' ? 'manager' : 'cashier';
      const editing = !!emp.id;

      
      if (editing) {
        if (role === 'manager' && !isAdmin()) return { success: false, error: 'Only an admin can set a manager role.' };
        const id = emp.id as number;
        db.transaction(() => {
          db.prepare('UPDATE users SET name = ?, role = ?, is_active = ? WHERE id = ?')
            .run((emp.name as string) || null, role, emp.is_active === false ? 0 : 1, id);
          const uid = (db.prepare('SELECT uid FROM users WHERE id = ?').get(id) as { uid: string }).uid;
          enqueueEmployee('update', uid, db);
        })();
        
        
        
        try { await triggerSyncNow(); } catch {  }
        return { success: true, id: emp.id };
      }

      
      if (role === 'manager' && !isAdmin()) return { success: false, error: 'Only an admin can add managers.' };
      const name = String(emp.name || '').trim();
      if (!name) return { success: false, error: 'Enter a name.' };

      const uid = randomUUID();

      
      
      
      const typedPin = String(emp.pin ?? '').trim();
      let pin: string;
      let mustChangePin = 1;
      if (typedPin) {
        if (!/^\d{4}$/.test(typedPin)) return { success: false, error: 'PIN must be exactly 4 digits.' };
        pin = typedPin; 
        mustChangePin = 0;
      } else {
        pin = genUniquePin(db);
      }
      const pinHash = bcrypt.hashSync(pin, 10);

      let username: string | null = null;
      let password: string | null = null;
      let passwordHash: string | null = null;
      let mustChangePassword = 0;

      if (role === 'manager') {
        username = String(emp.username || '').trim();
        if (!username) return { success: false, error: 'Enter a username for the manager.' };
        if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return { success: false, error: 'That username is already taken.' };
        
        
        const typedPw = String(emp.password ?? '');
        if (typedPw) {
          if (typedPw.length < 8) return { success: false, error: 'Password must be at least 8 characters.' };
          password = typedPw;
        } else {
          password = genPassword();
          mustChangePassword = 1;
        }
        passwordHash = bcrypt.hashSync(password, 10);
      }

      db.transaction(() => {
        db.prepare(
          `INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active, must_change_password, must_change_pin)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
        ).run(uid, username, name, role, passwordHash, pinHash, role === 'manager' ? mustChangePassword : 0, mustChangePin);
        enqueueEmployee('insert', uid, db);
      })();
      
      
      
      
      try { await triggerSyncNow(); } catch {  }

      const id = (db.prepare('SELECT id FROM users WHERE uid = ?').get(uid) as { id: number }).id;
      
      return { success: true, id, uid, credentials: { role, name, username, password, pin } };
    } catch (err) {
      return { success: false, error: String((err as Error)?.message || err) };
    }
  });

  
  
  
  ipcMain.handle('perms:setPermission', (_e, employeeUid: string, key: string, isGranted: boolean, value: number | null) => {
    if (!isManager()) return { success: false, error: 'Manager access required' };
    const w = assertWritable('employee_manage'); if (!w.ok) return { success: false, error: w.error };
    if (!(PERMISSION_KEYS as readonly string[]).includes(key) && !(MENU_KEYS as readonly string[]).includes(key)) {
      return { success: false, error: 'unknown permission' };
    }
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

  
  ipcMain.handle('perms:overrideLog', (_e, limit?: number) => {
    if (!isManager()) return { success: false, error: 'Manager access required' };
    const log = getDb().prepare('SELECT * FROM permission_override_log ORDER BY at DESC LIMIT ?')
      .all(Math.min(500, limit || 200));
    return { success: true, log };
  });
}
