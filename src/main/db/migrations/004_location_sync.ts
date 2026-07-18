import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Multi-location sync foundation (spec v3, local side of cloud migrations 015/016).
 *
 * Two additions, both prerequisites for the bidirectional (pull) sync path:
 *
 *  1. customers.uid — a stable, cross-register identity. Local integer ids are
 *     per-register autoincrement (Register A's #5 ≠ Register B's #5), so shared
 *     customer rows need a globally-unique key the pull applier can match on.
 *     Existing rows are backfilled with a uuid.
 *
 *  2. sync_cursors — the high-water mark per pulled table. The pull worker records
 *     the newest `updated_at` it has consumed so the next cycle only fetches newer
 *     rows. Empty/local-only installs simply never populate it.
 *
 * No behavior change on its own: nothing reads uid or sync_cursors until the
 * Phase 1 pull worker ships.
 */
export const migration004: Migration = {
  id: 4,
  name: 'location_sync',

  up(db: Database.Database) {
    // 1. customers.uid (nullable; unique when present). SQLite can't add a column
    //    with a non-constant default, so add it null then backfill.
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

    // 2. sync_cursors: per-table pull high-water mark (ISO updated_at).
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
    // SQLite can't drop a column pre-3.35; leaving customers.uid in place is
    // harmless (nullable, unread once the pull worker is removed).
  },
};
