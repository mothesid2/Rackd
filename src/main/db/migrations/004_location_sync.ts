import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration004: Migration = {
  id: 4,
  name: 'location_sync',

  up(db: Database.Database) {
    
    
    const cols = db.prepare(`PRAGMA table_info(customers)`).all() as { name: string }[];
    if (!cols.some((c) => c.name === 'uid')) {
      db.exec(`ALTER TABLE customers ADD COLUMN uid TEXT;`);
    }
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_customers_uid ON customers(uid) WHERE uid IS NOT NULL;`
    );

    const missing = db.prepare(`SELECT id FROM customers WHERE uid IS NULL`).all() as { id: number }[];
    const setUid = db.prepare(`UPDATE customers SET uid = ? WHERE id = ?`);
    const backfill = db.transaction((rows: { id: number }[]) => {
      for (const r of rows) setUid.run(randomUUID(), r.id);
    });
    backfill(missing);
    if (missing.length) console.log(`[migration 004] backfilled uid on ${missing.length} customer(s).`);

    
    db.exec(`
      CREATE TABLE IF NOT EXISTS sync_cursors (
        table_name     TEXT PRIMARY KEY,
        last_pulled_at TEXT,
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },

  down(db: Database.Database) {
    db.exec(`DROP TABLE IF EXISTS sync_cursors;`);
    db.exec(`DROP INDEX IF EXISTS idx_customers_uid;`);
    
    
  },
};
