import { ipcMain } from 'electron';
import { DateTime } from 'luxon';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { getTwilioClient } from '../services/twilio';
import { nowCT, getBusinessTZ } from '../utils/time';

type Db = ReturnType<typeof getDb>;


export function runPointExpiry(db: Db): number {
  const expRow = db.prepare("SELECT value FROM settings WHERE key = 'loyalty_expiry_days'").get() as { value: string } | undefined;
  const days = parseInt(expRow?.value || '365', 10) || 365;
  if (days <= 0) return 0;
  const cutoff = DateTime.now().setZone(getBusinessTZ()).minus({ days }).toISODate();

  const rows = db.prepare(`
    SELECT c.id, c.loyalty_points, MAX(t.created_at) AS last_visit
    FROM customers c
    LEFT JOIN transactions t ON t.customer_id = c.id
    WHERE c.loyalty_points > 0
    GROUP BY c.id
    HAVING last_visit IS NULL OR substr(last_visit, 1, 10) < ?
  `).all(cutoff) as { id: number; loyalty_points: number; last_visit: string | null }[];

  let expired = 0;
  db.transaction(() => {
    for (const r of rows) {
      db.prepare(`INSERT INTO loyalty_ledger (customer_id, change, reason, balance_after) VALUES (?, ?, 'expired', 0)`)
        .run(r.id, -r.loyalty_points);
      db.prepare(`UPDATE customers SET loyalty_points = 0, updated_at = ? WHERE id = ?`).run(nowCT(), r.id);
      expired++;
    }
  })();
  return expired;
}

export function registerLoyaltyHandlers(): void {
  ipcMain.handle('loyalty:rewards', async () => {
    try {
      const db = getDb();
      const rewards = db.prepare('SELECT * FROM loyalty_rewards WHERE active = 1 ORDER BY point_cost').all();
      return { success: true, rewards };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('loyalty:expireStale', async () => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const expired = runPointExpiry(getDb());
      return { success: true, expired };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('loyalty:closeToReward', async (_event, opts?: { within?: number }) => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      const within = opts?.within ?? 50;

      const rewards = db.prepare('SELECT name, point_cost FROM loyalty_rewards WHERE active = 1 ORDER BY point_cost')
        .all() as { name: string; point_cost: number }[];
      if (!rewards.length) return { success: false, error: 'No rewards configured' };

      const client = getTwilioClient();
      const fromRow = db.prepare("SELECT value FROM settings WHERE key = 'twilio_from_number'").get() as { value: string } | undefined;
      const fromNumber = fromRow?.value;
      if (!client || !fromNumber) return { success: false, error: 'Twilio not configured' };

      const custs = db.prepare(`SELECT id, first_name, phone, loyalty_points FROM customers WHERE opt_in_sms = 1 AND loyalty_points > 0`)
        .all() as { id: number; first_name: string; phone: string | null; loyalty_points: number }[];

      let sent = 0, eligible = 0;
      for (const c of custs) {
        const target = rewards.find(r => r.point_cost > c.loyalty_points && (r.point_cost - c.loyalty_points) <= within);
        if (!target) continue;
        eligible++;
        const digits = (c.phone || '').replace(/\D/g, '');
        if (!digits) continue;
        const need = target.point_cost - c.loyalty_points;
        try {
          await client.messages.create({
            body: `Hi ${c.first_name}! You're just ${need} points from "${target.name}". Come see us! Reply STOP to unsubscribe`,
            from: fromNumber,
            to: digits.startsWith('1') ? `+${digits}` : `+1${digits}`,
          });
          sent++;
        } catch {  }
      }
      return { success: true, sent, eligible };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
