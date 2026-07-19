import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/schema';
import { nowCT } from '../utils/time';
import { assertWritable } from '../supabase/licenseCheck';
import { isDayOpen, openDay, touchActivity, clearActivity } from '../daySession';

type Role = 'admin' | 'manager' | 'cashier';
interface User {
  id: number;
  username: string | null;
  password_hash: string | null;
  role: Role;
  must_change_password: number;
  must_change_pin: number;
}

interface Session {
  userId: number;
  username: string;
  role: Role;
}

let currentSession: Session | null = null;

export function getCurrentSession(): Session | null {
  return currentSession;
}

/** Set/replace the acting employee session (used by PIN re-auth). Touches activity. */
export function setCurrentSession(session: Session | null): void {
  currentSession = session;
  if (session) touchActivity();
  else clearActivity();
}

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:login', async (_event, username: string, password: string) => {
    try {
      const db = getDb();
      const user = db
        .prepare('SELECT * FROM users WHERE username = ?')
        .get(username) as User | undefined;

      // Cashiers have no username/password (PIN only), so a null password never
      // authenticates here.
      if (!user || !user.password_hash) {
        return { success: false, error: 'Invalid username or password' };
      }

      const valid = bcrypt.compareSync(password, user.password_hash);
      if (!valid) {
        return { success: false, error: 'Invalid username or password' };
      }

      // Business-day gate: the first login of the day must be an ADMIN or MANAGER
      // (full username + password), which opens the day. After that, staff sign in
      // with a PIN. A cashier cannot open the day.
      if (!isDayOpen(db)) {
        if (user.role !== 'manager' && user.role !== 'admin') {
          return { success: false, error: 'A manager must open the day first with a username and password.' };
        }
        openDay(user.id, user.username as string, db);
      }

      currentSession = {
        userId: user.id,
        username: user.username as string,
        role: user.role,
      };
      touchActivity();

      // Auto-create a shift record if none is open for this user
      const openShift = db.prepare(
        `SELECT id FROM shift_totals WHERE cashier_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`
      ).get(user.id);
      if (!openShift) {
        db.prepare(`INSERT INTO shift_totals (cashier_id, opened_at) VALUES (?, ?)`).run(user.id, nowCT());
      }

      return {
        success: true,
        user: {
          id: user.id,
          username: user.username,
          role: user.role,
          must_change_password: user.must_change_password === 1,
          must_change_pin: user.must_change_pin === 1,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // PIN sign-in (register): resolve the employee by numeric PIN and open a shift.
  ipcMain.handle('auth:pinLogin', async (_event, pin: string) => {
    try {
      const db = getDb();
      // The day must be opened by a manager (username + password) before PIN sign-in.
      if (!isDayOpen(db)) {
        return { success: false, error: 'The day hasn’t been opened yet. A manager must sign in with a username and password first.', dayClosed: true };
      }
      // Lazy require avoids the auth<->permissions import cycle at load time.
      const { verifyPin } = require('../permissions') as typeof import('../permissions');
      const r = verifyPin(db, String(pin || ''));
      if (!r.ok || !r.employee) return { success: false, error: r.error, lockedUntil: r.lockedUntil };
      currentSession = { userId: r.employee.id, username: r.employee.username, role: r.employee.role as Role };
      touchActivity();
      const openShift = db.prepare(
        `SELECT id FROM shift_totals WHERE cashier_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`
      ).get(r.employee.id);
      if (!openShift) db.prepare(`INSERT INTO shift_totals (cashier_id, opened_at) VALUES (?, ?)`).run(r.employee.id, nowCT());
      // Forced PIN change on first login (managers + cashiers).
      const mcp = db.prepare('SELECT must_change_pin, must_change_password FROM users WHERE id = ?').get(r.employee.id) as { must_change_pin: number; must_change_password: number } | undefined;
      return {
        success: true,
        user: {
          id: r.employee.id, username: r.employee.username, name: r.employee.name, role: r.employee.role,
          must_change_pin: mcp?.must_change_pin === 1, must_change_password: mcp?.must_change_password === 1,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // First-login credential change (forced, cannot skip). Admin/managers set a new
  // password AND PIN; cashiers set a new PIN. Clears the flags and syncs the new
  // credentials so they apply on every kiosk + the portal.
  ipcMain.handle('auth:completeFirstLogin', (_event, args: { newPassword?: string; newPin?: string }) => {
    try {
      if (!currentSession) return { success: false, error: 'Not signed in' };
      const db = getDb();
      const u = db.prepare('SELECT id, uid, role, must_change_password, must_change_pin FROM users WHERE id = ?').get(currentSession.userId) as
        | { id: number; uid: string | null; role: Role; must_change_password: number; must_change_pin: number } | undefined;
      if (!u) return { success: false, error: 'User not found' };

      const needsPassword = u.role !== 'cashier';
      const newPin = String(args?.newPin ?? '');
      const newPassword = String(args?.newPassword ?? '');
      if (newPin.length < 4 || !/^\d+$/.test(newPin)) return { success: false, error: 'PIN must be at least 4 digits.' };
      if (needsPassword && newPassword.length < 6) return { success: false, error: 'Password must be at least 6 characters.' };

      // A new PIN must be unique (PIN sign-in resolves by matching any employee).
      const others = db.prepare("SELECT id, pin_hash FROM users WHERE is_active = 1 AND id <> ? AND pin_hash IS NOT NULL AND pin_hash <> ''").all(u.id) as { id: number; pin_hash: string }[];
      if (others.some((o) => bcrypt.compareSync(newPin, o.pin_hash))) return { success: false, error: 'That PIN is already in use — choose another.' };

      db.transaction(() => {
        if (needsPassword) {
          db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), u.id);
        }
        db.prepare('UPDATE users SET pin_hash = ?, must_change_pin = 0, pin_fail_count = 0 WHERE id = ?').run(bcrypt.hashSync(newPin, 10), u.id);
        try {
          const { enqueueEmployee } = require('../supabase/sync') as typeof import('../supabase/sync');
          if (u.uid) enqueueEmployee('update', u.uid, db);
        } catch { /* offline — syncs later */ }
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Sign the acting employee out. Does NOT close the business day — the next
  // sign-in uses a PIN (day stays open until an explicit close-out).
  ipcMain.handle('auth:logout', async () => {
    currentSession = null;
    clearActivity();
    return { success: true };
  });

  ipcMain.handle('auth:getSession', async () => {
    return { success: true, session: currentSession };
  });

  // List users — manager only
  ipcMain.handle('auth:listUsers', async () => {
    try {
      if (!currentSession || currentSession.role !== 'manager') {
        return { success: false, error: 'Manager access required' };
      }
      const db = getDb();
      const users = db.prepare(
        'SELECT id, username, role, must_change_password FROM users ORDER BY role DESC, username'
      ).all();
      return { success: true, users };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Create user — manager only; new accounts require password change on first login
  ipcMain.handle('auth:createUser', async (_event, username: string, password: string, role: string) => {
    try {
      const w = assertWritable('employee_manage'); if (!w.ok) return { success: false, error: w.error };
      if (!currentSession || currentSession.role !== 'manager') {
        return { success: false, error: 'Manager access required' };
      }
      if (!username || !password || !['manager', 'cashier'].includes(role)) {
        return { success: false, error: 'Invalid input' };
      }
      if (password.length < 4) {
        return { success: false, error: 'Password must be at least 4 characters' };
      }
      const db = getDb();
      const hash = bcrypt.hashSync(password, 10);
      db.prepare(
        'INSERT INTO users (username, password_hash, role, must_change_password) VALUES (?, ?, ?, 1)'
      ).run(username.trim(), hash, role);
      return { success: true };
    } catch (err) {
      const msg = String(err);
      if (msg.includes('UNIQUE')) return { success: false, error: 'Username already exists' };
      return { success: false, error: msg };
    }
  });

  // Delete user — manager only, cannot delete own account
  ipcMain.handle('auth:deleteUser', async (_event, userId: number) => {
    try {
      const w = assertWritable('employee_manage'); if (!w.ok) return { success: false, error: w.error };
      if (!currentSession || currentSession.role !== 'manager') {
        return { success: false, error: 'Manager access required' };
      }
      if (userId === currentSession.userId) {
        return { success: false, error: 'Cannot delete your own account' };
      }
      const db = getDb();
      db.transaction(() => {
        db.prepare('UPDATE transactions   SET cashier_id  = NULL WHERE cashier_id  = ?').run(userId);
        db.prepare('UPDATE shift_totals   SET cashier_id  = NULL WHERE cashier_id  = ?').run(userId);
        db.prepare('UPDATE invoices       SET received_by = NULL WHERE received_by = ?').run(userId);
        db.prepare('UPDATE z_reports      SET generated_by = NULL WHERE generated_by = ?').run(userId);
        db.prepare('UPDATE sms_blasts     SET sent_by     = NULL WHERE sent_by     = ?').run(userId);
        db.prepare('DELETE FROM users WHERE id = ?').run(userId);
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Verify manager credentials — used for cashier discount overrides
  ipcMain.handle('auth:verifyManager', async (_event, username: string, password: string) => {
    try {
      const db = getDb();
      const user = db.prepare(
        `SELECT * FROM users WHERE username = ? AND role IN ('manager','admin')`
      ).get(username) as User | undefined;
      if (!user || !user.password_hash) return { success: false, error: 'No manager found with that username' };
      const valid = bcrypt.compareSync(password, user.password_hash);
      if (!valid) return { success: false, error: 'Invalid password' };
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('auth:changePassword', async (_event, oldPass: string, newPass: string) => {
    try {
      if (!currentSession) return { success: false, error: 'Not logged in' };
      const db = getDb();
      const user = db
        .prepare('SELECT * FROM users WHERE id = ?')
        .get(currentSession.userId) as User;

      if (!user.password_hash) return { success: false, error: 'This account has no password.' };
      const valid = bcrypt.compareSync(oldPass, user.password_hash);
      if (!valid) return { success: false, error: 'Current password is incorrect' };

      const newHash = bcrypt.hashSync(newPass, 10);
      db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(newHash, user.id);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
