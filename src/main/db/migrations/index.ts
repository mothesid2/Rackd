import type Database from 'better-sqlite3';
import { migration001 } from './001_local_tables';
import { migration002 } from './002_drop_unused_inventory';
import { migration003 } from './003_sku_catalog';
import { migration004 } from './004_location_sync';
import { migration005 } from './005_stock_movements';
import { migration006 } from './006_refunds';
import { migration007 } from './007_tip_settings';
import { migration008 } from './008_rebates';
import { migration009 } from './009_rebate_settings';
import { migration010 } from './010_permissions';
import { migration011 } from './011_time_clock';
import { migration012 } from './012_online_order_source';
import { migration013 } from './013_admin_role';
import { migration014 } from './014_cashier_pin_only';
import { migration015 } from './015_tip_pool_ledger';
import { migration016 } from './016_tip_pool_ledger_fee_structure';

/**
 * A single schema change. Migrations are applied in `id` order exactly once and
 * recorded in `schema_migrations`. Never edit or renumber a migration that has
 * shipped — add a new one instead. `down` is the reverse operation (used by
 * rollbackMigration; the forward runner never calls it).
 */
export interface Migration {
  id: number;
  name: string;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

// Ordered registry. Append new migrations here.
const MIGRATIONS: Migration[] = [migration001, migration002, migration003, migration004, migration005, migration006, migration007, migration008, migration009, migration010, migration011, migration012, migration013, migration014, migration015, migration016];

/**
 * Run any migrations that haven't been applied yet. Idempotent: safe to call
 * on every launch. Each migration runs inside a transaction so a failure
 * leaves the database untouched rather than half-migrated.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    (db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id)
  );

  const pending = MIGRATIONS.filter((m) => !applied.has(m.id)).sort((a, b) => a.id - b.id);
  if (pending.length === 0) return;

  // Some migrations rebuild a table (DROP + recreate) to change a CHECK or drop a
  // NOT NULL. With foreign_keys ON (getDb enables it) that DROP fails on any table
  // referenced by a FK. Toggle enforcement OFF around the whole run — this MUST be
  // done outside the per-migration transaction, because the foreign_keys pragma is
  // a no-op while a transaction is open. Restore it (+ a sanity check) afterward.
  const fkWasOn = db.pragma('foreign_keys', { simple: true }) === 1;
  if (fkWasOn) db.pragma('foreign_keys = OFF');
  try {
    for (const m of pending) {
      const apply = db.transaction(() => {
        m.up(db);
        db.prepare('INSERT INTO schema_migrations (id, name) VALUES (?, ?)').run(m.id, m.name);
      });
      apply();
      console.log(`[migrations] applied ${String(m.id).padStart(3, '0')}_${m.name}`);
    }
    const violations = db.pragma('foreign_key_check') as unknown[];
    if (Array.isArray(violations) && violations.length) {
      console.warn(`[migrations] foreign_key_check reported ${violations.length} issue(s) after rebuild.`);
    }
  } finally {
    if (fkWasOn) db.pragma('foreign_keys = ON');
  }
}

/**
 * Roll back a single applied migration by id (reverse op). Transactional; throws
 * if the migration doesn't define `down`. Not run automatically — for ops/repair.
 */
export function rollbackMigration(db: Database.Database, id: number): void {
  const m = MIGRATIONS.find((x) => x.id === id);
  if (!m) throw new Error(`No migration with id ${id}`);
  if (!m.down) throw new Error(`Migration ${id}_${m.name} is not reversible (no down())`);
  const revert = db.transaction(() => {
    m.down!(db);
    db.prepare('DELETE FROM schema_migrations WHERE id = ?').run(id);
  });
  revert();
  console.log(`[migrations] rolled back ${String(id).padStart(3, '0')}_${m.name}`);
}
