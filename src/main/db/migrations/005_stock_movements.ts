import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration005: Migration = {
  id: 5,
  name: 'stock_movements',

  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS stock_movements (
        movement_uid TEXT PRIMARY KEY,          -- uuid; dedup key across registers
        product_id   INTEGER,                   -- local product id of the ORIGIN register (advisory)
        barcode      TEXT,                       -- cross-register product identity (primary match)
        sku          TEXT,                       -- cross-register product identity (fallback match)
        delta        INTEGER NOT NULL,           -- signed change: -sold / +received / +returned
        reason       TEXT NOT NULL,              -- 'sale' | 'manual' | 'receive' | 'return'
        register_id  TEXT,                       -- till that produced it (origin)
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
      CREATE INDEX IF NOT EXISTS idx_stock_movements_barcode ON stock_movements(barcode);
      CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements(created_at);
    `);
  },

  down(db: Database.Database) {
    db.exec(`DROP TABLE IF EXISTS stock_movements;`);
  },
};
