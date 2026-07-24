import type Database from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Regression repair (batch 5): cashiers created via POS Settings' "Create
 * User" got a password_hash AND a permanent must_change_password=1 that
 * nothing ever cleared (auth:completeFirstLogin only clears it for non-cashier
 * roles), so the login screen forced a "set a new password AND PIN" prompt on
 * every single login, forever, instead of just the first one. Cashiers are
 * PIN-only — no password concept at all. This is a one-time repair for rows
 * already stuck from before that was enforced; going forward auth:createUser
 * never sets these for a cashier, and src/main/supabase/sync.ts's
 * applyEmployee coerces them on every pull too (covers rows pulled from a
 * still-stale cloud copy).
 */
export const migration014: Migration = {
  id: 14,
  name: 'cashier_pin_only',

  up(db: Database.Database) {
    db.prepare(
      "UPDATE users SET password_hash = NULL, must_change_password = 0 WHERE role = 'cashier'"
    ).run();
  },
};
