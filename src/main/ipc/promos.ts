import { ipcMain } from 'electron';
import { DateTime } from 'luxon';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { getTwilioClient } from '../services/twilio';
import { nowCT, TZ } from '../utils/time';
import { assertWritable } from '../supabase/licenseCheck';

interface Customer {
  id: number; first_name: string; last_name: string; phone: string | null;
  dob: string | null; opt_in_sms: number; loyalty_points: number;
}

// DOB is stored "MM/DD/YYYY"
function birthdayMMDD(dob: string | null): string | null {
  const m = (dob || '').match(/^(\d{2})\/(\d{2})\//);
  return m ? `${m[1]}${m[2]}` : null;
}

export function registerPromoHandlers(): void {
  // List customers whose birthday is today.
  ipcMain.handle('promos:birthdaysToday', async () => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      const today = DateTime.now().setZone(TZ);
      const mmdd = today.toFormat('MMdd');
      const datePattern = today.toFormat('MM/dd') + '/%';

      const rows = db.prepare(
        `SELECT id, first_name, last_name, phone, dob, opt_in_sms, loyalty_points
         FROM customers WHERE dob LIKE ? ORDER BY last_name`
      ).all(datePattern) as Customer[];

      const list = rows.map(c => {
        const code = `BDAY-${c.id}-${mmdd}`;
        const existing = db.prepare('SELECT used, expires_at FROM promo_codes WHERE code = ?').get(code) as { used: number } | undefined;
        return {
          id: c.id, name: `${c.first_name} ${c.last_name}`, phone: c.phone,
          opt_in_sms: c.opt_in_sms, code, already_generated: !!existing,
        };
      });
      return { success: true, birthdays: list };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Generate birthday codes, award the +50 loyalty bonus (once/year), and text opted-in customers.
  ipcMain.handle('promos:runBirthdays', async () => {
    try {
      const w = assertWritable('sms_send'); if (!w.ok) return { success: false, error: w.error };
      const session = getCurrentSession();
      if (session?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      const today = DateTime.now().setZone(TZ);
      const mmdd = today.toFormat('MMdd');
      const year = today.year;
      const datePattern = today.toFormat('MM/dd') + '/%';
      const expires = today.plus({ days: 7 }).toISODate();

      const birthdays = db.prepare(
        `SELECT id, first_name, last_name, phone, dob, opt_in_sms, loyalty_points, lifetime_points, gold_member
         FROM customers WHERE dob LIKE ?`
      ).all(datePattern) as (Customer & { lifetime_points: number; gold_member: number })[];

      const client = getTwilioClient();
      const fromRow = db.prepare("SELECT value FROM settings WHERE key = 'twilio_from_number'").get() as { value: string } | undefined;
      const fromNumber = fromRow?.value;

      let generated = 0, sent = 0, bonuses = 0;
      const results: { name: string; code: string; sent: boolean; note: string }[] = [];

      for (const c of birthdays) {
        const code = `BDAY-${c.id}-${mmdd}`;
        const isGold = !!c.gold_member || c.lifetime_points >= 1500;
        const benefit = isGold
          ? { kind: 'free_category', value: 0, category: 'Vape' }   // free disposable
          : { kind: 'discount_amount', value: 5, category: null };  // $5 off
        const ins = db.prepare(
          `INSERT OR IGNORE INTO promo_codes (code, customer_id, kind, discount_pct, benefit_kind, benefit_value, benefit_category, expires_at)
           VALUES (?, ?, ?, 0, ?, ?, ?, ?)`
        ).run(code, c.id, isGold ? 'birthday_gold' : 'birthday', benefit.kind, benefit.value, benefit.category, expires);
        if (ins.changes > 0) generated++;

        // +50 loyalty birthday bonus, once per calendar year
        const gotBonus = db.prepare(
          `SELECT 1 FROM loyalty_ledger WHERE customer_id = ? AND reason = 'birthday'
            AND substr(created_at, 1, 4) = ?`
        ).get(c.id, String(year));
        if (!gotBonus) {
          const newBal = (c.loyalty_points || 0) + 50;
          db.prepare(`INSERT INTO loyalty_ledger (customer_id, change, reason, balance_after) VALUES (?, 50, 'birthday', ?)`)
            .run(c.id, newBal);
          db.prepare(`UPDATE customers SET loyalty_points = loyalty_points + 50, lifetime_points = lifetime_points + 50, updated_at = ? WHERE id = ?`)
            .run(nowCT(), c.id);
          bonuses++;
        }

        // SMS
        let didSend = false, note = '';
        const digits = (c.phone || '').replace(/\D/g, '');
        if (!c.opt_in_sms) note = 'not opted in';
        else if (!digits) note = 'no phone';
        else if (!client || !fromNumber) note = 'Twilio not configured';
        else {
          try {
            const reward = isGold ? 'a FREE disposable on us' : '$5 off your next visit';
            const body = `Happy Birthday, ${c.first_name}! Enjoy ${reward} (7 days). Code: ${code}. Reply STOP to unsubscribe`;
            await client.messages.create({ body, from: fromNumber, to: digits.startsWith('1') ? `+${digits}` : `+1${digits}` });
            didSend = true; sent++; note = 'sent';
          } catch (e) { note = 'send failed'; }
        }
        results.push({ name: `${c.first_name} ${c.last_name}`, code, sent: didSend, note });
      }

      return { success: true, count: birthdays.length, generated, sent, bonuses, results };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Validate a promo code at checkout.
  ipcMain.handle('promos:validate', async (_event, code: string) => {
    try {
      const db = getDb();
      const c = (code || '').trim().toUpperCase();
      if (!c) return { success: false, error: 'Enter a code' };
      const row = db.prepare(`
        SELECT p.*, cu.first_name, cu.last_name
        FROM promo_codes p LEFT JOIN customers cu ON cu.id = p.customer_id
        WHERE p.code = ?
      `).get(c) as {
        code: string; customer_id: number | null; discount_pct: number; used: number;
        benefit_kind: string | null; benefit_value: number | null; benefit_category: string | null;
        expires_at: string | null; first_name: string | null; last_name: string | null;
      } | undefined;

      if (!row) return { success: false, error: 'Code not found' };
      if (row.used) return { success: false, error: 'Code already redeemed' };
      if (row.expires_at && DateTime.now().setZone(TZ).toISODate()! > row.expires_at) {
        return { success: false, error: 'Code expired' };
      }
      // Newer codes carry an explicit benefit; older ones fall back to % off.
      const benefit = row.benefit_kind
        ? { kind: row.benefit_kind, value: row.benefit_value || 0, category: row.benefit_category }
        : { kind: 'discount_pct', value: row.discount_pct, category: null };
      return {
        success: true,
        promo: {
          code: row.code, benefit, customer_id: row.customer_id,
          customer_name: row.first_name ? `${row.first_name} ${row.last_name}` : null,
        },
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
