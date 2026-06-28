import { ipcMain } from 'electron';
import { DateTime } from 'luxon';
import { getDb } from '../db/schema';
import { nowCT, TZ } from '../utils/time';
import { enqueueLocalRow } from '../supabase/sync';
import { assertWritable } from '../supabase/licenseCheck';

export function registerCustomerHandlers(): void {
  ipcMain.handle('customers:getAll', async (_event, query?: string) => {
    try {
      const db = getDb();
      let sql = `
        SELECT c.*,
          COUNT(t.id) AS txn_count,
          MAX(t.created_at) AS last_visit,
          COALESCE(SUM(t.total), 0) AS total_spent
        FROM customers c
        LEFT JOIN transactions t ON t.customer_id = c.id
        WHERE 1=1
      `;
      const params: string[] = [];
      if (query) {
        sql += ` AND (c.first_name || ' ' || c.last_name LIKE ? OR c.phone LIKE ?)`;
        params.push(`%${query}%`, `%${query}%`);
      }
      sql += ' GROUP BY c.id ORDER BY c.last_name, c.first_name';
      const customers = db.prepare(sql).all(...params);
      return { success: true, customers };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('customers:getOne', async (_event, id: number) => {
    try {
      const db = getDb();
      const customer = db.prepare(`
        SELECT c.*,
          COUNT(t.id) AS txn_count,
          MAX(t.created_at) AS last_visit,
          COALESCE(SUM(t.total), 0) AS total_spent
        FROM customers c
        LEFT JOIN transactions t ON t.customer_id = c.id
        WHERE c.id = ?
        GROUP BY c.id
      `).get(id);

      if (!customer) return { success: false, error: 'Customer not found' };

      const transactions = db.prepare(`
        SELECT t.id, t.total, t.payment_method, t.created_at
        FROM transactions t
        WHERE t.customer_id = ?
        ORDER BY t.created_at DESC
        LIMIT 20
      `).all(id);

      const c = customer as { lifetime_points?: number; gold_member?: number; last_visit?: string; loyalty_points?: number };
      const lifetime = c.lifetime_points || 0;
      const gold = !!c.gold_member || lifetime >= 1500;
      const tier = gold ? 'Gold' : lifetime >= 500 ? 'Silver' : 'Member';
      const next = gold ? null : lifetime >= 500 ? 1500 : 500;

      // "Use it or lose it" — points expire after N days of inactivity
      let expiring_soon = false, expires_on: string | null = null;
      if ((c.loyalty_points || 0) > 0 && c.last_visit) {
        const expRow = db.prepare("SELECT value FROM settings WHERE key = 'loyalty_expiry_days'").get() as { value: string } | undefined;
        const expiryDays = parseInt(expRow?.value || '365', 10) || 365;
        const last = DateTime.fromISO(c.last_visit, { zone: TZ });
        if (last.isValid) {
          const expDate = last.plus({ days: expiryDays });
          const daysLeft = expDate.diff(DateTime.now().setZone(TZ), 'days').days;
          if (daysLeft <= 90) { expiring_soon = true; expires_on = expDate.toISODate(); }
        }
      }

      const loyalty_ledger = db.prepare(`
        SELECT change, reason, balance_after, created_at
        FROM loyalty_ledger WHERE customer_id = ?
        ORDER BY id DESC LIMIT 15
      `).all(id);

      return { success: true, customer, transactions, loyalty: { tier, gold, next_tier_at: next, expiring_soon, expires_on, ledger: loyalty_ledger } };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Upsell — products commonly bought alongside what this customer already buys,
  // that they haven't purchased themselves (market-basket co-purchase, no AI).
  ipcMain.handle('customers:upsell', async (_event, id: number) => {
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT p.id, p.name, p.price, COUNT(*) AS score
        FROM transactions t
        JOIN transaction_items mine ON mine.transaction_id = t.id
        JOIN transactions ot ON ot.id IN (
          SELECT ti2.transaction_id FROM transaction_items ti2 WHERE ti2.product_id = mine.product_id
        )
        JOIN transaction_items other ON other.transaction_id = ot.id
        JOIN products p ON p.id = other.product_id
        WHERE t.customer_id = ?
          AND other.product_id NOT IN (
            SELECT DISTINCT ti3.product_id FROM transaction_items ti3
            JOIN transactions t3 ON t3.id = ti3.transaction_id
            WHERE t3.customer_id = ? AND ti3.product_id IS NOT NULL
          )
          AND other.product_id IS NOT NULL
        GROUP BY p.id
        ORDER BY score DESC
        LIMIT 3
      `).all(id, id);
      return { success: true, upsell: rows };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('customers:search', async (_event, query: string) => {
    try {
      const db = getDb();
      const like = `%${query}%`;
      const customers = db.prepare(`
        SELECT * FROM customers
        WHERE first_name || ' ' || last_name LIKE ? OR phone LIKE ? OR email LIKE ?
        ORDER BY last_name, first_name LIMIT 20
      `).all(like, like, like);
      return { success: true, customers };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Find an existing customer for a scanned ID, to avoid creating duplicates.
  // Matches first on license number, then on first+last+DOB.
  ipcMain.handle('customers:findForId', async (_event, q: {
    license_number?: string; first_name?: string; last_name?: string; dob?: string;
  }) => {
    try {
      const db = getDb();
      let row: unknown = null;
      if (q.license_number) {
        row = db.prepare('SELECT * FROM customers WHERE license_number = ?').get(q.license_number);
      }
      if (!row && q.first_name && q.last_name && q.dob) {
        row = db.prepare(
          `SELECT * FROM customers
           WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?) AND dob = ?`
        ).get(q.first_name, q.last_name, q.dob);
      }
      return { success: true, customer: row || null };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('customers:add', async (_event, data: {
    first_name: string; last_name: string; phone?: string;
    email?: string; address?: string; city?: string; state?: string;
    zip?: string; dob?: string; license_number?: string; notes?: string; opt_in_sms?: boolean;
  }) => {
    try {
      const w = assertWritable('customer_edit'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const id = db.transaction(() => {
        const result = db.prepare(`
          INSERT INTO customers (first_name, last_name, phone, email, address, city, state, zip, dob, license_number, notes, opt_in_sms)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          data.first_name,
          data.last_name,
          data.phone || null,
          data.email || null,
          data.address || null,
          data.city || null,
          data.state || null,
          data.zip || null,
          data.dob || null,
          data.license_number || null,
          data.notes || null,
          data.opt_in_sms ? 1 : 0
        );
        const newId = result.lastInsertRowid as number;
        // Cloud sync (D.1): enqueue the new customer, atomic with the insert.
        enqueueLocalRow('customers', 'insert', newId, db);
        return newId;
      })();
      return { success: true, id };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('customers:update', async (_event, id: number, data: Record<string, unknown>) => {
    try {
      const w = assertWritable('customer_edit'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const allowed = ['first_name', 'last_name', 'phone', 'email', 'address', 'city', 'state', 'zip', 'dob', 'license_number', 'notes', 'opt_in_sms'];
      const fields = Object.keys(data).filter((k) => allowed.includes(k));
      if (fields.length === 0) return { success: false, error: 'No valid fields' };

      const sets = fields.map((f) => `${f} = ?`).join(', ');
      const vals = fields.map((f) => data[f]);
      db.transaction(() => {
        db.prepare(`UPDATE customers SET ${sets}, updated_at = ? WHERE id = ?`).run(...vals, nowCT(), id);
        // Cloud sync (D.1): enqueue the update, atomic with the write.
        enqueueLocalRow('customers', 'update', id, db);
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
