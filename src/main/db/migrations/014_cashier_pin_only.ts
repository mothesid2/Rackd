import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration014: Migration = {
  id: 14,
  name: 'cashier_pin_only',

  up(db: Database.Database) {
    db.prepare(
      "UPDATE users SET password_hash = NULL, must_change_password = 0 WHERE role = 'cashier'"
    ).run();
  },
};
