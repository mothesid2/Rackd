import type Database from 'better-sqlite3';
import type { Migration } from './index';


export const migration013: Migration = {
  id: 13,
  name: 'admin_role',

  up(db: Database.Database) {
    const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get() as { sql: string } | undefined;
    const cols = db.prepare('PRAGMA table_info(users)').all() as { name: string }[];
    const hasPin = cols.some((c) => c.name === 'must_change_pin');
    const allowsAdmin = !!info && /'admin'/.test(info.sql);
    if (hasPin && allowsAdmin) return; 

    db.exec(`
      CREATE TABLE users_new (
        id                   INTEGER PRIMARY KEY AUTOINCREMENT,
        uid                  TEXT,
        username             TEXT,               -- nullable: cashiers have none
        name                 TEXT,
        password_hash        TEXT,               -- nullable: cashiers have none
        pin_hash             TEXT,
        role                 TEXT NOT NULL CHECK(role IN ('admin','manager','cashier')),
        is_active            INTEGER NOT NULL DEFAULT 1,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        must_change_pin      INTEGER NOT NULL DEFAULT 0,
        location_id          TEXT,
        pin_fail_count       INTEGER NOT NULL DEFAULT 0,
        pin_locked_until     TEXT,
        created_at           TEXT DEFAULT (datetime('now'))
      );
    `);

    db.exec(`
      INSERT INTO users_new
        (id, uid, username, name, password_hash, pin_hash, role, is_active,
         must_change_password, must_change_pin, location_id, pin_fail_count, pin_locked_until, created_at)
      SELECT id, uid, username, name, password_hash, pin_hash, role,
             COALESCE(is_active, 1), COALESCE(must_change_password, 0), 0,
             location_id, COALESCE(pin_fail_count, 0), pin_locked_until, created_at
      FROM users;
    `);

    db.exec('DROP TABLE users;');
    db.exec('ALTER TABLE users_new RENAME TO users;');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_uid ON users(uid) WHERE uid IS NOT NULL;');
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL;');
  },
};
