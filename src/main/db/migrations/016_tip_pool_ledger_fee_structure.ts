import type Database from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Follow-up to 015: the tip-pool audit ledger shipped with a single blended
 * merchant_fee_pct column, before the fee model was corrected (same session,
 * same day) to credit %, debit %, and a flat per-transaction fee — real card
 * processing has all three, not one blended rate. Adds the new columns and
 * drops the old one: it was declared NOT NULL with no default (015), so
 * simply leaving it unused is not actually harmless — every insert that
 * stopped populating it (once xzout.ts moved to the new fields) started
 * failing the NOT NULL constraint outright. DROP COLUMN needs SQLite 3.35+
 * (bundled with Electron's Node for years now); ADD COLUMN doesn't.
 */
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
