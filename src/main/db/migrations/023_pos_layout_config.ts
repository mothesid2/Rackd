import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration023: Migration = {
  id: 23,
  name: 'pos_layout_config',

  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pos_layout_config (
        role         TEXT PRIMARY KEY,   -- 'cashier' | 'manager' | 'admin'
        report_slots TEXT,               -- JSON array, e.g. '["revenue",null,"sales"]'
        tile_order   TEXT,               -- JSON array of tile keys, e.g. '["receipts","merchandise"]'
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },

  down(db: Database.Database) {
    db.exec(`DROP TABLE IF EXISTS pos_layout_config;`);
  },
};
