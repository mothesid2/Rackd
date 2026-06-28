import type Database from 'better-sqlite3';
import type { Migration } from './index';

/**
 * First tracked migration for the local-first layer.
 *
 * NOTE: `transactions`, `transaction_items`, `customers`, and `settings`
 * already exist (created in schema.ts and used by the live app), so they are
 * intentionally reused, not redefined here. This migration only adds the
 * genuinely new local tables plus the `sync_queue` that the cloud layer drains.
 *
 * `inventory` is added per the local-first spec; the existing `products` table
 * remains the live product catalog. Reconcile the two before wiring features
 * onto `inventory` so we don't end up with two product sources of truth.
 */
export const migration001: Migration = {
  id: 1,
  name: 'local_tables',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS inventory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sku TEXT UNIQUE,
        barcode TEXT,
        name TEXT NOT NULL,
        category TEXT,
        price REAL NOT NULL DEFAULT 0,
        cost REAL NOT NULL DEFAULT 0,
        quantity INTEGER NOT NULL DEFAULT 0,
        reorder_point INTEGER NOT NULL DEFAULT 0,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS employees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        pin TEXT,
        role TEXT NOT NULL DEFAULT 'cashier',
        active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS cash_drawer_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER REFERENCES employees(id),
        opening_float REAL NOT NULL DEFAULT 0,
        closing_amount REAL,
        expected_amount REAL,
        over_short REAL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')),
        opened_at TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at TEXT
      );

      -- Outbox: every local write that must reach the cloud is appended here and
      -- drained by the Supabase sync worker (see supabase/sync.ts). Records are
      -- NEVER deleted — full history is kept for audit. dead_letter marks rows
      -- that exhausted their retries and need admin review.
      CREATE TABLE IF NOT EXISTS sync_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        operation TEXT NOT NULL CHECK(operation IN ('insert','update','delete')),
        payload TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_attempted_at TEXT,
        synced INTEGER NOT NULL DEFAULT 0,
        error_message TEXT,
        dead_letter INTEGER NOT NULL DEFAULT 0,
        abandoned INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX IF NOT EXISTS idx_sync_queue_pending
        ON sync_queue (synced, dead_letter, created_at);

      -- Sync conflicts: when the cloud copy has a newer updated_at than the
      -- local record, we record it here and DO NOT overwrite local. Surfaced in
      -- the manager PWA for manual resolution.
      CREATE TABLE IF NOT EXISTS conflicts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        record_id TEXT NOT NULL,
        local_updated_at TEXT,
        remote_updated_at TEXT,
        local_payload TEXT,
        resolved INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      -- Local source table for manufacturer rebate scan submissions; insert-only
      -- and pushed to the cloud scan_data_queue by the sync worker.
      CREATE TABLE IF NOT EXISTS scan_data_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        upc TEXT,
        quantity INTEGER NOT NULL DEFAULT 1,
        unit_price REAL,
        manufacturer TEXT,
        transaction_id INTEGER,
        sold_at TEXT,
        payload TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
};
