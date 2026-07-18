import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { Migration } from './index';

/**
 * Security / permissions layer (Part 2) — local schema.
 *
 * The existing `users` table IS the employee record; we extend it rather than
 * add a parallel table (it's already wired to sessions, transactions.cashier_id,
 * age_checks, z_reports). A stable `uid` lets employees + their permissions sync
 * across a location's registers (like customers). New tables:
 *   employee_permissions      — one row per (employee, permission) grant.
 *   permission_override_log   — APPEND-ONLY audit of manager-authorized overrides
 *                               and PIN lockouts. Never updated or deleted.
 *
 * PIN is a numeric register credential, separate from `password_hash` (portal/
 * elevated login). Both are bcrypt-hashed; the sync producer carries the hashes
 * so an employee created on one register can sign in on another after it syncs.
 *
 * "owner" is a business-level concept (owner console / manager portal), not a
 * register login, so the users.role CHECK stays manager|cashier here.
 */
export const migration010: Migration = {
  id: 10,
  name: 'permissions',

  up(db: Database.Database) {
    const cols = db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[];
    const add = (name: string, decl: string) => {
      if (!cols.some((c) => c.name === name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${decl};`);
    };
    add('uid', 'TEXT');
    add('name', 'TEXT');
    add('pin_hash', 'TEXT');
    add('is_active', 'INTEGER NOT NULL DEFAULT 1');
    add('location_id', 'TEXT');
    add('pin_fail_count', 'INTEGER NOT NULL DEFAULT 0');
    add('pin_locked_until', 'TEXT');
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid) WHERE uid IS NOT NULL;`);

    // Backfill uid + name for existing users.
    const missing = db.prepare(`SELECT id, username FROM users WHERE uid IS NULL`).all() as { id: number; username: string }[];
    const setU = db.prepare(`UPDATE users SET uid = ?, name = COALESCE(name, ?) WHERE id = ?`);
    db.transaction((rows: { id: number; username: string }[]) => {
      for (const r of rows) setU.run(randomUUID(), r.username, r.id);
    })(missing);

    db.exec(`
      CREATE TABLE IF NOT EXISTS employee_permissions (
        uid            TEXT PRIMARY KEY,        -- sync identity
        employee_uid   TEXT NOT NULL,           -- -> users.uid
        permission_key TEXT NOT NULL,
        is_granted     INTEGER NOT NULL DEFAULT 0,
        value          REAL,                    -- optional (e.g. max_discount_pct)
        updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_emp_perm_unique ON employee_permissions(employee_uid, permission_key);

      -- APPEND-ONLY. Never UPDATE or DELETE rows here.
      CREATE TABLE IF NOT EXISTS permission_override_log (
        uid                   TEXT PRIMARY KEY,
        at                    TEXT NOT NULL DEFAULT (datetime('now')),
        acting_employee_uid   TEXT,
        acting_employee_name  TEXT,
        action_attempted      TEXT NOT NULL,
        required_permission   TEXT,
        authorizing_manager_uid  TEXT,
        authorizing_manager_name TEXT,
        was_approved          INTEGER NOT NULL DEFAULT 0,
        event_type            TEXT NOT NULL DEFAULT 'override', -- 'override' | 'pin_lockout'
        transaction_id        INTEGER,
        register_id           TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_override_log_at ON permission_override_log(at);
    `);
  },

  down(db: Database.Database) {
    db.exec(`DROP TABLE IF EXISTS permission_override_log;`);
    db.exec(`DROP TABLE IF EXISTS employee_permissions;`);
    // users columns left in place (SQLite can't drop columns pre-3.35).
  },
};
