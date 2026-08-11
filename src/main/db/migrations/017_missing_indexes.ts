import type Database from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Missing-index audit (batch 8) — the base schema (schema.ts) never indexed
 * its busiest lookup columns, only later migrations added a handful for
 * newer tables (stock_movements, rebates, time_clock). A single register's
 * local database accumulates years of daily transactions, so these matter
 * at real scale even though it's single-tenant/single-file:
 *
 *   - transaction_items.transaction_id: read on EVERY receipt view, refund,
 *     reprint, and delete (transactions.ts lines 389/420/465/535) — the
 *     single hottest query pattern in the whole app, previously a full
 *     table scan.
 *   - transaction_items.product_id: per-product sale history
 *     (getProductSaleHistory) and the "bought both" cross-purchase query in
 *     customers.ts.
 *   - transactions.customer_id: customer purchase history / loyalty lookups
 *     (customers.ts).
 *   - transactions.cashier_id: not currently queried directly but is a real
 *     FK with the same growth profile as customer_id; cheap to add now.
 *   - transactions.created_at: the plain (non substr-wrapped) sort in the
 *     receipts list (`ORDER BY t.created_at DESC LIMIT ? OFFSET ?`).
 *   - an EXPRESSION index on substr(created_at,1,10): X/Z reports
 *     (xzout.ts) and the daily-total query in transactions.ts filter with
 *     `WHERE substr(created_at,1,10) >= ?` / `= ?` specifically — a plain
 *     index on created_at can't be used for a wrapped expression, SQLite
 *     needs an index on the expression itself.
 *   - invoice_items.invoice_id, loyalty_ledger.customer_id,
 *     product_variants.product_id, promo_codes.customer_id: same "FK never
 *     indexed" gap, lower traffic but still a real scan today.
 *
 * NOT added: customers(phone)/(first_name || ' ' || last_name) — the actual
 * queries (customers.ts) search with a leading-wildcard LIKE
 * ('%query%'), which a standard B-tree index cannot accelerate regardless;
 * that would need FTS5, a bigger change than "add a missing index."
 */
export const migration017: Migration = {
  id: 17,
  name: 'missing_indexes',

  up(db: Database.Database) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_transaction_items_txn      ON transaction_items(transaction_id);
      CREATE INDEX IF NOT EXISTS idx_transaction_items_product  ON transaction_items(product_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_customer      ON transactions(customer_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_cashier       ON transactions(cashier_id);
      CREATE INDEX IF NOT EXISTS idx_transactions_created       ON transactions(created_at);
      CREATE INDEX IF NOT EXISTS idx_transactions_created_date  ON transactions(substr(created_at, 1, 10));
      CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice      ON invoice_items(invoice_id);
      CREATE INDEX IF NOT EXISTS idx_loyalty_ledger_customer    ON loyalty_ledger(customer_id);
      CREATE INDEX IF NOT EXISTS idx_product_variants_product   ON product_variants(product_id);
      CREATE INDEX IF NOT EXISTS idx_promo_codes_customer       ON promo_codes(customer_id);
    `);
  },

  down(db: Database.Database) {
    db.exec(`
      DROP INDEX IF EXISTS idx_transaction_items_txn;
      DROP INDEX IF EXISTS idx_transaction_items_product;
      DROP INDEX IF EXISTS idx_transactions_customer;
      DROP INDEX IF EXISTS idx_transactions_cashier;
      DROP INDEX IF EXISTS idx_transactions_created;
      DROP INDEX IF EXISTS idx_transactions_created_date;
      DROP INDEX IF EXISTS idx_invoice_items_invoice;
      DROP INDEX IF EXISTS idx_loyalty_ledger_customer;
      DROP INDEX IF EXISTS idx_product_variants_product;
      DROP INDEX IF EXISTS idx_promo_codes_customer;
    `);
  },
};
