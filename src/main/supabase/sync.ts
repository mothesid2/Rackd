import { net, BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getDb } from '../db/schema';
import { getSupabase, isSupabaseConfigured } from './client';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from './publicConfig';
import { loadCachedLicense } from './licenseCheck';
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
const MAX_ATTEMPTS = 5; // dead-letter after this many failures
const PING_TIMEOUT_MS = 4_000;

// Mirror tables are keyed (tenant_id, id); a single shared conflict target keeps
// every upsert idempotent and prevents per-table drift. (Follow-up #2)
const UPSERT_ON_CONFLICT = 'tenant_id,id';

/** Per-table sync policy: which operations are allowed and the cloud target. */
interface Policy {
  ops: SyncOp[];
  cloudTable: string;
}
const SYNC_POLICY: Record<string, Policy> = {
  transactions: { ops: ['insert'], cloudTable: 'transactions_cloud' },
  transaction_items: { ops: ['insert'], cloudTable: 'transaction_items_cloud' },
  customers: { ops: ['insert', 'update'], cloudTable: 'customers_cloud' },
  inventory: { ops: ['update'], cloudTable: 'inventory_cloud' }, // cloud is reporting-only
  cash_drawer_sessions: { ops: ['insert'], cloudTable: 'cash_drawer_sessions_cloud' },
  scan_data_queue: { ops: ['insert'], cloudTable: 'scan_data_queue' },
};
// Never leaves the device, regardless of how enqueue is called.
const NEVER_SYNC = new Set(['settings', 'sync_queue', 'conflicts', 'employees', 'users']);
// Stripped from any payload before it can reach the cloud.
const SENSITIVE_FIELDS = ['pin', 'password', 'password_hash', 'token', 'auth_token'];

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

// ── policy / enqueue ────────────────────────────────────────────────────────
export interface SyncVerdict {
  allowed: boolean;
  reason?: string;
  cloudTable?: string;
}
export function isSyncAllowed(table: string, op: SyncOp): SyncVerdict {
  if (NEVER_SYNC.has(table)) return { allowed: false, reason: 'table is never synced' };
  const policy = SYNC_POLICY[table];
  if (!policy) return { allowed: false, reason: 'no sync policy for table' };
  if (!policy.ops.includes(op)) return { allowed: false, reason: `operation '${op}' not allowed for ${table}` };
  return { allowed: true, cloudTable: policy.cloudTable };
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
export interface SyncStatus {
  online: boolean;
  last_sync_attempted_at: string | null;
  last_sync_succeeded_at: string | null;
  last_sync_error: string | null;
  pending_sync_count: number;
  dead_letter_count: number;
}

export function getSyncStatus(db: Database.Database = getDb()): SyncStatus {
  const pending = (
    db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE synced = 0 AND dead_letter = 0').get() as { n: number }
  ).n;
  // Actionable dead-letters only (abandoned ones are excluded from the count).
  const dead = (
    db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE dead_letter = 1 AND abandoned = 0').get() as { n: number }
  ).n;
  return {
    online,
    last_sync_attempted_at: readSetting('last_sync_attempted_at', db),
    last_sync_succeeded_at: readSetting('last_sync_succeeded_at', db),
    last_sync_error: readSetting('last_sync_error', db),
    pending_sync_count: pending,
    dead_letter_count: dead,
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

  if (row.operation === 'insert') {
    // Idempotent on retry: insert, do nothing if it already landed.
    const { error } = await supabase
      .from(cloudTable)
      .upsert(payload, { onConflict: UPSERT_ON_CONFLICT, ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return;
  }

  if (row.operation === 'update') {
    // Last-write-wins on updated_at; if cloud is newer, flag a conflict and DON'T overwrite.
    const localUpdated = (payload.updated_at as string) ?? null;
    const { data: remote, error: rErr } = await supabase
      .from(cloudTable)
      .select('updated_at')
      .eq('id', row.record_id)
      .eq('tenant_id', tenantId)
      .maybeSingle();
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
    const { error } = await supabase.from(cloudTable).upsert(payload, { onConflict: UPSERT_ON_CONFLICT });
    if (error) throw new Error(error.message);
    return;
  }

  throw new Error(`unsupported operation '${row.operation}'`);
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
