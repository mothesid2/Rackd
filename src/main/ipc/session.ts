import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { getCurrentSession, setCurrentSession } from './auth';
import { dayInfo, isIdleLocked, touchActivity, closeDay, IDLE_LIMIT } from '../daySession';

/**
 * Session-state IPC for the renderer's session guard (item 2):
 *   • session:state   — day-open + acting employee + whether the 15-min idle lock
 *                       has tripped. The login screen and the global idle overlay
 *                       read this.
 *   • session:touch   — activity heartbeat (keeps a live session alive; a no-op
 *                       once idle-locked so a stray event can't clear the lock).
 *   • session:reauth  — clear the idle lock by re-entering an employee PIN. Does
 *                       NOT reopen the day or drop back to manager username/password.
 *   • session:closeDay — explicit end-of-day (manager) without running a Z-report.
 */
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

  // Heartbeat: only extends a live, unlocked session. Once idle-locked, activity
  // must go through session:reauth (a PIN), so ignore touches here.
  ipcMain.handle('session:touch', () => {
    const employee = getCurrentSession();
    if (employee && !isIdleLocked()) touchActivity();
    return { success: true, idleLocked: !!employee && isIdleLocked() };
  });

  // Batch 5 fix: the lock screen used to show only the ORIGINAL employee's
  // name and verify against every active employee's PIN globally — since PINs
  // aren't required to be globally unique (see verifyPinForUser's own doc
  // comment), that's ambiguous, and worse, the UI read as "locked to Bob,"
  // leaving the register stuck if Bob stepped away. Now: pick who you are
  // first (any authorized staff member), then your own PIN — same pattern as
  // the register's own sign-in screen (auth:pinLogin), and scoped to exactly
  // the selected employee via verifyPinForUser, not a global PIN search.
  ipcMain.handle('session:listUnlockUsers', () => {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id, name, username, role FROM users WHERE is_active = 1 AND pin_hash IS NOT NULL AND pin_hash <> '' ORDER BY role = 'cashier', name, username"
    ).all() as { id: number; name: string | null; username: string; role: string }[];
    return { success: true, users: rows.map((u) => ({ id: u.id, name: u.name || u.username, role: u.role })) };
  });

  ipcMain.handle('session:reauth', (_e, userId: number, pin: string) => {
    const db = getDb();
    // Lazy require avoids a session<->permissions import cycle.
    const { verifyPinForUser } = require('../permissions') as typeof import('../permissions');
    const r = verifyPinForUser(db, Number(userId), String(pin || ''));
    if (!r.ok || !r.employee) return { success: false, error: r.error, lockedUntil: r.lockedUntil };
    // Re-establish the acting employee (whoever just unlocked it) + reset the
    // idle clock. setCurrentSession touches activity.
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
