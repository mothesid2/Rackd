import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration012: Migration = {
  id: 12,
  name: 'online_order_source',
  up(db: Database.Database) {
    const cols = db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'order_source')) {
      db.exec(`ALTER TABLE transactions ADD COLUMN order_source TEXT NOT NULL DEFAULT 'in_store';`);
    }
    if (!cols.some((c) => c.name === 'online_order_id')) {
      db.exec(`ALTER TABLE transactions ADD COLUMN online_order_id TEXT;`);
    }
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_txn_online_order ON transactions(online_order_id) WHERE online_order_id IS NOT NULL;`);
  },
  down(db: Database.Database) {
    db.exec(`DROP INDEX IF EXISTS idx_txn_online_order;`);
    
  },
};
