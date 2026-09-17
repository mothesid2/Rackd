import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration019: Migration = {
  id: 19,
  name: 'pricing_groups',

  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pricing_groups (
        uid         TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        price       REAL,                          -- NULL = don't cascade a price, group is tax/promo-only
        is_taxable  INTEGER NOT NULL DEFAULT 1,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS pricing_group_promos (
        uid                 TEXT PRIMARY KEY,
        pricing_group_uid   TEXT NOT NULL REFERENCES pricing_groups(uid) ON DELETE CASCADE,
        name                TEXT NOT NULL,          -- 'Buy 2, 50% off the 2nd'
        buy_qty             INTEGER NOT NULL DEFAULT 2,   -- units from the group that trigger one "set"
        discount_qty        INTEGER NOT NULL DEFAULT 1,   -- of those, how many get discounted per set
        discount_type       TEXT NOT NULL DEFAULT 'percent', -- 'flat' | 'percent'
        discount_amount     REAL NOT NULL DEFAULT 0,
        is_active           INTEGER NOT NULL DEFAULT 1,
        active_start_date   TEXT,
        active_end_date     TEXT,
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_pricing_group_promos_group  ON pricing_group_promos (pricing_group_uid);
      CREATE INDEX IF NOT EXISTS idx_pricing_group_promos_active ON pricing_group_promos (is_active);
    `);

    const productCols = db.prepare(`PRAGMA table_info(products)`).all() as { name: string }[];
    if (!productCols.some((c) => c.name === 'pricing_group_uid')) {
      db.exec(`ALTER TABLE products ADD COLUMN pricing_group_uid TEXT REFERENCES pricing_groups(uid);`);
      db.exec(`CREATE INDEX IF NOT EXISTS idx_products_pricing_group ON products (pricing_group_uid);`);
    }
  },

  down(db: Database.Database) {
    db.exec(`
      DROP TABLE IF EXISTS pricing_group_promos;
      DROP TABLE IF EXISTS pricing_groups;
      DROP INDEX IF EXISTS idx_products_pricing_group;
    `);
  },
};
