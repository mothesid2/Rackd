import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration020: Migration = {
  id: 20,
  name: 'sync_cursor_keyset',

  up(db: Database.Database) {
    const cols = db.prepare(`PRAGMA table_info(sync_cursors)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'last_cloud_id')) {
      db.exec(`ALTER TABLE sync_cursors ADD COLUMN last_cloud_id INTEGER;`);
    }
  },

  down(db: Database.Database) {
    
    
    void db;
  },
};
