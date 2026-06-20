import { ipcMain } from 'electron';
import { DateTime } from 'luxon';
import { getDb } from '../db/schema';
import { nowCT, TZ } from '../utils/time';
import { getCurrentSession } from './auth';

export function registerProductHandlers(): void {
  ipcMain.handle('products:getAll', async (_event, filters?: { category?: string; lowStock?: boolean }) => {
    try {
      const db = getDb();
      let sql = 'SELECT * FROM products WHERE 1=1';
      const params: (string | number)[] = [];

      if (filters?.category) {
        sql += ' AND category = ?';
        params.push(filters.category);
      }
      if (filters?.lowStock) {
        sql += ' AND stock_qty <= low_stock_threshold';
      }
      sql += ' ORDER BY name';
      const rows = db.prepare(sql).all(...params);
      return { success: true, products: rows };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:getByBarcode', async (_event, barcode: string) => {
    try {
      const db = getDb();
      let product = db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode) as Record<string, unknown> | undefined;
      // Fall back to a variant barcode — return a product-like object for the cart
      if (!product) {
        const v = db.prepare('SELECT * FROM product_variants WHERE barcode = ? AND is_active = 1').get(barcode) as {
          id: number; product_id: number; label: string; price: number; stock_qty: number; sku: string;
        } | undefined;
        if (v) {
          const parent = db.prepare('SELECT * FROM products WHERE id = ?').get(v.product_id) as Record<string, unknown> | undefined;
          if (parent) {
            product = {
              ...parent, name: `${parent.name} — ${v.label}`,
              price: v.price, stock_qty: v.stock_qty,
              variant_id: v.id, variant_sku: v.sku, variant_label: v.label,
            };
          }
        }
      }
      return { success: true, product };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:getVariants', async (_event, productId: number) => {
    try {
      const db = getDb();
      const variants = db.prepare('SELECT * FROM product_variants WHERE product_id = ? ORDER BY label').all(productId);
      return { success: true, variants };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:addVariants', async (_event, productId: number, rows: Array<{
    sku?: string; label: string; barcode?: string; price?: number; cost?: number; stock_qty?: number;
  }>) => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      const insert = db.prepare(`
        INSERT OR IGNORE INTO product_variants (product_id, sku, label, barcode, price, cost, stock_qty)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      let added = 0; const skipped: string[] = [];
      db.transaction(() => {
        for (const r of rows) {
          if (!r.label) continue;
          const res = insert.run(productId, r.sku || null, r.label, r.barcode || null,
            r.price || 0, r.cost || 0, r.stock_qty || 0);
          if (res.changes > 0) added++; else skipped.push(r.sku || r.label);
        }
      })();
      return { success: true, added, skipped };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:updateVariant', async (_event, id: number, data: Record<string, unknown>) => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      const allowed = ['sku', 'label', 'barcode', 'price', 'cost', 'stock_qty', 'is_active'];
      const fields = Object.keys(data).filter((k) => allowed.includes(k));
      if (fields.length === 0) return { success: false, error: 'No valid fields' };
      const sets = fields.map((f) => `${f} = ?`).join(', ');
      db.prepare(`UPDATE product_variants SET ${sets} WHERE id = ?`).run(...fields.map((f) => data[f]), id);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:deleteVariant', async (_event, id: number) => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      db.prepare('DELETE FROM product_variants WHERE id = ?').run(id);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:search', async (_event, query: string) => {
    try {
      const db = getDb();
      const like = `%${query}%`;
      const products = db
        .prepare(
          'SELECT * FROM products WHERE name LIKE ? OR barcode LIKE ? OR category LIKE ? ORDER BY name LIMIT 30'
        )
        .all(like, like, like);
      return { success: true, products };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:add', async (_event, product: {
    barcode?: string; name: string; category?: string; vendor?: string;
    price: number; cost: number; stock_qty: number; low_stock_threshold: number;
    age_restricted?: number;
  }) => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      const result = db
        .prepare(
          `INSERT INTO products (barcode, name, category, vendor, price, cost, stock_qty, low_stock_threshold, age_restricted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          product.barcode || null,
          product.name,
          product.category || null,
          product.vendor || null,
          product.price,
          product.cost,
          product.stock_qty,
          product.low_stock_threshold,
          product.age_restricted ? 1 : 0
        );
      return { success: true, id: result.lastInsertRowid };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:update', async (_event, id: number, data: Record<string, unknown>) => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      const allowed = ['barcode', 'name', 'category', 'vendor', 'price', 'cost', 'stock_qty', 'low_stock_threshold', 'age_restricted'];
      const fields = Object.keys(data).filter((k) => allowed.includes(k));
      if (fields.length === 0) return { success: false, error: 'No valid fields' };

      const sets = fields.map((f) => `${f} = ?`).join(', ');
      const vals = fields.map((f) => data[f]);
      db.prepare(`UPDATE products SET ${sets}, updated_at = ? WHERE id = ?`).run(...vals, nowCT(), id);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:adjustStock', async (_event, id: number, delta: number, _reason: string) => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      db.prepare(
        `UPDATE products SET stock_qty = MAX(0, stock_qty + ?), updated_at = ? WHERE id = ?`
      ).run(delta, nowCT(), id);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:clearAll', async () => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      db.transaction(() => {
        db.exec(`UPDATE transaction_items SET product_id = NULL`);
        db.exec(`DELETE FROM invoice_items`);
        db.exec(`DELETE FROM products`);
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:delete', async (_event, id: number) => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      db.transaction(() => {
        db.prepare(`UPDATE transaction_items SET product_id = NULL WHERE product_id = ?`).run(id);
        db.prepare(`DELETE FROM invoice_items WHERE product_id = ?`).run(id);
        db.prepare(`DELETE FROM products WHERE id = ?`).run(id);
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:getSaleHistory', async (_event, productId: number) => {
    try {
      const db = getDb();
      const rows = db.prepare(`
        SELECT ti.qty, ti.unit_price, ti.line_total,
               t.id AS txn_id, t.created_at, t.payment_method,
               u.username AS cashier_name
        FROM transaction_items ti
        JOIN transactions t ON t.id = ti.transaction_id
        LEFT JOIN users u ON u.id = t.cashier_id
        WHERE ti.product_id = ?
        ORDER BY t.created_at DESC
        LIMIT 200
      `).all(productId);
      return { success: true, history: rows };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Reorder report — sales velocity + days-of-stock remaining, no AI required.
  ipcMain.handle('products:reorderReport', async (_event, windowDays = 30) => {
    try {
      const db = getDb();
      const days = Math.max(1, Number(windowDays) || 30);
      const cutoff = DateTime.now().setZone(TZ).minus({ days }).toISODate();

      // Units sold per product within the window (returns excluded via qty > 0)
      const rows = db.prepare(`
        SELECT p.id, p.name, p.barcode, p.vendor, p.category,
               p.stock_qty + COALESCE(vs.vstock, 0) AS stock_qty,
               p.low_stock_threshold,
               COALESCE(SUM(CASE WHEN t.id IS NOT NULL AND ti.qty > 0 THEN ti.qty ELSE 0 END), 0) AS sold
        FROM products p
        LEFT JOIN (SELECT product_id, SUM(stock_qty) AS vstock FROM product_variants GROUP BY product_id) vs
          ON vs.product_id = p.id
        LEFT JOIN transaction_items ti ON ti.product_id = p.id
        LEFT JOIN transactions t
          ON t.id = ti.transaction_id
         AND t.payment_status = 'completed'
         AND substr(t.created_at, 1, 10) >= ?
        GROUP BY p.id
        ORDER BY p.name
      `).all(cutoff) as Array<{
        id: number; name: string; barcode: string | null; vendor: string | null;
        category: string | null; stock_qty: number; low_stock_threshold: number; sold: number;
      }>;

      const reorder: object[] = [];
      const deadStock: object[] = [];

      for (const r of rows) {
        const velocity = r.sold / days;                       // units per day
        const daysRemaining = velocity > 0 ? r.stock_qty / velocity : null;
        const targetStock = Math.ceil(r.sold * 1.2);          // 30-day demand + 20% buffer
        const suggestedQty = Math.max(0, targetStock - r.stock_qty);

        // Dead stock: nothing sold in the window but stock is sitting on the shelf
        if (r.sold === 0) {
          if (r.stock_qty > 0) {
            deadStock.push({
              id: r.id, name: r.name, vendor: r.vendor,
              category: r.category, stock_qty: r.stock_qty,
            });
          }
          continue;
        }

        // Surface items that are low on stock or will run out within the window
        const lowStock = r.stock_qty <= r.low_stock_threshold;
        const runningOut = daysRemaining != null && daysRemaining <= 14;
        if (!lowStock && !runningOut) continue;

        let priority: 'CRITICAL' | 'URGENT' | 'NORMAL' = 'NORMAL';
        if (daysRemaining != null) {
          if (daysRemaining <= 3) priority = 'CRITICAL';
          else if (daysRemaining <= 7) priority = 'URGENT';
        }
        if (r.stock_qty === 0) priority = 'CRITICAL';

        reorder.push({
          id: r.id, name: r.name, barcode: r.barcode, vendor: r.vendor, category: r.category,
          current_stock: r.stock_qty, low_stock_threshold: r.low_stock_threshold,
          sold_30d: r.sold, daily_velocity: Math.round(velocity * 100) / 100,
          days_remaining: daysRemaining == null ? null : Math.floor(daysRemaining),
          suggested_qty: suggestedQty, priority,
        });
      }

      const order = { CRITICAL: 0, URGENT: 1, NORMAL: 2 } as const;
      reorder.sort((a, b) =>
        order[(a as { priority: keyof typeof order }).priority] -
        order[(b as { priority: keyof typeof order }).priority] ||
        ((a as { days_remaining: number | null }).days_remaining ?? 1e9) -
        ((b as { days_remaining: number | null }).days_remaining ?? 1e9));

      return { success: true, windowDays: days, reorder, deadStock };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('products:importCSV', async (_event, csvText: string) => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      const lines = csvText.trim().split('\n');
      if (lines.length < 2) return { success: false, error: 'No data rows' };

      const headers = lines[0].split(',').map((h) => h.trim().toLowerCase());
      let imported = 0;

      const insert = db.prepare(`
        INSERT OR REPLACE INTO products (barcode, name, category, vendor, price, cost, stock_qty, low_stock_threshold, age_restricted)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const truthy = (v: string) => /^(1|y|yes|true|t)$/i.test(v.trim());

      const insertMany = db.transaction((rows: string[][]) => {
        for (const row of rows) {
          const get = (key: string) => row[headers.indexOf(key)]?.trim() || '';
          insert.run(
            get('barcode') || null,
            get('name'),
            get('category') || null,
            get('vendor') || get('brand') || null,
            parseFloat(get('price')) || 0,
            parseFloat(get('cost')) || 0,
            parseInt(get('stock_qty') || get('stock')) || 0,
            parseInt(get('low_stock_threshold') || get('threshold')) || 5,
            truthy(get('age_restricted') || get('age_restriction') || get('21+')) ? 1 : 0
          );
          imported++;
        }
      });

      const rows = lines.slice(1).map((l) => l.split(','));
      insertMany(rows);
      return { success: true, imported };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
