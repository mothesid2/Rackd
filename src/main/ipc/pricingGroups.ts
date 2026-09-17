import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { nowCT, todayCT } from '../utils/time';
import { assertWritable } from '../supabase/licenseCheck';



function isManager(): boolean {
  return getCurrentSession()?.role === 'manager';
}

export function registerPricingGroupHandlers(): void {
  ipcMain.handle('pricingGroups:list', () => {
    try {
      const db = getDb();
      const groups = db.prepare(`
        SELECT g.*, (SELECT COUNT(*) FROM products p WHERE p.pricing_group_uid = g.uid) AS member_count
        FROM pricing_groups g ORDER BY g.name
      `).all();
      return { success: true, groups };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('pricingGroups:listMembers', (_e, uid: string) => {
    try {
      const db = getDb();
      const products = db.prepare(
        `SELECT id, barcode, name, category, price, is_taxable, stock_qty FROM products WHERE pricing_group_uid = ? ORDER BY name`
      ).all(uid);
      return { success: true, products };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('pricingGroups:listUnassigned', (_e, query?: string) => {
    try {
      const db = getDb();
      const q = `%${(query || '').trim()}%`;
      
      
      
      const products = db.prepare(
        `SELECT id, barcode, name, category, price FROM products
         WHERE pricing_group_uid IS NULL AND (name LIKE ? OR barcode LIKE ?)
         ORDER BY name`
      ).all(q, q);
      return { success: true, products };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('pricingGroups:save', (_e, group: { uid?: string; name: string; price?: number | null; is_taxable?: boolean }) => {
    try {
      const w = assertWritable('inventory_edit'); if (!w.ok) return { success: false, error: w.error };
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const name = String(group?.name || '').trim();
      if (!name) return { success: false, error: 'Group name is required' };

      const db = getDb();
      const uid = group?.uid || randomUUID();
      const price = group?.price === null || group?.price === undefined || group.price === ('' as unknown) ? null : Number(group.price);
      const isTaxable = group?.is_taxable === false ? 0 : 1;
      const now = nowCT();

      db.transaction(() => {
        db.prepare(`
          INSERT INTO pricing_groups (uid, name, price, is_taxable, updated_at)
          VALUES (@uid, @name, @price, @taxable, @upd)
          ON CONFLICT(uid) DO UPDATE SET name=excluded.name, price=excluded.price, is_taxable=excluded.is_taxable, updated_at=excluded.updated_at
        `).run({ uid, name, price, taxable: isTaxable, upd: now });

        
        
        
        if (price !== null) {
          db.prepare(`UPDATE products SET price = ?, is_taxable = ?, updated_at = ? WHERE pricing_group_uid = ?`)
            .run(price, isTaxable, now, uid);
        } else {
          db.prepare(`UPDATE products SET is_taxable = ?, updated_at = ? WHERE pricing_group_uid = ?`)
            .run(isTaxable, now, uid);
        }
      })();
      return { success: true, uid };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('pricingGroups:delete', (_e, uid: string) => {
    try {
      const w = assertWritable('inventory_edit'); if (!w.ok) return { success: false, error: w.error };
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const db = getDb();
      db.transaction(() => {
        
        
        
        db.prepare(`UPDATE products SET pricing_group_uid = NULL WHERE pricing_group_uid = ?`).run(uid);
        db.prepare(`DELETE FROM pricing_group_promos WHERE pricing_group_uid = ?`).run(uid);
        db.prepare(`DELETE FROM pricing_groups WHERE uid = ?`).run(uid);
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  
  
  ipcMain.handle('pricingGroups:assignProduct', (_e, productId: number, groupUid: string | null) => {
    try {
      const w = assertWritable('inventory_edit'); if (!w.ok) return { success: false, error: w.error };
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const db = getDb();
      const now = nowCT();
      db.transaction(() => {
        db.prepare(`UPDATE products SET pricing_group_uid = ?, updated_at = ? WHERE id = ?`).run(groupUid, now, productId);
        if (groupUid) {
          const g = db.prepare(`SELECT price, is_taxable FROM pricing_groups WHERE uid = ?`).get(groupUid) as
            { price: number | null; is_taxable: number } | undefined;
          if (g) {
            if (g.price !== null && g.price !== undefined) {
              db.prepare(`UPDATE products SET price = ?, is_taxable = ? WHERE id = ?`).run(g.price, g.is_taxable, productId);
            } else {
              db.prepare(`UPDATE products SET is_taxable = ? WHERE id = ?`).run(g.is_taxable, productId);
            }
          }
        }
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  ipcMain.handle('pricingGroups:assignProducts', (_e, productIds: number[], groupUid: string) => {
    try {
      const w = assertWritable('inventory_edit'); if (!w.ok) return { success: false, error: w.error };
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const db = getDb();
      const now = nowCT();
      const g = db.prepare(`SELECT price, is_taxable FROM pricing_groups WHERE uid = ?`).get(groupUid) as
        { price: number | null; is_taxable: number } | undefined;
      if (!g) return { success: false, error: 'Pricing group not found' };

      db.transaction(() => {
        for (const productId of productIds || []) {
          db.prepare(`UPDATE products SET pricing_group_uid = ?, updated_at = ? WHERE id = ?`).run(groupUid, now, productId);
          if (g.price !== null && g.price !== undefined) {
            db.prepare(`UPDATE products SET price = ?, is_taxable = ? WHERE id = ?`).run(g.price, g.is_taxable, productId);
          } else {
            db.prepare(`UPDATE products SET is_taxable = ? WHERE id = ?`).run(g.is_taxable, productId);
          }
        }
      })();
      return { success: true, count: (productIds || []).length };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('pricingGroups:listPromos', () => {
    try {
      const db = getDb();
      const promos = db.prepare(`
        SELECT p.*, g.name AS group_name
        FROM pricing_group_promos p
        JOIN pricing_groups g ON g.uid = p.pricing_group_uid
        ORDER BY p.is_active DESC, p.updated_at DESC
      `).all();
      return { success: true, promos };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('pricingGroups:savePromo', (_e, promo: Record<string, unknown>) => {
    try {
      const w = assertWritable('inventory_edit'); if (!w.ok) return { success: false, error: w.error };
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const name = String(promo?.name || '').trim();
      if (!name) return { success: false, error: 'Promo name is required' };
      const groupUid = String(promo?.pricing_group_uid || '');
      if (!groupUid) return { success: false, error: 'Pick a pricing group' };

      const db = getDb();
      const uid = (promo?.uid as string) || randomUUID();
      const now = nowCT();
      db.prepare(`
        INSERT INTO pricing_group_promos (uid, pricing_group_uid, name, buy_qty, discount_qty, discount_type, discount_amount, is_active, active_start_date, active_end_date, updated_at)
        VALUES (@uid,@group,@name,@buyQty,@discQty,@dtype,@amt,@active,@start,@end,@upd)
        ON CONFLICT(uid) DO UPDATE SET pricing_group_uid=excluded.pricing_group_uid, name=excluded.name, buy_qty=excluded.buy_qty,
          discount_qty=excluded.discount_qty, discount_type=excluded.discount_type, discount_amount=excluded.discount_amount,
          is_active=excluded.is_active, active_start_date=excluded.active_start_date, active_end_date=excluded.active_end_date,
          updated_at=excluded.updated_at
      `).run({
        uid,
        group: groupUid,
        name,
        buyQty: Math.max(2, parseInt(String(promo?.buy_qty), 10) || 2),
        discQty: Math.max(1, parseInt(String(promo?.discount_qty), 10) || 1),
        dtype: (promo?.discount_type as string) === 'flat' ? 'flat' : 'percent',
        amt: Math.max(0, parseFloat(String(promo?.discount_amount)) || 0),
        active: promo?.is_active === false ? 0 : 1,
        start: (promo?.active_start_date as string) || null,
        end: (promo?.active_end_date as string) || null,
        upd: now,
      });
      return { success: true, uid };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('pricingGroups:setPromoActive', (_e, uid: string, active: boolean) => {
    try {
      const w = assertWritable('inventory_edit'); if (!w.ok) return { success: false, error: w.error };
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const db = getDb();
      db.prepare(`UPDATE pricing_group_promos SET is_active = ?, updated_at = ? WHERE uid = ?`).run(active ? 1 : 0, nowCT(), uid);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  ipcMain.handle('pricingGroups:activePromos', () => {
    try {
      const db = getDb();
      
      
      
      
      
      
      
      
      const today = todayCT();
      const promos = db.prepare(`
        SELECT * FROM pricing_group_promos
        WHERE is_active = 1
          AND (active_start_date IS NULL OR active_start_date <= ?)
          AND (active_end_date   IS NULL OR active_end_date   >= ?)
      `).all(today, today);
      return { success: true, promos };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
