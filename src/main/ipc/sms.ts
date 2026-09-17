import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { getTwilioClient } from '../services/twilio';
import { buildSmsReceipt } from '../services/printer';
import { assertWritable } from '../supabase/licenseCheck';

export function registerSmsHandlers(): void {
  ipcMain.handle('sms:blast', async (_event, message: string, filter: {
    all_opted_in?: boolean;
    purchased_within_days?: number;
  }) => {
    try {
      const w = assertWritable('sms_send'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const session = getCurrentSession();
      if (session?.role !== 'manager') return { success: false, error: 'Manager access required' };

      let sql = 'SELECT * FROM customers WHERE opt_in_sms = 1';
      const params: (string | number)[] = [];

      if (filter.purchased_within_days) {
        sql += ` AND id IN (
          SELECT DISTINCT customer_id FROM transactions
          WHERE created_at >= datetime('now', '-${filter.purchased_within_days} days')
            AND customer_id IS NOT NULL
        )`;
      }

      const customers = db.prepare(sql).all(...params) as { id: number; phone: string; first_name: string }[];
      if (customers.length === 0) return { success: false, error: 'No opted-in recipients' };

      const client = getTwilioClient();
      if (!client) return { success: false, error: 'Twilio not configured' };

      const settingsRow = db.prepare("SELECT value FROM settings WHERE key = 'twilio_from_number'").get() as { value: string } | undefined;
      const fromNumber = settingsRow?.value;
      if (!fromNumber) return { success: false, error: 'Twilio from number not configured' };

      let sent = 0;
      for (const customer of customers) {
        if (!customer.phone) continue;
        try {
          await client.messages.create({
            body: message,
            from: fromNumber,
            to: `+1${customer.phone.replace(/\D/g, '')}`,
          });
          sent++;
        } catch (_e) {
          
        }
      }

      db.prepare(`
        INSERT INTO sms_blasts (message, sent_by, recipient_count)
        VALUES (?, ?, ?)
      `).run(message, session?.userId || null, sent);

      return { success: true, sent };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('sms:receipt', async (_event, txnId: number, phone: string) => {
    try {
      const db = getDb();
      const client = getTwilioClient();
      if (!client) return { success: false, error: 'Twilio not configured in Settings' };

      const settingsRow = db.prepare("SELECT value FROM settings WHERE key = 'twilio_from_number'").get() as { value: string } | undefined;
      const fromNumber = settingsRow?.value;
      if (!fromNumber) return { success: false, error: 'Twilio from number not configured' };

      const transaction = db.prepare(`
        SELECT t.*, c.first_name || ' ' || c.last_name AS customer_name, u.username AS cashier_name
        FROM transactions t
        LEFT JOIN customers c ON t.customer_id = c.id
        LEFT JOIN users u ON t.cashier_id = u.id
        WHERE t.id = ?
      `).get(txnId) as Record<string, unknown> | undefined;

      if (!transaction) return { success: false, error: 'Transaction not found' };

      const items = db.prepare(`
        SELECT ti.*, COALESCE(p.name || ' - ' || v.label, p.name) AS product_name
        FROM transaction_items ti
        LEFT JOIN products p ON ti.product_id = p.id
        LEFT JOIN product_variants v ON ti.variant_id = v.id
        WHERE ti.transaction_id = ?
      `).all(txnId) as Record<string, unknown>[];

      const config = db.prepare('SELECT * FROM receipt_config WHERE id = 1').get() as Record<string, unknown>;
      const body = buildSmsReceipt(transaction, items, config);

      const digits = phone.replace(/\D/g, '');
      const toNumber = digits.startsWith('1') ? `+${digits}` : `+1${digits}`;

      await client.messages.create({ body, from: fromNumber, to: toNumber });
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('sms:single', async (_event, phone: string, message: string) => {
    try {
      const w = assertWritable('sms_send'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const client = getTwilioClient();
      if (!client) return { success: false, error: 'Twilio not configured' };

      const settingsRow = db.prepare("SELECT value FROM settings WHERE key = 'twilio_from_number'").get() as { value: string } | undefined;
      const fromNumber = settingsRow?.value;
      if (!fromNumber) return { success: false, error: 'Twilio from number not configured' };

      await client.messages.create({
        body: message,
        from: fromNumber,
        to: `+1${phone.replace(/\D/g, '')}`,
      });

      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
