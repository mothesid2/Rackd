import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration007: Migration = {
  id: 7,
  name: 'tip_settings',

  up(db: Database.Database) {
    const cols = db.prepare(`PRAGMA table_info(receipt_config)`).all() as { name: string }[];
    if (!cols.length) return; 
    if (!cols.some((c) => c.name === 'tip_enabled')) {
      db.exec(`ALTER TABLE receipt_config ADD COLUMN tip_enabled INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!cols.some((c) => c.name === 'tip_presets')) {
      db.exec(`ALTER TABLE receipt_config ADD COLUMN tip_presets TEXT;`);
    }
    try {
      db.prepare(`UPDATE receipt_config SET tip_presets = ? WHERE id = 1 AND (tip_presets IS NULL OR tip_presets = '')`)
        .run('15,18,20');
    } catch {  }
  },

  down(db: Database.Database) {
    
  },
};
