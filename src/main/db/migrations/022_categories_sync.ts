import type Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import type { Migration } from './index';


export const migration022: Migration = {
  id: 22,
  name: 'categories_sync',

  up(db: Database.Database) {
    const cols = db.prepare(`PRAGMA table_info(categories)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'uid')) {
      db.exec(`ALTER TABLE categories ADD COLUMN uid TEXT;`);
      
      
      
      
      
      
      
      const rows = db.prepare(`SELECT id FROM categories WHERE uid IS NULL`).all() as { id: number }[];
      const stamp = db.prepare(`UPDATE categories SET uid = ? WHERE id = ?`);
      for (const r of rows) stamp.run(randomUUID(), r.id);
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_uid ON categories (uid);`);
    }
    if (!cols.some((c) => c.name === 'is_active')) {
      db.exec(`ALTER TABLE categories ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1;`);
    }
  },

  down(db: Database.Database) {
    db.exec(`DROP INDEX IF EXISTS idx_categories_uid;`);
    
    void db;
  },
};
