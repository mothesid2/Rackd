import type Database from 'better-sqlite3';
import type { Migration } from './index';


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
