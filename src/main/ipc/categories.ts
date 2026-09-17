import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { nowCT } from '../utils/time';
import { assertWritable } from '../supabase/licenseCheck';
import { enqueueInventorySnapshot, enqueueCategory } from '../supabase/sync';



function isManager(): boolean {
  return getCurrentSession()?.role === 'manager';
}

export function registerCategoryHandlers(): void {
  ipcMain.handle('categories:list', () => {
    try {
      const db = getDb();
      const categories = db.prepare(`
        SELECT c.id, c.name, c.created_at, c.updated_at,
               (SELECT COUNT(*) FROM products p WHERE p.category = c.name COLLATE NOCASE) AS item_count
        FROM categories c WHERE c.is_active = 1 ORDER BY c.name COLLATE NOCASE
      `).all();
      return { success: true, categories };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  
  ipcMain.handle('categories:names', () => {
    try {
      const names = getDb().prepare(`SELECT name FROM categories WHERE is_active = 1 ORDER BY name COLLATE NOCASE`).all().map((r) => (r as { name: string }).name);
      return { success: true, names };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('categories:listMembers', (_e, name: string) => {
    try {
      const db = getDb();
      const products = db.prepare(
        `SELECT id, barcode, name, vendor, price, stock_qty FROM products WHERE category = ? COLLATE NOCASE ORDER BY name`
      ).all(name);
      return { success: true, products };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  
  
  ipcMain.handle('categories:listUnassigned', (_e, name: string, query?: string) => {
    try {
      const db = getDb();
      const q = `%${(query || '').trim()}%`;
      const products = db.prepare(
        `SELECT id, barcode, name, vendor, price, category FROM products
         WHERE (category IS NULL OR category <> ? COLLATE NOCASE) AND (name LIKE ? OR barcode LIKE ?)
         ORDER BY name`
      ).all(name, q, q);
      return { success: true, products };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('categories:create', (_e, name: string) => {
    try {
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const clean = (name || '').trim();
      if (!clean) return { success: false, error: 'Enter a category name' };
      const db = getDb();
      const uid = randomUUID();
      try {
        db.prepare(`INSERT INTO categories (uid, name) VALUES (?, ?)`).run(uid, clean);
      } catch (e) {
        if (/UNIQUE/i.test(String(e))) return { success: false, error: `"${clean}" already exists` };
        throw e;
      }
      enqueueCategory('insert', uid, db);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  
  ipcMain.handle('categories:rename', (_e, id: number, newName: string) => {
    try {
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const clean = (newName || '').trim();
      if (!clean) return { success: false, error: 'Enter a category name' };
      const db = getDb();
      const cat = db.prepare(`SELECT uid, name FROM categories WHERE id = ?`).get(id) as { uid: string; name: string } | undefined;
      if (!cat) return { success: false, error: 'Category not found' };

      db.transaction(() => {
        try {
          db.prepare(`UPDATE categories SET name = ?, updated_at = ? WHERE id = ?`).run(clean, nowCT(), id);
        } catch (e) {
          if (/UNIQUE/i.test(String(e))) throw new Error(`"${clean}" already exists`);
          throw e;
        }
        enqueueCategory('update', cat.uid, db);
        const members = db.prepare(`SELECT id FROM products WHERE category = ? COLLATE NOCASE`).all(cat.name) as { id: number }[];
        for (const m of members) {
          db.prepare(`UPDATE products SET category = ?, updated_at = ? WHERE id = ?`).run(clean, nowCT(), m.id);
          enqueueInventorySnapshot(m.id, 'manual', db);
        }
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String((err as Error)?.message || err) };
    }
  });

  
  
  
  
  
  
  ipcMain.handle('categories:delete', (_e, id: number) => {
    try {
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const db = getDb();
      const cat = db.prepare(`SELECT uid, name FROM categories WHERE id = ?`).get(id) as { uid: string; name: string } | undefined;
      if (!cat) return { success: false, error: 'Category not found' };

      let cleared = 0;
      db.transaction(() => {
        const members = db.prepare(`SELECT id FROM products WHERE category = ? COLLATE NOCASE`).all(cat.name) as { id: number }[];
        for (const m of members) {
          db.prepare(`UPDATE products SET category = '', updated_at = ? WHERE id = ?`).run(nowCT(), m.id);
          enqueueInventorySnapshot(m.id, 'manual', db);
        }
        cleared = members.length;
        db.prepare(`UPDATE categories SET is_active = 0, updated_at = ? WHERE id = ?`).run(nowCT(), id);
        enqueueCategory('update', cat.uid, db);
      })();
      return { success: true, cleared };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('categories:addItems', (_e, name: string, productIds: number[]) => {
    try {
      const w = assertWritable('inventory_edit'); if (!w.ok) return { success: false, error: w.error };
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const db = getDb();
      const cat = db.prepare(`SELECT name FROM categories WHERE name = ? COLLATE NOCASE AND is_active = 1`).get(name) as { name: string } | undefined;
      if (!cat) return { success: false, error: 'Category not found' };

      db.transaction(() => {
        for (const id of productIds || []) {
          db.prepare(`UPDATE products SET category = ?, updated_at = ? WHERE id = ?`).run(cat.name, nowCT(), id);
          enqueueInventorySnapshot(id, 'manual', db);
        }
      })();
      return { success: true, count: (productIds || []).length };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  ipcMain.handle('categories:removeItems', (_e, productIds: number[]) => {
    try {
      const w = assertWritable('inventory_edit'); if (!w.ok) return { success: false, error: w.error };
      if (!isManager()) return { success: false, error: 'Manager access required' };
      const db = getDb();
      db.transaction(() => {
        for (const id of productIds || []) {
          db.prepare(`UPDATE products SET category = '', updated_at = ? WHERE id = ?`).run(nowCT(), id);
          enqueueInventorySnapshot(id, 'manual', db);
        }
      })();
      return { success: true, count: (productIds || []).length };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
