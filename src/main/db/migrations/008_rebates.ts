import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration008: Migration = {
  id: 8,
  name: 'rebates',

  up(db: Database.Database) {
    
    const cols = db.prepare(`PRAGMA table_info(products)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'manufacturer_uid')) {
      db.exec(`ALTER TABLE products ADD COLUMN manufacturer_uid TEXT;`);
    }

    db.exec(`
      -- CONFIG (pulled down, tenant-scoped) ─────────────────────────────────────
      CREATE TABLE IF NOT EXISTS manufacturers (
        uid                 TEXT PRIMARY KEY,      -- cloud identity
        name                TEXT NOT NULL,
        parent_company_code TEXT,                  -- 'PM' | 'RJRT' | 'ITG'
        batch_end_dow       INTEGER,               -- 0=Sun … 6=Sat: last day of the report week
        due_dow             INTEGER,               -- day of week the file is due
        due_offset_weeks    INTEGER NOT NULL DEFAULT 1,
        timezone            TEXT,
        is_active           INTEGER NOT NULL DEFAULT 1,
        updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS rebate_rules (
        uid                  TEXT PRIMARY KEY,      -- cloud identity
        manufacturer_uid     TEXT,
        name                 TEXT NOT NULL,         -- 'Camel Blue BOGO $1 off'
        rule_type            TEXT NOT NULL,         -- 'bogo_discount' | 'multi_pack_discount' | 'flat_discount'
        qualifying_skus      TEXT NOT NULL DEFAULT '[]',  -- JSON array of barcodes
        qualifying_quantity  INTEGER NOT NULL DEFAULT 1,
        discount_amount      REAL NOT NULL DEFAULT 0,
        discount_type        TEXT NOT NULL DEFAULT 'flat', -- 'flat' | 'percent'
        is_manufacturer_funded INTEGER NOT NULL DEFAULT 1,
        active_start_date    TEXT,
        active_end_date      TEXT,
        is_active            INTEGER NOT NULL DEFAULT 1,
        updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_rebate_rules_active ON rebate_rules (is_active);
      CREATE INDEX IF NOT EXISTS idx_rebate_rules_mfr    ON rebate_rules (manufacturer_uid);

      -- AUDIT (pushed up, location+register scoped) ─────────────────────────────
      CREATE TABLE IF NOT EXISTS applied_rebates (
        uid                    TEXT PRIMARY KEY,    -- global dedup identity
        transaction_id         INTEGER,
        rebate_rule_uid        TEXT,
        manufacturer_uid       TEXT,
        barcode                TEXT,
        discount_amount        REAL NOT NULL DEFAULT 0,
        is_manufacturer_funded INTEGER NOT NULL DEFAULT 1,
        was_auto_applied       INTEGER NOT NULL DEFAULT 0,
        register_id            TEXT,
        applied_at             TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_applied_rebates_txn ON applied_rebates (transaction_id);
      CREATE INDEX IF NOT EXISTS idx_applied_rebates_mfr ON applied_rebates (manufacturer_uid);

      CREATE TABLE IF NOT EXISTS missed_rebates (
        uid               TEXT PRIMARY KEY,
        transaction_id    INTEGER,
        rebate_rule_uid   TEXT,
        manufacturer_uid  TEXT,
        barcode           TEXT,
        potential_discount REAL NOT NULL DEFAULT 0,
        register_id       TEXT,
        detected_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_missed_rebates_txn ON missed_rebates (transaction_id);
    `);

    
    
    
    
    
    
    const seed = db.prepare(`
      INSERT OR IGNORE INTO manufacturers (uid, name, parent_company_code, batch_end_dow, due_dow, due_offset_weeks, timezone)
      VALUES (?, ?, ?, ?, ?, 1, 'America/Chicago')
    `);
    seed.run('a1000000-0000-4000-8000-000000000001', 'Altria', 'PM', 6, 2);
    seed.run('a1000000-0000-4000-8000-000000000002', 'RJ Reynolds', 'RJRT', 0, 3);
    seed.run('a1000000-0000-4000-8000-000000000003', 'ITG Brands', 'ITG', null, null);
  },

  down(db: Database.Database) {
    db.exec(`
      DROP TABLE IF EXISTS missed_rebates;
      DROP TABLE IF EXISTS applied_rebates;
      DROP TABLE IF EXISTS rebate_rules;
      DROP TABLE IF EXISTS manufacturers;
    `);
    
  },
};
