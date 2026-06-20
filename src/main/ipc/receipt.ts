import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { printReceiptForTxn } from '../services/printer';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

export function registerReceiptHandlers(): void {
  ipcMain.handle('receipt:print', async (_event, txnId: number) => {
    try {
      const db = getDb();
      const transaction = db.prepare(`
        SELECT t.*,
          c.first_name || ' ' || c.last_name AS customer_name,
          u.username AS cashier_name
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

      // Loyalty footer info (points earned on this sale + current balance)
      if (transaction.customer_id) {
        const earnedRow = db.prepare(
          `SELECT COALESCE(SUM(change), 0) AS earned FROM loyalty_ledger WHERE transaction_id = ? AND reason = 'earn'`
        ).get(transaction.id) as { earned: number };
        const balRow = db.prepare('SELECT loyalty_points, lifetime_points, gold_member FROM customers WHERE id = ?')
          .get(transaction.customer_id) as { loyalty_points: number; lifetime_points: number; gold_member: number } | undefined;
        transaction.points_earned = earnedRow?.earned || 0;
        transaction.points_balance = balRow?.loyalty_points ?? null;
        transaction.is_gold = balRow ? (balRow.gold_member || balRow.lifetime_points >= 1500 ? 1 : 0) : 0;
      }

      const result = await printReceiptForTxn(transaction, items, config);
      return result;
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('receipt:getConfig', async () => {
    try {
      const db = getDb();
      const config = db.prepare('SELECT * FROM receipt_config WHERE id = 1').get();
      return { success: true, config };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('receipt:updateConfig', async (_event, data: Record<string, unknown>) => {
    try {
      const db = getDb();
      const allowed = ['store_name', 'address', 'phone', 'footer_message', 'tax_rate', 'min_age'];
      const fields = Object.keys(data).filter((k) => allowed.includes(k));
      if (fields.length === 0) return { success: false, error: 'No valid fields' };

      const sets = fields.map((f) => `${f} = ?`).join(', ');
      const vals = fields.map((f) => data[f]);
      db.prepare(`UPDATE receipt_config SET ${sets} WHERE id = 1`).run(...vals);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
