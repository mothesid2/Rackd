import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { nowCT, todayCT } from '../utils/time';
import { assertWritable } from '../supabase/licenseCheck';
import { enqueueRebateRule, enqueueAppliedRebate, enqueueMissedRebate } from '../supabase/sync';
import { getMachineId } from '../supabase/tokenManager';



function isManager(): boolean {
  return getCurrentSession()?.role === 'manager';
}
function safeParse(s: unknown): string[] {
  try { const a = JSON.parse(String(s || '[]')); return Array.isArray(a) ? a.map(String) : []; } catch { return []; }
}

export function registerRebateHandlers(): void {
  
  ipcMain.handle('rebates:listManufacturers', () => {
    try {
      const db = getDb();
      const manufacturers = db
        .prepare('SELECT uid, name, parent_company_code FROM manufacturers WHERE is_active = 1 ORDER BY name')
        .all();
      return { success: true, manufacturers };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('rebates:listRules', () => {
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT r.*, m.name AS manufacturer_name
        FROM rebate_rules r
        LEFT JOIN manufacturers m ON r.manufacturer_uid = m.uid
        ORDER BY r.is_active DESC, r.updated_at DESC
      `).all() as Record<string, unknown>[];
      const rules = rows.map((r) => ({ ...r, qualifying_skus: safeParse(r.qualifying_skus) }));
      return { success: true, rules };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('rebates:saveRule', (_e, rule: Record<string, unknown>) => {
    try {
      const w = assertWritable('settings_change'); if (!w.ok) return { success: false, error: w.error };
      if (!isManager()) return { success: false, error: 'Manager access required' };

      const name = String(rule?.name || '').trim();
      if (!name) return { success: false, error: 'Rule name is required' };
      const skus = Array.isArray(rule?.qualifying_skus) ? (rule.qualifying_skus as unknown[]).map(String) : [];
      if (!skus.length) return { success: false, error: 'Add at least one qualifying SKU' };

      const db = getDb();
      const isNew = !rule?.uid;
      const uid = (rule?.uid as string) || randomUUID();
      const now = nowCT();
      db.transaction(() => {
        db.prepare(`
          INSERT INTO rebate_rules (uid, manufacturer_uid, name, rule_type, qualifying_skus, qualifying_quantity,
            discount_amount, discount_type, is_manufacturer_funded, active_start_date, active_end_date, is_active, updated_at)
          VALUES (@uid,@mfr,@name,@type,@skus,@qty,@amt,@dtype,@funded,@start,@end,@active,@upd)
          ON CONFLICT(uid) DO UPDATE SET manufacturer_uid=excluded.manufacturer_uid, name=excluded.name, rule_type=excluded.rule_type,
            qualifying_skus=excluded.qualifying_skus, qualifying_quantity=excluded.qualifying_quantity, discount_amount=excluded.discount_amount,
            discount_type=excluded.discount_type, is_manufacturer_funded=excluded.is_manufacturer_funded,
            active_start_date=excluded.active_start_date, active_end_date=excluded.active_end_date, is_active=excluded.is_active,
            updated_at=excluded.updated_at
        `).run({
          uid,
          mfr: (rule?.manufacturer_uid as string) || null,
          name,
          type: (rule?.rule_type as string) || 'flat_discount',
          skus: JSON.stringify(skus),
          qty: Math.max(1, parseInt(String(rule?.qualifying_quantity), 10) || 1),
          amt: Math.max(0, parseFloat(String(rule?.discount_amount)) || 0),
          dtype: (rule?.discount_type as string) === 'percent' ? 'percent' : 'flat',
          funded: rule?.is_manufacturer_funded === false ? 0 : 1,
          start: (rule?.active_start_date as string) || null,
          end: (rule?.active_end_date as string) || null,
          active: rule?.is_active === false ? 0 : 1,
          upd: now,
        });
        enqueueRebateRule(isNew ? 'insert' : 'update', uid, db);
      })();
      return { success: true, uid };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('rebates:activeRules', () => {
    try {
      const db = getDb();
      
      
      
      
      
      const today = todayCT();
      const rows = db.prepare(`
        SELECT * FROM rebate_rules
        WHERE is_active = 1
          AND (active_start_date IS NULL OR active_start_date <= ?)
          AND (active_end_date   IS NULL OR active_end_date   >= ?)
      `).all(today, today) as Record<string, unknown>[];
      const rules = rows.map((r) => ({
        ...r,
        qualifying_skus: safeParse(r.qualifying_skus),
        is_manufacturer_funded: !!r.is_manufacturer_funded,
        
        
        
        
        
        is_taxable_discount: !r.is_manufacturer_funded,
      }));
      return { success: true, rules };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('rebates:recordApplied', (_e, transactionId: number, list: Record<string, unknown>[]) => {
    try {
      const w = assertWritable('sale'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const reg = getMachineId(db);
      db.transaction(() => {
        for (const a of list || []) {
          const uid = randomUUID();
          db.prepare(`
            INSERT INTO applied_rebates (uid, transaction_id, rebate_rule_uid, manufacturer_uid, barcode,
              discount_amount, is_manufacturer_funded, was_auto_applied, register_id, applied_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(uid, transactionId, (a.rule_uid as string) || null, (a.manufacturer_uid as string) || null,
            (a.barcode as string) || null, Number(a.discount) || 0, a.is_manufacturer_funded ? 1 : 0,
            a.was_auto_applied ? 1 : 0, reg, nowCT());
          enqueueAppliedRebate(uid, db);
        }
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  ipcMain.handle('rebates:recordMissed', (_e, transactionId: number, list: Record<string, unknown>[]) => {
    try {
      const w = assertWritable('sale'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const reg = getMachineId(db);
      db.transaction(() => {
        for (const m of list || []) {
          const uid = randomUUID();
          db.prepare(`
            INSERT INTO missed_rebates (uid, transaction_id, rebate_rule_uid, manufacturer_uid, barcode, potential_discount, register_id, detected_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `).run(uid, transactionId, (m.rule_uid as string) || null, (m.manufacturer_uid as string) || null,
            (m.barcode as string) || null, Number(m.potential_discount) || 0, reg, nowCT());
          enqueueMissedRebate(uid, db);
        }
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('rebates:setRuleActive', (_e, uid: string, active: boolean) => {
    try {
      const w = assertWritable('settings_change'); if (!w.ok) return { success: false, error: w.error };
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const db = getDb();
      db.transaction(() => {
        db.prepare('UPDATE rebate_rules SET is_active = ?, updated_at = ? WHERE uid = ?').run(active ? 1 : 0, nowCT(), uid);
        enqueueRebateRule('update', uid, db);
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
