import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration002: Migration = {
  id: 2,
  name: 'drop_unused_inventory',

  up(db: Database.Database) {
    const exists = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory'")
      .get();
    if (!exists) {
      console.log('[migration 002] inventory table not present — nothing to consolidate.');
      return;
    }

    const invCount = (db.prepare('SELECT COUNT(*) AS n FROM inventory').get() as { n: number }).n;
    const productsBefore = (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n;

    if (invCount > 0) {
      db.exec(`
        INSERT INTO products (barcode, name, category, price, cost, stock_qty, low_stock_threshold)
        SELECT barcode, name, category, price, cost, quantity, reorder_point FROM inventory;
      `);
      const productsAfter = (db.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number }).n;
      const migrated = productsAfter - productsBefore;
      
      if (migrated !== invCount) {
        throw new Error(`[migration 002] row-count mismatch: inventory=${invCount}, migrated=${migrated}`);
      }
      console.log(`[migration 002] migrated ${migrated} inventory row(s) into products.`);
    } else {
      console.log('[migration 002] inventory is empty (0 rows) — nothing to merge.');
    }

    db.exec('DROP TABLE inventory;');
    console.log('[migration 002] dropped inventory; products is now canonical.');
  },

  down(db: Database.Database) {
    
    
    db.exec(`
      CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT UNIQUE,
        barcode TEXT,
        name TEXT NOT NULL,
        category TEXT,
        price REAL NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 0,
        reorder_point INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    console.log('[migration 002 down] recreated empty inventory table.');
  },
};
