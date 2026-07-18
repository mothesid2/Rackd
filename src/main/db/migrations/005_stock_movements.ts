import type Database from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Inventory event-deltas (spec v3, Phase 2) — the shared-stock substrate.
 *
 * Registers in one location share LIVE stock while staying offline-first. Instead
 * of syncing an absolute count (which two tills would clobber), each stock change
 * is recorded as an immutable MOVEMENT (delta: -2 sold, +10 received). Every
 * register replays peers' movements to compute the same count, and it converges
 * no matter how long a till was offline.
 *
 * `movement_uid` is a client-generated uuid = the globally-unique identity the
 * pull applier dedups on (INSERT OR IGNORE). Product identity travels as
 * barcode/sku (not local product_id, which differs per register). The local
 * `products.stock_qty` remains the fast read path; movements keep it in sync.
 */
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
