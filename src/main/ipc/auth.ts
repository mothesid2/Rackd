import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { randomUUID, randomBytes } from 'crypto';
import { getDb } from '../db/schema';
import { currentBusinessDayWindow, currentBusinessDate, scheduledBusinessDayStart } from '../utils/time';
import { assertWritable } from '../supabase/licenseCheck';
import { isDayOpen, openDay, touchActivity, clearActivity } from '../daySession';
import { getOrOpenCurrentShift, currentCashFloat } from '../shiftTotals';
import { enqueueEmployee, triggerSyncNow } from '../supabase/sync';


function genUniquePin(db: ReturnType<typeof getDb>, len = 4): string {
  const rows = db.prepare("SELECT pin_hash FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND pin_hash <> ''").all() as { pin_hash: string }[];
  for (let attempt = 0; attempt < 50; attempt++) {
    const pin = Array.from(randomBytes(len), (b) => String(b % 10)).join('');
    if (!rows.some((r) => bcrypt.compareSync(pin, r.pin_hash))) return pin;
  }
  return String(Date.now()).slice(-len);
}

type Role = 'admin' | 'manager' | 'cashier';
interface User {
  id: number;
  username: string | null;
  name: string | null;
  password_hash: string | null;
  role: Role;
  must_change_password: number;
  must_change_pin: number;
}

interface Session {
  userId: number;
  username: string;
  name: string;
  role: Role;
}

let currentSession: Session | null = null;

export function getCurrentSession(): Session | null {
  return currentSession;
}


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

      
      
      if (!user || !user.password_hash) {
        return { success: false, error: 'Invalid username or password' };
      }

      const valid = bcrypt.compareSync(password, user.password_hash);
      if (!valid) {
        return { success: false, error: 'Invalid username or password' };
      }

      
      
      
      if (!isDayOpen(db)) {
        if (user.role !== 'manager' && user.role !== 'admin') {
          return { success: false, error: 'A manager must open the day first with a username and password.' };
        }
        openDay(user.id, user.username as string, db);
      }

      currentSession = {
        userId: user.id,
        username: user.username as string,
        name: user.name || (user.username as string),
        role: user.role,
      };
      touchActivity();

      
      
      
      
      
      
      
      
      getOrOpenCurrentShift(user.id, db, currentCashFloat(db));

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

  
  
  ipcMain.handle('auth:listPinUsers', () => {
    try {
      const db = getDb();
      const rows = db.prepare(
        "SELECT id, name, username, role FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND pin_hash <> '' ORDER BY role = 'cashier', name, username"
      ).all() as { id: number; name: string | null; username: string; role: string }[];
      return { success: true, users: rows.map((u) => ({ id: u.id, name: u.name || u.username, role: u.role })) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('auth:pinLogin', async (_event, userId: number, pin: string) => {
    try {
      const db = getDb();
      if (!userId) return { success: false, error: 'Select who you are, then enter your PIN.' };
      
      const { verifyPinForUser } = require('../permissions') as typeof import('../permissions');
      const r = verifyPinForUser(db, Number(userId), String(pin || ''));
      if (!r.ok || !r.employee) return { success: false, error: r.error, lockedUntil: r.lockedUntil };

      
      
      
      
      if (!isDayOpen(db)) {
        openDay(r.employee.id, r.employee.name || r.employee.username, db);
      }

      currentSession = { userId: r.employee.id, username: r.employee.username, name: r.employee.name || r.employee.username, role: r.employee.role as Role };
      touchActivity();
      
      
      
      getOrOpenCurrentShift(r.employee.id, db, currentCashFloat(db));
      
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

  
  
  
  ipcMain.handle('auth:completeFirstLogin', async (_event, args: { newPassword?: string; newPin?: string }) => {
    try {
      if (!currentSession) return { success: false, error: 'Not signed in' };
      const db = getDb();
      const u = db.prepare('SELECT id, uid, role, must_change_password, must_change_pin FROM users WHERE id = ?').get(currentSession.userId) as
        | { id: number; uid: string | null; role: Role; must_change_password: number; must_change_pin: number } | undefined;
      if (!u) return { success: false, error: 'User not found' };

      
      
      
      
      
      
      
      
      
      const needsPassword = u.role !== 'cashier' && !!u.must_change_password;
      const newPin = String(args?.newPin ?? '');
      const newPassword = String(args?.newPassword ?? '');
      if (!/^\d{4}$/.test(newPin)) return { success: false, error: 'PIN must be exactly 4 digits.' };
      if (needsPassword && newPassword.length < 8) return { success: false, error: 'Password must be at least 8 characters.' };
      

      db.transaction(() => {
        if (needsPassword) {
          db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?').run(bcrypt.hashSync(newPassword, 10), u.id);
        }
        db.prepare('UPDATE users SET pin_hash = ?, must_change_pin = 0, pin_fail_count = 0 WHERE id = ?').run(bcrypt.hashSync(newPin, 10), u.id);
        try {
          const { enqueueEmployee } = require('../supabase/sync') as typeof import('../supabase/sync');
          if (u.uid) enqueueEmployee('update', u.uid, db);
        } catch {  }
      })();
      
      
      
      
      
      
      try { await triggerSyncNow(); } catch {  }
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  ipcMain.handle('auth:logout', async () => {
    currentSession = null;
    clearActivity();
    return { success: true };
  });

  ipcMain.handle('auth:getSession', async () => {
    return { success: true, session: currentSession };
  });

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  ipcMain.handle('auth:businessDayWindow', async () => {
    try {
      const db = getDb();
      const win = currentBusinessDayWindow(db);
      return {
        success: true,
        registerStart: win.start,
        locationStart: scheduledBusinessDayStart(db),
        
        
        
        businessDate: currentBusinessDate(db),
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('auth:listUsers', async () => {
    try {
      if (!currentSession || (currentSession.role !== 'manager' && currentSession.role !== 'admin')) {
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

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  ipcMain.handle('auth:createUser', async (_event, username: string, password: string, role: string) => {
    try {
      const w = assertWritable('employee_manage'); if (!w.ok) return { success: false, error: w.error };
      if (!currentSession || (currentSession.role !== 'manager' && currentSession.role !== 'admin')) {
        return { success: false, error: 'Manager access required' };
      }
      if (!username || !['manager', 'cashier'].includes(role)) {
        return { success: false, error: 'Invalid input' };
      }
      const isCashier = role === 'cashier';
      if (!isCashier && (!password || password.length < 4)) {
        return { success: false, error: 'Password must be at least 4 characters' };
      }
      const db = getDb();
      const uid = randomUUID();
      const name = username.trim();
      const hash = isCashier ? null : bcrypt.hashSync(password, 10);
      
      
      
      
      
      
      
      
      const pin = genUniquePin(db);
      const pinHash = bcrypt.hashSync(pin, 10);
      db.transaction(() => {
        db.prepare(
          `INSERT INTO users (uid, username, name, password_hash, pin_hash, role, is_active, must_change_password, must_change_pin)
           VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`
        ).run(uid, name, name, hash, pinHash, role, isCashier ? 0 : 1, 1);
        enqueueEmployee('insert', uid, db);
      })();
      
      
      
      try { await triggerSyncNow(); } catch {  }
      return { success: true, pin: pin || undefined };
    } catch (err) {
      const msg = String(err);
      if (msg.includes('UNIQUE')) return { success: false, error: 'Username already exists' };
      return { success: false, error: msg };
    }
  });

  
  
  
  ipcMain.handle('auth:updateUsername', async (_event, userId: number, username: string) => {
    try {
      const w = assertWritable('employee_manage'); if (!w.ok) return { success: false, error: w.error };
      if (!currentSession || (currentSession.role !== 'manager' && currentSession.role !== 'admin')) {
        return { success: false, error: 'Manager access required' };
      }
      const name = String(username || '').trim();
      if (!name) return { success: false, error: 'Username is required' };
      const db = getDb();
      const target = db.prepare('SELECT uid FROM users WHERE id = ?').get(userId) as { uid: string | null } | undefined;
      if (!target) return { success: false, error: 'User not found' };
      db.transaction(() => {
        db.prepare('UPDATE users SET username = ?, name = ? WHERE id = ?').run(name, name, userId);
        if (target.uid) enqueueEmployee('update', target.uid, db);
      })();
      try { await triggerSyncNow(); } catch {  }
      return { success: true };
    } catch (err) {
      const msg = String(err);
      if (msg.includes('UNIQUE')) return { success: false, error: 'Username already exists' };
      return { success: false, error: msg };
    }
  });

  
  
  
  ipcMain.handle('auth:deleteUser', async (_event, userId: number) => {
    try {
      const w = assertWritable('employee_manage'); if (!w.ok) return { success: false, error: w.error };
      if (!currentSession || (currentSession.role !== 'manager' && currentSession.role !== 'admin')) {
        return { success: false, error: 'Manager access required' };
      }
      if (userId === currentSession.userId) {
        return { success: false, error: 'Cannot delete your own account' };
      }
      const db = getDb();
      const target = db.prepare('SELECT uid FROM users WHERE id = ?').get(userId) as { uid: string | null } | undefined;
      db.transaction(() => {
        if (target?.uid) {
          db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(userId);
          enqueueEmployee('update', target.uid, db);
        }
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
