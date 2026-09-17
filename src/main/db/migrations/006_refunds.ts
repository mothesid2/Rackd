import type Database from 'better-sqlite3';
import type { Migration } from './index';


const DEFAULT_POLICY =
  'Returns: Tobacco & vapor products are non-refundable. Gift-shop items may be ' +
  'returned within 7 days with receipt. Discounted/promotional items are final sale. ' +
  'Manager approval and original receipt required for all returns.';

export const migration006: Migration = {
  id: 6,
  name: 'refunds',

  up(db: Database.Database) {
    const txnCols = db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[];
    if (!txnCols.some((c) => c.name === 'original_txn_id')) {
      db.exec(`ALTER TABLE transactions ADD COLUMN original_txn_id INTEGER;`);
    }
    db.exec(`CREATE INDEX IF NOT EXISTS idx_transactions_original ON transactions(original_txn_id);`);

    
    
    const rcCols = db.prepare(`PRAGMA table_info(receipt_config)`).all() as { name: string }[];
    if (rcCols.length && !rcCols.some((c) => c.name === 'refund_policy')) {
      db.exec(`ALTER TABLE receipt_config ADD COLUMN refund_policy TEXT;`);
    }
    
    try {
      db.prepare(`UPDATE receipt_config SET refund_policy = ? WHERE id = 1 AND (refund_policy IS NULL OR refund_policy = '')`)
        .run(DEFAULT_POLICY);
    } catch {  }
  },

  down(db: Database.Database) {
    db.exec(`DROP INDEX IF EXISTS idx_transactions_original;`);
    
  },
};
