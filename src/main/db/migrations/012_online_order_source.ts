import type Database from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Tag transactions by source so online prepaid orders are reportable as a distinct
 * "Online — Prepaid" type (spec item 9) while staying OUT of the cash-drawer
 * reconciliation.
 *
 *  • order_source: 'in_store' (default) | 'online'. Online pickup sales are recorded
 *    locally with order_source='online' and payment_method NULL — so they count in
 *    sales/revenue + inventory deduction, but never in the cash/card drawer totals
 *    (which sum by payment_method IN ('cash','card','split')).
 *  • online_order_id: the cloud online_orders.id, used to make the local recording
 *    idempotent (don't double-record a pickup).
 *
 * These local online transactions are NOT synced to transactions_cloud (the order
 * already lives in the cloud as an online_order); only the stock movement syncs so
 * a location's registers converge on the deducted count.
 */
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
    // SQLite can't drop columns pre-3.35; order_source/online_order_id left in place.
  },
};
