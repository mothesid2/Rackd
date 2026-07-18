import type Database from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Employee time clock. Each punch is a row: clock_in set on punch-in, clock_out
 * set on punch-out. Keyed by `uid` so punches sync across a store's registers
 * (an employee can be clocked in/out from any register). Clocking YOURSELF needs
 * no permission; clocking someone else is gated by `clock_others`.
 */
export const migration011: Migration = {
  id: 11,
  name: 'time_clock',

  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS time_clock (
        uid           TEXT PRIMARY KEY,
        employee_uid  TEXT NOT NULL,
        employee_name TEXT,
        clock_in      TEXT NOT NULL,
        clock_out     TEXT,
        register_id   TEXT,
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_time_clock_emp ON time_clock(employee_uid);
      CREATE INDEX IF NOT EXISTS idx_time_clock_open ON time_clock(employee_uid) WHERE clock_out IS NULL;
    `);
  },

  down(db: Database.Database) {
    db.exec(`DROP TABLE IF EXISTS time_clock;`);
  },
};
