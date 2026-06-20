import { ipcMain } from 'electron';
import bcrypt from 'bcryptjs';
import { getDb } from '../db/schema';
import { nowCT } from '../utils/time';

interface User {
  id: number;
  username: string;
  password_hash: string;
  role: 'manager' | 'cashier';
  must_change_password: number;
}

interface Session {
  userId: number;
  username: string;
  role: 'manager' | 'cashier';
}

let currentSession: Session | null = null;

export function getCurrentSession(): Session | null {
  return currentSession;
}

export function registerAuthHandlers(): void {
  ipcMain.handle('auth:login', async (_event, username: string, password: string) => {
    try {
      const db = getDb();
      const user = db
        .prepare('SELECT * FROM users WHERE username = ?')
        .get(username) as User | undefined;

      if (!user) {
        return { success: false, error: 'Invalid username or password' };
      }

      const valid = bcrypt.compareSync(password, user.password_hash);
      if (!valid) {
        return { success: false, error: 'Invalid username or password' };
      }

      currentSession = {
        userId: user.id,
        username: user.username,
        role: user.role,
      };

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
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('auth:logout', async () => {
    currentSession = null;
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
        `SELECT * FROM users WHERE username = ? AND role = 'manager'`
      ).get(username) as User | undefined;
      if (!user) return { success: false, error: 'No manager found with that username' };
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
