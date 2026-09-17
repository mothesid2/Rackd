import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { getCurrentSession, setCurrentSession } from './auth';
import { dayInfo, isIdleLocked, touchActivity, closeDay, IDLE_LIMIT } from '../daySession';


export function registerSessionHandlers(): void {
  ipcMain.handle('session:state', () => {
    const employee = getCurrentSession();
    const idleLocked = !!employee && isIdleLocked();
    return {
      success: true,
      dayOpen: dayInfo().open,
      day: dayInfo(),
      employee,
      idleLocked,
      idleLimitMs: IDLE_LIMIT,
    };
  });

  
  
  ipcMain.handle('session:touch', () => {
    const employee = getCurrentSession();
    if (employee && !isIdleLocked()) touchActivity();
    return { success: true, idleLocked: !!employee && isIdleLocked() };
  });

  
  
  
  
  
  
  
  
  ipcMain.handle('session:listUnlockUsers', () => {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id, name, username, role FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND pin_hash <> '' ORDER BY role = 'cashier', name, username"
    ).all() as { id: number; name: string | null; username: string; role: string }[];
    return { success: true, users: rows.map((u) => ({ id: u.id, name: u.name || u.username, role: u.role })) };
  });

  ipcMain.handle('session:reauth', (_e, userId: number, pin: string) => {
    const db = getDb();
    
    const { verifyPinForUser } = require('../permissions') as typeof import('../permissions');
    const r = verifyPinForUser(db, Number(userId), String(pin || ''));
    if (!r.ok || !r.employee) return { success: false, error: r.error, lockedUntil: r.lockedUntil };
    
    
    setCurrentSession({ userId: r.employee.id, username: r.employee.username, name: r.employee.name || r.employee.username, role: r.employee.role as 'manager' | 'cashier' });
    return { success: true, user: { id: r.employee.id, username: r.employee.username, name: r.employee.name, role: r.employee.role } };
  });

  ipcMain.handle('session:closeDay', () => {
    if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required to close out the day.' };
    closeDay(getDb());
    setCurrentSession(null);
    return { success: true };
  });
}
