import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { assertWritable } from '../supabase/licenseCheck';
import { printReceiptForTxn, listInstalledPrinters, testPrint, printPickupReceipt } from '../services/printer';
import { getSupabase } from '../supabase/client';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';

export function registerReceiptHandlers(): void {
  
  ipcMain.handle('printer:list', async () => {
    try {
      return { success: true, printers: await listInstalledPrinters() };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('printer:test', async () => {
    try {
      return await testPrint();
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('receipt:print', async (_event, txnId: number) => {
    try {
      const w = assertWritable('receipt_print'); if (!w.ok) return { success: false, error: w.error };
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
        SELECT ti.*, COALESCE(p.name || ' - ' || v.label, p.name, ti.description, ti.category, 'Item') AS product_name
        FROM transaction_items ti
        LEFT JOIN products p ON ti.product_id = p.id
        LEFT JOIN product_variants v ON ti.variant_id = v.id
        WHERE ti.transaction_id = ?
      `).all(txnId) as Record<string, unknown>[];

      const config = db.prepare('SELECT * FROM receipt_config WHERE id = 1').get() as Record<string, unknown>;

      
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

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  ipcMain.handle('receipt:printData', async (_event, transaction: Record<string, unknown>, items: Record<string, unknown>[]) => {
    try {
      const w = assertWritable('receipt_print'); if (!w.ok) return { success: false, error: w.error };
      if (!transaction || typeof transaction !== 'object') return { success: false, error: 'Missing transaction data' };
      const db = getDb();
      const config = db.prepare('SELECT * FROM receipt_config WHERE id = 1').get() as Record<string, unknown>;
      return await printReceiptForTxn(transaction, items || [], config);
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('receipt:reprintPickup', async (_event, orderId: string) => {
    try {
      const sb = getSupabase();
      if (!sb) return { success: false, error: 'Cloud not configured' };
      const { data: o, error } = await sb
        .from('online_orders')
        .select('order_number, subtotal, tax, online_fee, total, created_at, online_order_items(name, qty, line_total)')
        .eq('id', orderId)
        .maybeSingle();
      if (error) return { success: false, error: error.message };
      if (!o) return { success: false, error: 'Order not found' };
      const config = (getDb().prepare('SELECT * FROM receipt_config WHERE id = 1').get() as Record<string, unknown>) || {};
      const items = (o.online_order_items as { name: string; qty: number; line_total: number }[] | null) || [];
      return await printPickupReceipt(
        {
          order_number: (o.order_number as string) || String(orderId).slice(0, 8),
          items: items.map((i) => ({ qty: Number(i.qty) || 0, name: i.name, line_total: Number(i.line_total) || 0 })),
          subtotal: Number(o.subtotal) || 0, tax: Number(o.tax) || 0, online_fee: Number(o.online_fee) || 0, total: Number(o.total) || 0,
          created_at: (o.created_at as string) || null,
        },
        config
      );
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
      const w = assertWritable('settings_change'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const allowed = ['store_name', 'address', 'phone', 'footer_message', 'tax_rate', 'min_age', 'refund_policy', 'tip_enabled', 'tip_presets', 'rebate_auto_apply'];
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
