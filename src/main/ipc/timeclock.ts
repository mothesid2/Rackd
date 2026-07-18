import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { nowCT } from '../utils/time';
import { getMachineId } from '../supabase/tokenManager';
import { enqueueTimeClock } from '../supabase/sync';
import { requirePermission, getEmployee, userHasPermission } from '../permissions';

export function registerTimeClockHandlers(): void {
  // Everyone's clock status + who "me" is (so the UI knows self vs others).
  ipcMain.handle('timeclock:status', () => {
    const db = getDb();
    const s = getCurrentSession();
    const me = s?.userId ? getEmployee(db, s.userId) : null;
    const emps = db.prepare("SELECT uid, name, username, role FROM users WHERE is_active = 1 ORDER BY role DESC, name")
      .all() as { uid: string; name: string | null; username: string; role: string }[];
    const open = db.prepare('SELECT employee_uid, clock_in FROM time_clock WHERE clock_out IS NULL')
      .all() as { employee_uid: string; clock_in: string }[];
    const openBy: Record<string, string> = {};
    for (const o of open) openBy[o.employee_uid] = o.clock_in;
    // Can this session clock others? (managers, or granted clock_others) — no-log check.
    const canOthers = !!(s && (s.role === 'manager' || (me && userHasPermission(db, s.userId, 'clock_others').granted)));
    return {
      success: true,
      meUid: me?.uid || null,
      canClockOthers: canOthers,
      employees: emps.map((e) => ({ uid: e.uid, name: e.name || e.username, role: e.role, clocked_in: !!openBy[e.uid], since: openBy[e.uid] || null })),
    };
  });

  // Toggle a punch. Self is free; clocking someone else needs clock_others (+ override).
  ipcMain.handle('timeclock:punch', (_e, employeeUid?: string, override?: string) => {
    const db = getDb();
    const s = getCurrentSession();
    const me = s?.userId ? getEmployee(db, s.userId) : null;
    const targetUid = employeeUid || me?.uid;
    if (!targetUid) return { success: false, error: 'Not signed in' };

    if (targetUid !== me?.uid) {
      const perm = requirePermission('clock_others', { override, action: 'clock_others' }, db);
      if (!perm.ok) return { success: false, error: perm.error, needsOverride: perm.needsOverride };
    }

    const target = db.prepare('SELECT name, username FROM users WHERE uid = ?').get(targetUid) as { name: string | null; username: string } | undefined;
    const name = target ? (target.name || target.username) : '';
    const open = db.prepare('SELECT uid FROM time_clock WHERE employee_uid = ? AND clock_out IS NULL ORDER BY clock_in DESC LIMIT 1')
      .get(targetUid) as { uid: string } | undefined;

    let action: 'in' | 'out';
    db.transaction(() => {
      if (open) {
        db.prepare('UPDATE time_clock SET clock_out = ?, updated_at = ? WHERE uid = ?').run(nowCT(), nowCT(), open.uid);
        enqueueTimeClock('update', open.uid, db);
        action = 'out';
      } else {
        const uid = randomUUID();
        db.prepare('INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, register_id) VALUES (?, ?, ?, ?, ?)')
          .run(uid, targetUid, name, nowCT(), getMachineId(db));
        enqueueTimeClock('insert', uid, db);
        action = 'in';
      }
    })();
    return { success: true, action: action!, employee: name };
  });
}
