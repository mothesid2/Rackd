import { randomUUID } from 'crypto';
import { net, BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getDb } from '../db/schema';
import { getSupabase, isSupabaseConfigured } from './client';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from './publicConfig';
import { loadCachedLicense } from './licenseCheck';
import { getMachineId } from './tokenManager';
import type { SyncOp, SyncQueueRow } from '../db/types';

/**
 * Background sync worker — drains the local `sync_queue` outbox to Supabase.
 *
 * Local-first contract: if Supabase is unreachable or unconfigured the POS keeps
 * running on SQLite; the queue simply accumulates. The worker never throws into
 * the app — every cycle is wrapped so an error just logs and retries next tick.
 */

const SYNC_INTERVAL_MS = 60_000; // every 60s
const BATCH_SIZE = 50; // max records per cycle
const MAX_ATTEMPTS = 3; // dead-letter after this many failures (spec §5)
const PING_TIMEOUT_MS = 4_000;

/**
 * Per-table sync policy: which operations are allowed, the cloud target, and
 * whether the row is location-scoped. `scoped` tables carry location_id +
 * register_id columns (added in migration 016) and get them stamped at push time;
 * unscoped tables (scan_data_queue) must NOT — PostgREST rejects unknown columns.
 */
interface Policy {
  ops: SyncOp[];
  cloudTable: string;
  scoped?: boolean;
  /** Upsert conflict target (the cloud table's unique key). Defaults to 'tenant_id,id'. */
  conflictTarget?: string;
}
const DEFAULT_CONFLICT_TARGET = 'tenant_id,id';
const SYNC_POLICY: Record<string, Policy> = {
  transactions: { ops: ['insert'], cloudTable: 'transactions_cloud', scoped: true },
  transaction_items: { ops: ['insert'], cloudTable: 'transaction_items_cloud', scoped: true },
  // Shared across a location by stable uid (not local id, which differs per register).
  customers: { ops: ['insert', 'update'], cloudTable: 'customers_cloud', scoped: true, conflictTarget: 'tenant_id,uid' },
  inventory: { ops: ['update'], cloudTable: 'inventory_cloud', scoped: true }, // cloud is reporting-only
  // Shared-stock deltas: append-only log keyed by its own uuid, not (tenant_id,id).
  stock_movements: { ops: ['insert'], cloudTable: 'stock_movements_cloud', scoped: true, conflictTarget: 'movement_uid' },
  cash_drawer_sessions: { ops: ['insert'], cloudTable: 'cash_drawer_sessions_cloud', scoped: true },
  scan_data_queue: { ops: ['insert'], cloudTable: 'scan_data_queue' }, // not location-scoped
  // Rebate audit — location+register scoped, insert-only, keyed by uid.
  applied_rebates: { ops: ['insert'], cloudTable: 'applied_rebates_cloud', scoped: true, conflictTarget: 'uid' },
  missed_rebates: { ops: ['insert'], cloudTable: 'missed_rebates_cloud', scoped: true, conflictTarget: 'uid' },
  // Rebate rules — tenant config authored on the POS; pushed up (no location cols).
  rebate_rules: { ops: ['insert', 'update'], cloudTable: 'rebate_rules_cloud', conflictTarget: 'tenant_id,uid' },
  // Staff + permissions — location config synced across a store's registers.
  employees: { ops: ['insert', 'update'], cloudTable: 'employees_cloud', scoped: true, conflictTarget: 'tenant_id,uid' },
  employee_permissions: { ops: ['insert', 'update'], cloudTable: 'employee_permissions_cloud', scoped: true, conflictTarget: 'tenant_id,uid' },
  // Append-only override audit — insert-only, keyed by uid.
  permission_override_log: { ops: ['insert'], cloudTable: 'permission_override_log_cloud', scoped: true, conflictTarget: 'uid' },
  // Time-clock punches — location config synced across a store's registers.
  time_clock: { ops: ['insert', 'update'], cloudTable: 'time_clock_cloud', scoped: true, conflictTarget: 'uid' },
};
// Never leaves the device, regardless of how enqueue is called.
// 'employees' is now a valid policy key (staff records sync via the users table
// through the enqueueEmployee producer). 'users'/'settings' stay local-only.
const NEVER_SYNC = new Set(['settings', 'sync_queue', 'conflicts', 'users']);
// Stripped from any payload before it can reach the cloud. Note: password_hash is
// NOT stripped — bcrypt hashes for admin/manager sync (tenant-scoped) so one
// username+password works at every kiosk's start-of-day and the Manager Portal.
// Only PLAINTEXT secrets are stripped.
const SENSITIVE_FIELDS = ['pin', 'password', 'token', 'auth_token'];

// ── settings-table helpers (sync status log) ────────────────────────────────
function writeSetting(key: string, value: string, db: Database.Database = getDb()): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
function readSetting(key: string, db: Database.Database = getDb()): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

// ── pull cursors (per-table high-water mark for the peer-pull path) ──────────
function getCursor(table: string, db: Database.Database = getDb()): string | null {
  const row = db.prepare('SELECT last_pulled_at FROM sync_cursors WHERE table_name = ?').get(table) as
    | { last_pulled_at: string | null }
    | undefined;
  return row?.last_pulled_at ?? null;
}
function setCursor(table: string, value: string, db: Database.Database = getDb()): void {
  db.prepare(
    `INSERT INTO sync_cursors (table_name, last_pulled_at, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(table_name) DO UPDATE SET last_pulled_at = excluded.last_pulled_at, updated_at = datetime('now')`
  ).run(table, value);
}

// ── policy / enqueue ────────────────────────────────────────────────────────
export interface SyncVerdict {
  allowed: boolean;
  reason?: string;
  cloudTable?: string;
  scoped?: boolean;
  conflictTarget?: string;
}
export function isSyncAllowed(table: string, op: SyncOp): SyncVerdict {
  if (NEVER_SYNC.has(table)) return { allowed: false, reason: 'table is never synced' };
  const policy = SYNC_POLICY[table];
  if (!policy) return { allowed: false, reason: 'no sync policy for table' };
  if (!policy.ops.includes(op)) return { allowed: false, reason: `operation '${op}' not allowed for ${table}` };
  return {
    allowed: true,
    cloudTable: policy.cloudTable,
    scoped: policy.scoped === true,
    conflictTarget: policy.conflictTarget ?? DEFAULT_CONFLICT_TARGET,
  };
}

function stripSensitive(payload: Record<string, unknown>): Record<string, unknown> {
  const clean = { ...payload };
  for (const f of SENSITIVE_FIELDS) delete clean[f];
  return clean;
}

/**
 * Append a record to the outbox. Returns false (and logs) if policy disallows it
 * so callers can't accidentally sync something that must stay local.
 */
export function enqueueSync(
  table: string,
  recordId: string | number,
  operation: SyncOp,
  payload: Record<string, unknown>,
  db: Database.Database = getDb()
): boolean {
  const verdict = isSyncAllowed(table, operation);
  if (!verdict.allowed) {
    console.warn(`[sync] not queued: ${table}.${operation} — ${verdict.reason}`);
    return false;
  }
  db.prepare(
    'INSERT INTO sync_queue (table_name, record_id, operation, payload) VALUES (?, ?, ?, ?)'
  ).run(table, String(recordId), operation, JSON.stringify(stripSensitive(payload)));
  return true;
}

// ── per-record state transitions (pure-ish, db-injectable for tests) ────────
export function failureUpdate(currentAttempts: number): { attempts: number; dead_letter: boolean } {
  const attempts = currentAttempts + 1;
  return { attempts, dead_letter: attempts >= MAX_ATTEMPTS };
}

function markSynced(rowId: number, db: Database.Database = getDb()): void {
  db.prepare(
    `UPDATE sync_queue SET synced = 1, error_message = NULL, last_attempted_at = datetime('now') WHERE id = ?`
  ).run(rowId);
}

export function recordFailure(
  rowId: number,
  currentAttempts: number,
  errorMessage: string,
  db: Database.Database = getDb()
): { attempts: number; dead_letter: boolean } {
  const { attempts, dead_letter } = failureUpdate(currentAttempts);
  db.prepare(
    `UPDATE sync_queue
     SET attempts = ?, error_message = ?, last_attempted_at = datetime('now'), dead_letter = ?
     WHERE id = ?`
  ).run(attempts, errorMessage, dead_letter ? 1 : 0, rowId);
  if (dead_letter) {
    // Surface dead-letters in settings for admin review.
    writeSetting('last_dead_letter', `${new Date().toISOString()} #${rowId}: ${errorMessage}`, db);
  }
  return { attempts, dead_letter };
}

function recordConflict(
  row: SyncQueueRow,
  localUpdatedAt: string | null,
  remoteUpdatedAt: string | null,
  db: Database.Database = getDb()
): void {
  db.prepare(
    `INSERT INTO conflicts (table_name, record_id, local_updated_at, remote_updated_at, local_payload)
     VALUES (?, ?, ?, ?, ?)`
  ).run(row.table_name, row.record_id, localUpdatedAt, remoteUpdatedAt, row.payload);
  console.warn(`[sync] conflict on ${row.table_name}#${row.record_id} — kept local, flagged for review.`);
}

// ── sync status (for IPC / manager PWA) ─────────────────────────────────────
// Derived indicator state (spec §5): the single label a UI badge shows.
export type SyncIndicator = 'synced' | 'pending' | 'offline' | 'conflict' | 'error';

export interface SyncStatus {
  online: boolean;
  state: SyncIndicator;
  last_sync_attempted_at: string | null;
  last_sync_succeeded_at: string | null;
  last_sync_error: string | null;
  pending_sync_count: number;
  dead_letter_count: number;
  conflict_count: number;
}

export function getSyncStatus(db: Database.Database = getDb()): SyncStatus {
  const pending = (
    db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE synced = 0 AND dead_letter = 0').get() as { n: number }
  ).n;
  // Actionable dead-letters only (abandoned ones are excluded from the count).
  const dead = (
    db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE dead_letter = 1 AND abandoned = 0').get() as { n: number }
  ).n;
  const conflicts = (
    db.prepare('SELECT COUNT(*) AS n FROM conflicts WHERE resolved = 0').get() as { n: number }
  ).n;

  // Most-urgent-first: dead-letters need attention, then unresolved conflicts,
  // then offline (queue accumulating), then in-flight, else fully synced.
  const state: SyncIndicator =
    dead > 0 ? 'error'
    : conflicts > 0 ? 'conflict'
    : !online ? 'offline'
    : pending > 0 ? 'pending'
    : 'synced';

  return {
    online,
    state,
    last_sync_attempted_at: readSetting('last_sync_attempted_at', db),
    last_sync_succeeded_at: readSetting('last_sync_succeeded_at', db),
    last_sync_error: readSetting('last_sync_error', db),
    pending_sync_count: pending,
    dead_letter_count: dead,
    conflict_count: conflicts,
  };
}

// ── dead-letter management (exposed via IPC for admin review) ────────────────
/** All actionable dead-letter records (excludes abandoned), newest first. */
export function getDeadLetters(db: Database.Database = getDb()): SyncQueueRow[] {
  return db
    .prepare('SELECT * FROM sync_queue WHERE dead_letter = 1 AND abandoned = 0 ORDER BY created_at DESC, id DESC')
    .all() as SyncQueueRow[];
}

/** Reset a dead-letter row so the worker retries it; returns rows affected. */
export function retryDeadLetter(id: number, db: Database.Database = getDb()): number {
  const r = db
    .prepare(
      `UPDATE sync_queue
       SET dead_letter = 0, attempts = 0, synced = 0, error_message = NULL
       WHERE id = ? AND dead_letter = 1 AND abandoned = 0`
    )
    .run(id);
  return r.changes;
}

/** Mark a dead-letter row permanently abandoned (never retried, never deleted). */
export function clearDeadLetter(id: number, db: Database.Database = getDb()): number {
  const r = db
    .prepare(`UPDATE sync_queue SET abandoned = 1 WHERE id = ? AND dead_letter = 1`)
    .run(id);
  return r.changes;
}

function persistCounts(db: Database.Database): void {
  const s = getSyncStatus(db);
  writeSetting('pending_sync_count', String(s.pending_sync_count), db);
  writeSetting('dead_letter_count', String(s.dead_letter_count), db);
}

// ── network detection ───────────────────────────────────────────────────────
let online = false;

export function getOnline(): boolean {
  return online;
}

/** True only if the OS reports online AND Supabase actually answers a health ping. */
async function pingSupabase(): Promise<boolean> {
  let osOnline = true;
  try {
    osOnline = net.isOnline();
  } catch {
    osOnline = true; // net unavailable outside app -> fall back to the real ping
  }
  if (!osOnline) return false;

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) return false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/auth/v1/health`, {
      headers: { apikey: key },
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false; // ping failed -> treat as offline even if net.isOnline() was true
  } finally {
    clearTimeout(timer);
  }
}

function broadcast(channel: string, payload: unknown): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try {
        w.webContents.send(channel, payload);
      } catch {
        /* window torn down mid-send */
      }
    }
  }
}

/** Update connectivity, emit on change, and sync immediately when coming back online. */
function setOnline(next: boolean): void {
  if (next === online) return;
  online = next;
  broadcast('sync:status', getSyncStatus());
  if (next) void safeCycle(); // connection restored -> drain now
}

/**
 * Tenant id for cloud writes, read from the cached license. Throws a clear error
 * rather than pushing a malformed (tenant-less) record. (Follow-up #1)
 */
export function getTenantId(db: Database.Database = getDb()): string {
  const license = loadCachedLicense(db);
  const tenantId = license?.tenant_id;
  if (!tenantId) {
    throw new Error(
      'Cannot sync: tenant_id missing from cached license. Run a successful license check before syncing.'
    );
  }
  return tenantId;
}

/**
 * Location this register belongs to, from the cached license. May be null on a
 * pre-v3 license (single-store install not yet re-provisioned) — writes still
 * work (tenant-scoped RLS) and the peer-pull path is simply skipped.
 */
export function getLocationId(db: Database.Database = getDb()): string | null {
  return loadCachedLicense(db)?.location_id ?? null;
}

/** This till's stable identity — the same machine_id used for seat counting. */
export function getRegisterId(db: Database.Database = getDb()): string {
  return getMachineId(db);
}

/**
 * Producer helper (D.1): re-read a freshly written local row and enqueue it for
 * the cloud with tenant_id injected. No-op when Supabase isn't configured (pure
 * local install). MUST be called inside the same db.transaction() as the local
 * write so the write and the queue entry are atomic — either both or neither.
 *
 * `table` is the policy key (= local table name for the directly-mirrored
 * tables: transactions, transaction_items, customers).
 */
export function enqueueLocalRow(
  table: string,
  operation: SyncOp,
  id: number | string,
  db: Database.Database = getDb()
): boolean {
  if (!isSupabaseConfigured()) return false;
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return false;
  // Inject tenant_id at enqueue time, per D.1 rules.
  return enqueueSync(table, id, operation, { ...row, tenant_id: getTenantId(db) }, db);
}

// Exact columns customers_cloud accepts. A local customer row also has
// sms_consent_* (kept out of the cloud, PII) so we project explicitly rather
// than SELECT * — an unknown column would make the whole upsert fail.
const CUSTOMER_CLOUD_COLUMNS = [
  'id', 'uid', 'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'state', 'zip',
  'dob', 'license_number', 'notes', 'opt_in_sms', 'loyalty_points', 'lifetime_points', 'gold_member',
  'created_at', 'updated_at',
] as const;

/**
 * Phase 3 producer: enqueue a customer for the shared (per-location) book.
 * Ensures the row has a stable `uid` (generating one if missing — the identity
 * peers converge on), projects only cloud columns, and coerces SQLite 0/1 flags
 * to real booleans. Call inside the same db.transaction() as the local write.
 */
export function enqueueCustomer(
  operation: SyncOp,
  id: number | string,
  db: Database.Database = getDb()
): boolean {
  const row = db.prepare('SELECT * FROM customers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return false;
  if (!row.uid) {
    const uid = randomUUID();
    db.prepare('UPDATE customers SET uid = ? WHERE id = ?').run(uid, id);
    row.uid = uid;
  }
  if (!isSupabaseConfigured()) return false; // uid persisted locally; nothing to sync yet
  const payload: Record<string, unknown> = { tenant_id: getTenantId(db) };
  for (const c of CUSTOMER_CLOUD_COLUMNS) payload[c] = row[c] ?? null;
  payload.opt_in_sms = !!row.opt_in_sms;
  payload.gold_member = !!row.gold_member;
  // record_id = uid so the sync-queue row and any conflict log key on the shared identity.
  return enqueueSync('customers', String(row.uid), operation, payload, db);
}

/**
 * Phase 3 pull applier: land a peer's customer into the local book.
 * Identity = uid; falls back to phone to adopt a uid onto an un-synced local
 * record (dedup). Guards local unsynced edits: if this register has a pending
 * customer change queued for the same uid, we keep local (our push resolves it
 * via the update-path LWW) instead of letting an inbound row clobber it.
 */
function applyCustomer(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const uid = String(row.uid ?? '');
  if (!uid) return;

  let local = db.prepare('SELECT id, uid FROM customers WHERE uid = ?').get(uid) as
    | { id: number; uid: string | null }
    | undefined;
  // Dedup: adopt this uid onto a local record that shares the phone but has no uid yet.
  if (!local && row.phone) {
    const byPhone = db.prepare('SELECT id, uid FROM customers WHERE phone = ? AND (uid IS NULL OR uid = ?) LIMIT 1')
      .get(String(row.phone), uid) as { id: number; uid: string | null } | undefined;
    if (byPhone) local = byPhone;
  }

  // Don't clobber a local row that has an unpushed edit for this uid.
  if (local) {
    const pending = db.prepare(
      `SELECT 1 FROM sync_queue WHERE table_name = 'customers' AND record_id = ? AND synced = 0 AND dead_letter = 0 LIMIT 1`
    ).get(uid);
    if (pending) return;
  }

  const cols = ['first_name', 'last_name', 'phone', 'email', 'address', 'city', 'state', 'zip', 'dob', 'license_number', 'notes'];
  const vals = cols.map((c) => (row[c] as string | null) ?? null);
  // first_name/last_name are NOT NULL locally but nullable in the cloud.
  vals[0] = vals[0] ?? '';
  vals[1] = vals[1] ?? '';
  const optIn = row.opt_in_sms ? 1 : 0;
  const gold = row.gold_member ? 1 : 0;
  const loyalty = Number(row.loyalty_points) || 0;
  const lifetime = Number(row.lifetime_points) || 0;
  const updatedAt = String(row.updated_at ?? new Date().toISOString());

  if (local) {
    db.prepare(
      `UPDATE customers SET first_name=?, last_name=?, phone=?, email=?, address=?, city=?, state=?, zip=?, dob=?,
         license_number=?, notes=?, opt_in_sms=?, loyalty_points=?, lifetime_points=?, gold_member=?, uid=?, updated_at=?
       WHERE id=?`
    ).run(...vals, optIn, loyalty, lifetime, gold, uid, updatedAt, local.id);
  } else {
    db.prepare(
      `INSERT INTO customers (first_name, last_name, phone, email, address, city, state, zip, dob, license_number, notes,
         opt_in_sms, loyalty_points, lifetime_points, gold_member, uid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      ...vals, optIn, loyalty, lifetime, gold, uid,
      String(row.created_at ?? updatedAt), updatedAt
    );
  }
}

/**
 * Path 4 producer: enqueue a stock-level snapshot for a product to
 * inventory_cloud (reporting-only). Reads the canonical `products` row, pulls a
 * SKU from product_variants when one exists. No-op when Supabase is off.
 */
export function enqueueInventorySnapshot(
  productId: number,
  reason: 'sale' | 'manual',
  db: Database.Database = getDb()
): boolean {
  if (!isSupabaseConfigured()) return false;
  const p = db
    .prepare('SELECT id, barcode, name, category, price, cost, stock_qty, low_stock_threshold FROM products WHERE id = ?')
    .get(productId) as
    | { id: number; barcode: string | null; name: string; category: string | null; price: number; cost: number; stock_qty: number; low_stock_threshold: number }
    | undefined;
  if (!p) return false;
  const sku =
    (db.prepare('SELECT sku FROM product_variants WHERE product_id = ? AND sku IS NOT NULL LIMIT 1').get(productId) as
      | { sku: string }
      | undefined)?.sku ?? null;
  const payload = {
    id: p.id,
    product_id: p.id,
    tenant_id: getTenantId(db),
    sku,
    barcode: p.barcode,
    name: p.name,
    category: p.category,
    price: p.price,
    cost: p.cost,
    quantity: p.stock_qty,
    reorder_point: p.low_stock_threshold,
    adjustment_reason: reason,
    updated_at: new Date().toISOString(),
  };
  return enqueueSync('inventory', p.id, 'update', payload, db);
}

/**
 * Phase 2 producer: record a stock MOVEMENT (delta) for a product and enqueue it
 * to stock_movements_cloud so location peers converge to the same count. Writes
 * the local `stock_movements` log row first (source of truth for replay/audit),
 * then queues it. No-op when Supabase is off or delta is 0.
 *
 * MUST be called inside the same db.transaction() as the stock_qty change so the
 * local count and the movement stay atomic. The caller has already applied the
 * delta to products.stock_qty; this only records/propagates it.
 */
export function enqueueStockMovement(
  productId: number,
  delta: number,
  reason: 'sale' | 'manual' | 'receive' | 'return',
  db: Database.Database = getDb()
): boolean {
  if (!delta) return false;
  const p = db.prepare('SELECT id, barcode FROM products WHERE id = ?').get(productId) as
    | { id: number; barcode: string | null }
    | undefined;
  if (!p) return false;
  const sku =
    (db.prepare('SELECT sku FROM product_variants WHERE product_id = ? AND sku IS NOT NULL LIMIT 1').get(productId) as
      | { sku: string }
      | undefined)?.sku ?? null;

  const movementUid = randomUUID();
  const createdAt = new Date().toISOString();
  // Local movement log (kept even on pure-local installs, for audit/replay).
  db.prepare(
    `INSERT INTO stock_movements (movement_uid, product_id, barcode, sku, delta, reason, register_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(movementUid, p.id, p.barcode, sku, delta, reason, getRegisterId(db), createdAt);

  if (!isSupabaseConfigured()) return false; // logged locally; nothing to sync
  return enqueueSync(
    'stock_movements',
    movementUid,
    'insert',
    { movement_uid: movementUid, product_id: p.id, barcode: p.barcode, sku, delta, reason, created_at: createdAt },
    db
  );
}

/**
 * Phase 2 pull applier: land a peer's stock movement locally and apply its delta.
 * Idempotent — INSERT OR IGNORE on movement_uid means a re-fetched boundary row
 * is a no-op. Only peer rows reach here (pullCycle skips our own register_id), so
 * we never double-count movements this register already applied at sale time.
 * Resolves the local product by barcode, then variant sku; skips the count update
 * if this register doesn't carry the product (movement is still recorded).
 */
function applyStockMovement(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const uid = String(row.movement_uid ?? '');
  if (!uid) return;
  const delta = Number(row.delta) || 0;
  const res = db
    .prepare(
      `INSERT OR IGNORE INTO stock_movements (movement_uid, product_id, barcode, sku, delta, reason, register_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      uid,
      row.product_id != null ? Number(row.product_id) : null,
      (row.barcode as string) ?? null,
      (row.sku as string) ?? null,
      delta,
      String(row.reason ?? 'manual'),
      (row.register_id as string) ?? null,
      String(row.created_at ?? new Date().toISOString())
    );
  if (res.changes === 0 || !delta) return; // already applied, or nothing to move

  // Resolve the local product by shared identity (ids differ across registers).
  let local = row.barcode
    ? (db.prepare('SELECT id FROM products WHERE barcode = ? LIMIT 1').get(String(row.barcode)) as { id: number } | undefined)
    : undefined;
  if (!local && row.sku) {
    const v = db.prepare('SELECT product_id FROM product_variants WHERE sku = ? LIMIT 1').get(String(row.sku)) as
      | { product_id: number }
      | undefined;
    if (v) local = { id: v.product_id };
  }
  if (local) {
    db.prepare('UPDATE products SET stock_qty = MAX(0, stock_qty + ?), updated_at = ? WHERE id = ?').run(
      delta,
      new Date().toISOString(),
      local.id
    );
  }
}

/**
 * Path 5 producer: enqueue a drawer event (from local drawer_log) to
 * cash_drawer_sessions_cloud. No-op when Supabase is off.
 */
export function enqueueDrawerEvent(eventId: number, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const e = db.prepare('SELECT * FROM drawer_log WHERE id = ?').get(eventId) as
    | { id: number; cashier_id: number | null; cashier_name: string | null; event: string; amount: number; note: string | null; created_at: string }
    | undefined;
  if (!e) return false;
  const payload = {
    id: e.id,
    tenant_id: getTenantId(db),
    employee_id: e.cashier_id,
    cashier_name: e.cashier_name,
    event: e.event,
    amount: e.amount,
    note: e.note,
    opened_at: e.created_at,
  };
  return enqueueSync('cash_drawer_sessions', e.id, 'insert', payload, db);
}

// ── cloud push + conflict resolution ────────────────────────────────────────
async function pushRecord(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  row: SyncQueueRow
): Promise<void> {
  const verdict = isSyncAllowed(row.table_name, row.operation);
  if (!verdict.allowed) throw new Error(verdict.reason);
  const cloudTable = verdict.cloudTable as string;
  const tenantId = getTenantId();
  // Inject tenant_id so every cloud row is correctly scoped. (Follow-up #1)
  const payload: Record<string, unknown> = {
    ...(JSON.parse(row.payload) as Record<string, unknown>),
    tenant_id: tenantId,
  };
  // Location-scoped tables also carry the store + till identity (migration 016);
  // unscoped tables (scan_data_queue) omit them — those columns don't exist there.
  if (verdict.scoped) {
    payload.location_id = getLocationId();
    payload.register_id = getRegisterId();
  }

  if (row.operation === 'insert') {
    // Idempotent on retry: insert, do nothing if it already landed. The conflict
    // target is the cloud table's unique key (e.g. movement_uid for the append log).
    const { error } = await supabase
      .from(cloudTable)
      .upsert(payload, { onConflict: verdict.conflictTarget as string, ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return;
  }

  if (row.operation === 'update') {
    // Last-write-wins on updated_at; if cloud is newer, flag a conflict and DON'T overwrite.
    const localUpdated = (payload.updated_at as string) ?? null;
    // Look up the remote row by its identity columns (the conflict target), not
    // always 'id' — customers are keyed by (tenant_id, uid), inventory by (tenant_id, id).
    let sel = supabase.from(cloudTable).select('updated_at');
    for (const col of (verdict.conflictTarget as string).split(',')) {
      sel = sel.eq(col.trim(), payload[col.trim()] as string);
    }
    const { data: remote, error: rErr } = await sel.maybeSingle();
    if (rErr) throw new Error(rErr.message);
    const remoteUpdated = (remote?.updated_at as string) ?? null;
    if (localUpdated && remoteUpdated && new Date(remoteUpdated).getTime() > new Date(localUpdated).getTime()) {
      recordConflict(row, localUpdated, remoteUpdated);
      // Surface the conflict in the cloud conflicts table for the manager PWA.
      // The per-install JWT scopes this insert to the tenant via RLS. Non-fatal:
      // the local conflicts table already has the record either way.
      try {
        await supabase.from('conflicts').insert({
          tenant_id: tenantId,
          table_name: row.table_name,
          record_id: row.record_id,
          local_updated_at: localUpdated,
          remote_updated_at: remoteUpdated,
          local_payload: JSON.parse(row.payload),
          resolved: false,
        });
      } catch {
        /* non-fatal — the local conflicts table still has it */
      }
      return; // resolved by keeping local; cloud untouched
    }
    const { error } = await supabase.from(cloudTable).upsert(payload, { onConflict: verdict.conflictTarget as string });
    if (error) throw new Error(error.message);
    return;
  }

  throw new Error(`unsupported operation '${row.operation}'`);
}

// ── peer pull (downward sync within a location) ──────────────────────────────
/**
 * A cloud table this register PULLS from its location peers, plus the local
 * applier that lands each incoming row. Registered by the feature phases:
 *   • stock_movements — Phase 2 (inventory event-deltas)
 *   • customers       — Phase 3 (shared customer book)
 * The engine is generic: it pages by an `updated_at` cursor, skips rows this
 * register itself produced, and calls `apply` for each peer row. Appliers MUST be
 * idempotent (the cursor uses `>=`, so boundary rows can re-arrive).
 */
export interface PullSpec {
  cloudTable: string;
  apply: (row: Record<string, unknown>, db: Database.Database) => void;
  // 'location' (default): peer rows for this register's location, skipping its own.
  // 'tenant': tenant-wide config (rebate rules, manufacturers) — applied to all.
  scope?: 'location' | 'tenant';
}
const PULL_SPECS: Record<string, PullSpec> = {};

/** Register a pullable table. Called at module load by the feature phases. */
export function registerPullSpec(key: string, spec: PullSpec): void {
  PULL_SPECS[key] = spec;
}

// Phase 2: pull peers' stock movements and replay their deltas locally.
registerPullSpec('stock_movements', { cloudTable: 'stock_movements_cloud', apply: applyStockMovement });
// Phase 3: pull peers' customers into the shared per-location book.
registerPullSpec('customers', { cloudTable: 'customers_cloud', apply: applyCustomer });

// ── Rebates: tenant config pulled DOWN so every register detects offline ──────
function applyManufacturer(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const uid = String(row.uid ?? ''); if (!uid) return;
  db.prepare(
    `INSERT INTO manufacturers (uid, name, parent_company_code, batch_end_dow, due_dow, due_offset_weeks, timezone, is_active, updated_at)
     VALUES (@uid,@name,@code,@bed,@dd,@dow,@tz,@active,@upd)
     ON CONFLICT(uid) DO UPDATE SET name=excluded.name, parent_company_code=excluded.parent_company_code,
       batch_end_dow=excluded.batch_end_dow, due_dow=excluded.due_dow, due_offset_weeks=excluded.due_offset_weeks,
       timezone=excluded.timezone, is_active=excluded.is_active, updated_at=excluded.updated_at`
  ).run({
    uid, name: String(row.name ?? ''), code: (row.parent_company_code as string) ?? null,
    bed: row.batch_end_dow ?? null, dd: row.due_dow ?? null, dow: Number(row.due_offset_weeks) || 1,
    tz: (row.timezone as string) ?? null, active: row.is_active ? 1 : 0,
    upd: String(row.updated_at ?? new Date().toISOString()),
  });
}
function applyRebateRule(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const uid = String(row.uid ?? ''); if (!uid) return;
  const skus = Array.isArray(row.qualifying_skus) ? JSON.stringify(row.qualifying_skus)
    : (typeof row.qualifying_skus === 'string' ? row.qualifying_skus : '[]');
  db.prepare(
    `INSERT INTO rebate_rules (uid, manufacturer_uid, name, rule_type, qualifying_skus, qualifying_quantity,
       discount_amount, discount_type, is_manufacturer_funded, active_start_date, active_end_date, is_active, updated_at)
     VALUES (@uid,@mfr,@name,@type,@skus,@qty,@amt,@dtype,@funded,@start,@end,@active,@upd)
     ON CONFLICT(uid) DO UPDATE SET manufacturer_uid=excluded.manufacturer_uid, name=excluded.name, rule_type=excluded.rule_type,
       qualifying_skus=excluded.qualifying_skus, qualifying_quantity=excluded.qualifying_quantity, discount_amount=excluded.discount_amount,
       discount_type=excluded.discount_type, is_manufacturer_funded=excluded.is_manufacturer_funded,
       active_start_date=excluded.active_start_date, active_end_date=excluded.active_end_date, is_active=excluded.is_active,
       updated_at=excluded.updated_at`
  ).run({
    uid, mfr: (row.manufacturer_uid as string) ?? null, name: String(row.name ?? ''), type: String(row.rule_type ?? 'flat_discount'),
    skus, qty: Number(row.qualifying_quantity) || 1, amt: Number(row.discount_amount) || 0, dtype: String(row.discount_type ?? 'flat'),
    funded: row.is_manufacturer_funded ? 1 : 0, start: (row.active_start_date as string) ?? null, end: (row.active_end_date as string) ?? null,
    active: row.is_active ? 1 : 0, upd: String(row.updated_at ?? new Date().toISOString()),
  });
}
registerPullSpec('manufacturers', { cloudTable: 'manufacturers_cloud', scope: 'tenant', apply: applyManufacturer });
registerPullSpec('rebate_rules', { cloudTable: 'rebate_rules_cloud', scope: 'tenant', apply: applyRebateRule });

// ── Staff + permissions: pull DOWN (location config); override log pushes UP ───
function applyEmployee(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const uid = String(row.uid ?? ''); if (!uid) return;
  const role = row.role === 'admin' ? 'admin' : row.role === 'manager' ? 'manager' : 'cashier';
  const username = (row.username as string) ?? null; // null for cashiers (PIN only)
  const mcp = row.must_change_password ? 1 : 0;
  const mcpin = row.must_change_pin ? 1 : 0;
  const existing = db.prepare('SELECT id FROM users WHERE uid = ?').get(uid) as { id: number } | undefined;
  if (existing) {
    // COALESCE the hashes so a payload that omits one (e.g. a cashier row with no
    // password) never wipes a locally-set credential.
    db.prepare(
      `UPDATE users SET username=?, name=?, role=?, password_hash=COALESCE(?, password_hash),
         pin_hash=COALESCE(?, pin_hash), is_active=?, must_change_password=?, must_change_pin=?, location_id=? WHERE uid=?`
    ).run(
      username, (row.name as string) ?? null, role, (row.password_hash as string) ?? null,
      (row.pin_hash as string) ?? null, row.is_active ? 1 : 0, mcp, mcpin, (row.location_id as string) ?? null, uid
    );
  } else {
    // Only guard against a username collision when this staff member has one.
    if (username) {
      const clash = db.prepare('SELECT 1 FROM users WHERE username = ? AND (uid IS NULL OR uid <> ?)').get(username, uid);
      if (clash) return;
    }
    db.prepare(
      `INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active, must_change_password, must_change_pin, location_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uid, username, (row.name as string) ?? null, role, (row.password_hash as string) ?? null,
      (row.pin_hash as string) ?? null, row.is_active ? 1 : 0, mcp, mcpin, (row.location_id as string) ?? null
    );
  }
}
function applyEmployeePermission(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const uid = String(row.uid ?? ''); if (!uid) return;
  db.prepare(
    `INSERT INTO employee_permissions (uid, employee_uid, permission_key, is_granted, value, updated_at)
     VALUES (@uid, @emp, @key, @grant, @val, @upd)
     ON CONFLICT(uid) DO UPDATE SET is_granted=excluded.is_granted, value=excluded.value, updated_at=excluded.updated_at`
  ).run({
    uid, emp: String(row.employee_uid ?? ''), key: String(row.permission_key ?? ''),
    grant: row.is_granted ? 1 : 0, val: row.value ?? null, upd: String(row.updated_at ?? new Date().toISOString()),
  });
}
// Staff are business-wide (the admin has no location; managers roam between
// kiosks), so pull them tenant-wide rather than per-location.
registerPullSpec('employees', { cloudTable: 'employees_cloud', scope: 'tenant', apply: applyEmployee });
registerPullSpec('employee_permissions', { cloudTable: 'employee_permissions_cloud', scope: 'tenant', apply: applyEmployeePermission });

function applyTimeClock(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const uid = String(row.uid ?? ''); if (!uid) return;
  db.prepare(
    `INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out, register_id, updated_at)
     VALUES (@uid, @emp, @name, @in, @out, @reg, @upd)
     ON CONFLICT(uid) DO UPDATE SET clock_out=excluded.clock_out, employee_name=excluded.employee_name, updated_at=excluded.updated_at`
  ).run({
    uid, emp: String(row.employee_uid ?? ''), name: (row.employee_name as string) ?? null,
    in: String(row.clock_in ?? ''), out: (row.clock_out as string) ?? null,
    reg: (row.register_id as string) ?? null, upd: String(row.updated_at ?? new Date().toISOString()),
  });
}
registerPullSpec('time_clock', { cloudTable: 'time_clock_cloud', apply: applyTimeClock });

/** Push a time-clock punch (insert on clock-in, update on clock-out). */
export function enqueueTimeClock(operation: SyncOp, uid: string, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const r = db.prepare('SELECT * FROM time_clock WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (!r) return false;
  return enqueueSync('time_clock', String(uid), operation, {
    uid: r.uid, employee_uid: r.employee_uid, employee_name: r.employee_name ?? null,
    clock_in: r.clock_in, clock_out: r.clock_out ?? null,
  }, db);
}

/** Push an employee (staff record) up. pin_hash rides along (password_hash does not). */
export function enqueueEmployee(operation: SyncOp, uid: string, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const u = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (!u) return false;
  return enqueueSync('employees', String(uid), operation, {
    tenant_id: getTenantId(db), uid: u.uid, username: u.username ?? null, name: u.name ?? null,
    role: u.role, password_hash: u.password_hash ?? null, pin_hash: u.pin_hash ?? null,
    must_change_password: !!u.must_change_password, must_change_pin: !!u.must_change_pin,
    is_active: !!u.is_active, updated_at: new Date().toISOString(),
  }, db);
}
/** Push a single permission grant up. */
export function enqueueEmployeePermission(operation: SyncOp, uid: string, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const p = db.prepare('SELECT * FROM employee_permissions WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (!p) return false;
  return enqueueSync('employee_permissions', String(uid), operation, {
    tenant_id: getTenantId(db), uid: p.uid, employee_uid: p.employee_uid, permission_key: p.permission_key,
    is_granted: !!p.is_granted, value: p.value ?? null, updated_at: p.updated_at,
  }, db);
}
/** Push an append-only override/lockout audit row up (insert-only). */
export function enqueueOverrideLog(uid: string, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const r = db.prepare('SELECT * FROM permission_override_log WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (!r) return false;
  return enqueueSync('permission_override_log', String(uid), 'insert', {
    uid: r.uid, at: r.at, acting_employee_uid: r.acting_employee_uid ?? null, acting_employee_name: r.acting_employee_name ?? null,
    action_attempted: r.action_attempted, required_permission: r.required_permission ?? null,
    authorizing_manager_uid: r.authorizing_manager_uid ?? null, authorizing_manager_name: r.authorizing_manager_name ?? null,
    was_approved: !!r.was_approved, event_type: r.event_type, transaction_id: r.transaction_id ?? null,
  }, db);
}

// ── Rebates: producers (push UP) ──────────────────────────────────────────────
/** Push a rebate rule authored on this POS up to the tenant config (insert/update). */
export function enqueueRebateRule(operation: SyncOp, uid: string, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const r = db.prepare('SELECT * FROM rebate_rules WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (!r) return false;
  const payload = {
    tenant_id: getTenantId(db),
    uid: r.uid, manufacturer_uid: r.manufacturer_uid ?? null, name: r.name, rule_type: r.rule_type,
    qualifying_skus: JSON.parse(String(r.qualifying_skus || '[]')), // jsonb column wants an array
    qualifying_quantity: r.qualifying_quantity, discount_amount: r.discount_amount, discount_type: r.discount_type,
    is_manufacturer_funded: !!r.is_manufacturer_funded, active_start_date: r.active_start_date ?? null,
    active_end_date: r.active_end_date ?? null, is_active: !!r.is_active, register_id: getRegisterId(db),
    updated_at: r.updated_at,
  };
  return enqueueSync('rebate_rules', String(uid), operation, payload, db);
}
/** Push a rebate application (audit) up. Location/register injected at push time. */
export function enqueueAppliedRebate(uid: string, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const r = db.prepare('SELECT * FROM applied_rebates WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (!r) return false;
  const payload = {
    uid: r.uid, transaction_id: r.transaction_id ?? null, rebate_rule_uid: r.rebate_rule_uid ?? null,
    manufacturer_uid: r.manufacturer_uid ?? null, barcode: r.barcode ?? null, discount_amount: r.discount_amount,
    is_manufacturer_funded: !!r.is_manufacturer_funded, was_auto_applied: !!r.was_auto_applied, applied_at: r.applied_at,
  };
  return enqueueSync('applied_rebates', String(uid), 'insert', payload, db);
}
/** Push a missed-rebate opportunity (reconciliation) up. */
export function enqueueMissedRebate(uid: string, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const r = db.prepare('SELECT * FROM missed_rebates WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (!r) return false;
  const payload = {
    uid: r.uid, transaction_id: r.transaction_id ?? null, rebate_rule_uid: r.rebate_rule_uid ?? null,
    manufacturer_uid: r.manufacturer_uid ?? null, barcode: r.barcode ?? null, potential_discount: r.potential_discount,
    detected_at: r.detected_at,
  };
  return enqueueSync('missed_rebates', String(uid), 'insert', payload, db);
}

/**
 * Drain peers' changes for this location into the local DB. No-op unless the
 * license carries a location_id (pre-v3 installs and manager tokens skip this).
 * Returns the last error string, or null on a clean pass.
 */
async function pullCycle(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  db: Database.Database
): Promise<string | null> {
  let tenantId: string;
  try { tenantId = getTenantId(db); } catch { return null; } // no license -> nothing to pull
  const locationId = getLocationId(db);
  const selfRegister = getRegisterId(db);
  let lastError: string | null = null;

  for (const [key, spec] of Object.entries(PULL_SPECS)) {
    const scope = spec.scope ?? 'location';
    if (scope === 'location' && !locationId) continue; // location sync needs a location
    try {
      const cursor = getCursor(key, db);
      let q = supabase
        .from(spec.cloudTable)
        .select('*')
        .order('updated_at', { ascending: true })
        .limit(BATCH_SIZE);
      q = scope === 'tenant' ? q.eq('tenant_id', tenantId) : q.eq('location_id', locationId as string);
      if (cursor) q = q.gte('updated_at', cursor);
      const { data, error } = await q;
      if (error) throw new Error(error.message);

      let maxUpdated = cursor;
      const applyAll = db.transaction((rows: Record<string, unknown>[]) => {
        for (const row of rows) {
          const updatedAt = String(row.updated_at ?? '');
          // Location peers: skip rows this register produced. Tenant config is
          // applied to everyone (the author re-applying its own row is a no-op).
          const skipOwn = scope === 'location' && row.register_id === selfRegister;
          if (!skipOwn) spec.apply(row, db);
          if (!maxUpdated || updatedAt > maxUpdated) maxUpdated = updatedAt;
        }
      });
      applyAll((data ?? []) as Record<string, unknown>[]);

      if (maxUpdated && maxUpdated !== cursor) setCursor(key, maxUpdated, db);
    } catch (err) {
      lastError = `pull ${key}: ${String(err)}`;
      console.warn(`[sync] ${lastError}`);
    }
  }
  return lastError;
}

// ── the cycle ───────────────────────────────────────────────────────────────
let cycleRunning = false;

async function runCycle(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    if (!isSupabaseConfigured()) return; // dormant; nothing to do

    const db = getDb();
    writeSetting('last_sync_attempted_at', new Date().toISOString(), db);

    const reachable = await pingSupabase();
    setOnline(reachable);
    if (!reachable) {
      writeSetting('last_sync_error', 'offline', db);
      persistCounts(db);
      broadcast('sync:status', getSyncStatus(db));
      return;
    }

    const supabase = getSupabase();
    if (!supabase) return;

    const rows = db
      .prepare(
        `SELECT * FROM sync_queue
         WHERE synced = 0 AND dead_letter = 0 AND attempts < ?
         ORDER BY created_at ASC, id ASC
         LIMIT ?`
      )
      .all(MAX_ATTEMPTS, BATCH_SIZE) as SyncQueueRow[];

    let lastError: string | null = null;
    for (const row of rows) {
      try {
        await pushRecord(supabase, row);
        markSynced(row.id, db);
      } catch (err) {
        lastError = String(err);
        recordFailure(row.id, row.attempts, lastError, db);
      }
    }

    // Downward sync: pull peers' changes for this location (customers, stock
    // movements). Non-fatal — a pull error is surfaced but doesn't block push.
    const pullError = await pullCycle(supabase, db);
    if (pullError && !lastError) lastError = pullError;

    // Remote kiosk reset (item 5): apply any Owner-Console reset for this machine.
    // Runs AFTER push so flush-then-reset sees a freshly-drained outbox. Non-fatal;
    // may relaunch the app (clean setup) when it decides to reset. Lazy require
    // avoids a sync<->kioskCommands import cycle.
    try {
      const { checkAndApplyResets } = require('../kioskCommands') as typeof import('../kioskCommands');
      await checkAndApplyResets(supabase, db);
    } catch (err) {
      console.warn('[sync] kiosk-reset check failed (non-fatal):', String(err));
    }

    writeSetting('last_sync_error', lastError ?? '', db);
    if (!lastError) writeSetting('last_sync_succeeded_at', new Date().toISOString(), db);
    persistCounts(db);
    broadcast('sync:status', getSyncStatus(db));
  } catch (err) {
    // Worker must never crash the app — log and let the next tick retry.
    console.error('[sync] cycle failed (caught, will retry next tick):', err);
    try {
      writeSetting('last_sync_error', String(err));
    } catch {
      /* db unavailable; ignore */
    }
  } finally {
    cycleRunning = false;
  }
}

/** Wrap every cycle so an unhandled rejection can never escape the worker. */
function safeCycle(): Promise<void> {
  return runCycle().catch((err) => {
    console.error('[sync] unhandled cycle error (swallowed):', err);
  });
}

// ── lifecycle / triggers ────────────────────────────────────────────────────
let interval: NodeJS.Timeout | null = null;

/** Start the 60s worker and run one cycle immediately (call after license check). */
export function startSyncWorker(): void {
  if (interval) return;
  void safeCycle(); // immediate pass on launch
  interval = setInterval(() => void safeCycle(), SYNC_INTERVAL_MS);
  console.log('[sync] worker started (every 60s; immediate, on-reconnect, and manual triggers).');
}

/** Manual trigger (IPC) — also used for tests. */
export function triggerSyncNow(): Promise<void> {
  return safeCycle();
}

export function stopSyncWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
