import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration009: Migration = {
  id: 9,
  name: 'rebate_settings',

  up(db: Database.Database) {
    const cols = db.prepare(`PRAGMA table_info(receipt_config)`).all() as { name: string }[];
    if (cols.length && !cols.some((c) => c.name === 'rebate_auto_apply')) {
      db.exec(`ALTER TABLE receipt_config ADD COLUMN rebate_auto_apply INTEGER NOT NULL DEFAULT 0;`);
    }
  },

  down() {  },
};
