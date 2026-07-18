import type Database from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Pre-loaded distributor SKU catalog (spec v2 §3).
 *
 * One table, `sku_catalog`, holds rows from every source; `source` marks where a
 * row came from. Store-entered rows use source='local' (the "local_custom_catalog"
 * from the spec) — keeping them in one table means a single barcode lookup with a
 * priority ORDER BY, instead of querying five tables. Priority (highest first):
 *   local > dojo > verus > mclane > coremark
 * A unique index on (source, barcode) lets an invoice import upsert cleanly within
 * a source while still surfacing cross-source conflicts (same barcode, different
 * product name) to the caller.
 *
 * ASSUMPTION: distributor files are not shipped in the repo; the catalog starts
 * empty and is populated via catalog:merge from files the owner provides later.
 */
export const migration003: Migration = {
  id: 3,
  name: 'sku_catalog',

  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sku_catalog (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL,                 -- 'local' | 'dojo' | 'verus' | 'mclane' | 'coremark'
        barcode TEXT,
        product_name TEXT NOT NULL,
        brand TEXT,
        category TEXT,
        variant_label TEXT,
        suggested_retail_price REAL,
        unit_cost REAL,
        raw TEXT,                             -- original row JSON, for audit
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- One row per barcode per source (import upserts on this).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sku_catalog_source_barcode
        ON sku_catalog (source, barcode) WHERE barcode IS NOT NULL AND barcode <> '';
      CREATE INDEX IF NOT EXISTS idx_sku_catalog_barcode ON sku_catalog (barcode);
      CREATE INDEX IF NOT EXISTS idx_sku_catalog_name ON sku_catalog (product_name);
    `);
  },

  down(db: Database.Database) {
    db.exec('DROP TABLE IF EXISTS sku_catalog;');
  },
};
