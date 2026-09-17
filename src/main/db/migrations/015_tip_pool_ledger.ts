import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration015: Migration = {
  id: 15,
  name: 'tip_pool_ledger',

  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS tip_pool_ledger (
        id                  INTEGER PRIMARY KEY AUTOINCREMENT,
        report_date         TEXT NOT NULL,
        z_report_id         INTEGER REFERENCES z_reports(id),
        total_tips          REAL NOT NULL,
        card_tip_total      REAL NOT NULL,
        merchant_fee_pct    REAL NOT NULL,
        deduction_amount    REAL NOT NULL,
        pool_amount         REAL NOT NULL,
        pooled              INTEGER NOT NULL,
        skip_reason         TEXT,
        total_hours         REAL NOT NULL,
        generated_at        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tip_pool_shares (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        ledger_id      INTEGER NOT NULL REFERENCES tip_pool_ledger(id),
        employee_uid   TEXT NOT NULL,
        employee_name  TEXT,
        role           TEXT,
        hours          REAL,
        share_amount   REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_tip_pool_shares_ledger ON tip_pool_shares(ledger_id);
    `);
  },

  down(db: Database.Database) {
    db.exec(`DROP TABLE IF EXISTS tip_pool_shares; DROP TABLE IF EXISTS tip_pool_ledger;`);
  },
};
