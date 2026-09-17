import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration016: Migration = {
  id: 16,
  name: 'tip_pool_ledger_fee_structure',

  up(db: Database.Database) {
    const cols = db.prepare('PRAGMA table_info(tip_pool_ledger)').all() as { name: string }[];
    const has = (c: string) => cols.some((x) => x.name === c);
    if (!has('merchant_fee_credit_pct')) db.exec('ALTER TABLE tip_pool_ledger ADD COLUMN merchant_fee_credit_pct REAL NOT NULL DEFAULT 0');
    if (!has('merchant_fee_debit_pct')) db.exec('ALTER TABLE tip_pool_ledger ADD COLUMN merchant_fee_debit_pct REAL NOT NULL DEFAULT 0');
    if (!has('merchant_fee_flat_cents')) db.exec('ALTER TABLE tip_pool_ledger ADD COLUMN merchant_fee_flat_cents INTEGER NOT NULL DEFAULT 0');
    if (!has('card_tip_txn_count')) db.exec('ALTER TABLE tip_pool_ledger ADD COLUMN card_tip_txn_count INTEGER NOT NULL DEFAULT 0');
    if (has('merchant_fee_pct')) db.exec('ALTER TABLE tip_pool_ledger DROP COLUMN merchant_fee_pct');
  },
};
