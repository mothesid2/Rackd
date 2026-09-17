import { randomUUID } from 'crypto';
import { net, BrowserWindow } from 'electron';
import type Database from 'better-sqlite3';
import { getDb } from '../db/schema';
import { getSupabase, isSupabaseConfigured } from './client';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from './publicConfig';
import { loadCachedLicense } from './licenseCheck';
import { getMachineId } from './tokenManager';
import type { SyncOp, SyncQueueRow } from '../db/types';



const SYNC_INTERVAL_MS = 60_000; 
const BATCH_SIZE = 50; 
const MAX_ATTEMPTS = 3; 
const PING_TIMEOUT_MS = 4_000;


interface Policy {
  ops: SyncOp[];
  cloudTable: string;
  scoped?: boolean;
  
  conflictTarget?: string;
}
const DEFAULT_CONFLICT_TARGET = 'tenant_id,id';
const SYNC_POLICY: Record<string, Policy> = {
  
  
  
  
  
  
  
  transactions: { ops: ['insert', 'delete'], cloudTable: 'transactions_cloud', scoped: true, conflictTarget: 'tenant_id,register_id,id' },
  transaction_items: { ops: ['insert', 'delete'], cloudTable: 'transaction_items_cloud', scoped: true, conflictTarget: 'tenant_id,register_id,id' },
  
  customers: { ops: ['insert', 'update'], cloudTable: 'customers_cloud', scoped: true, conflictTarget: 'tenant_id,uid' },
  
  
  
  
  
  
  
  
  
  
  
  inventory: { ops: ['update'], cloudTable: 'inventory_cloud', scoped: true, conflictTarget: 'tenant_id,register_id,barcode' }, 
  
  stock_movements: { ops: ['insert'], cloudTable: 'stock_movements_cloud', scoped: true, conflictTarget: 'movement_uid' },
  
  
  cash_drawer_sessions: { ops: ['insert'], cloudTable: 'cash_drawer_sessions_cloud', scoped: true, conflictTarget: 'tenant_id,register_id,id' },
  
  
  
  z_reports: { ops: ['insert'], cloudTable: 'z_reports_cloud', scoped: true, conflictTarget: 'tenant_id,register_id,id' },
  scan_data_queue: { ops: ['insert'], cloudTable: 'scan_data_queue' }, 
  
  applied_rebates: { ops: ['insert'], cloudTable: 'applied_rebates_cloud', scoped: true, conflictTarget: 'uid' },
  missed_rebates: { ops: ['insert'], cloudTable: 'missed_rebates_cloud', scoped: true, conflictTarget: 'uid' },
  
  rebate_rules: { ops: ['insert', 'update'], cloudTable: 'rebate_rules_cloud', conflictTarget: 'tenant_id,uid' },
  
  
  
  categories: { ops: ['insert', 'update'], cloudTable: 'categories_cloud', conflictTarget: 'tenant_id,uid' },
  
  employees: { ops: ['insert', 'update'], cloudTable: 'employees_cloud', scoped: true, conflictTarget: 'tenant_id,uid' },
  employee_permissions: { ops: ['insert', 'update'], cloudTable: 'employee_permissions_cloud', scoped: true, conflictTarget: 'tenant_id,uid' },
  
  permission_override_log: { ops: ['insert'], cloudTable: 'permission_override_log_cloud', scoped: true, conflictTarget: 'uid' },
  
  time_clock: { ops: ['insert', 'update'], cloudTable: 'time_clock_cloud', scoped: true, conflictTarget: 'uid' },
};

const NEVER_SYNC = new Set(['settings', 'sync_queue', 'conflicts', 'users']);

const SENSITIVE_FIELDS = ['pin', 'password', 'token', 'auth_token'];


function writeSetting(key: string, value: string, db: Database.Database = getDb()): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, value);
}
function readSetting(key: string, db: Database.Database = getDb()): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}


interface PullCursor {
  updatedAt: string;
  cloudId: number | null;
}
function getCursor(table: string, db: Database.Database = getDb()): PullCursor | null {
  const row = db.prepare('SELECT last_pulled_at, last_cloud_id FROM sync_cursors WHERE table_name = ?').get(table) as
    | { last_pulled_at: string | null; last_cloud_id: number | null }
    | undefined;
  if (!row?.last_pulled_at) return null;
  return { updatedAt: row.last_pulled_at, cloudId: row.last_cloud_id };
}
function setCursor(table: string, cursor: PullCursor, db: Database.Database = getDb()): void {
  db.prepare(
    `INSERT INTO sync_cursors (table_name, last_pulled_at, last_cloud_id, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(table_name) DO UPDATE SET last_pulled_at = excluded.last_pulled_at, last_cloud_id = excluded.last_cloud_id, updated_at = datetime('now')`
  ).run(table, cursor.updatedAt, cursor.cloudId);
}


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
  
  const dead = (
    db.prepare('SELECT COUNT(*) AS n FROM sync_queue WHERE dead_letter = 1 AND abandoned = 0').get() as { n: number }
  ).n;
  const conflicts = (
    db.prepare('SELECT COUNT(*) AS n FROM conflicts WHERE resolved = 0').get() as { n: number }
  ).n;

  
  
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



export function getDeadLetters(db: Database.Database = getDb()): SyncQueueRow[] {
  return db
    .prepare('SELECT * FROM sync_queue WHERE dead_letter = 1 AND abandoned = 0 ORDER BY created_at DESC, id DESC')
    .all() as SyncQueueRow[];
}


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


let online = false;

export function getOnline(): boolean {
  return online;
}


async function pingSupabase(): Promise<boolean> {
  let osOnline = true;
  try {
    osOnline = net.isOnline();
  } catch {
    osOnline = true; 
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
    return false; 
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
        
      }
    }
  }
}


function setOnline(next: boolean): void {
  if (next === online) return;
  online = next;
  broadcast('sync:status', getSyncStatus());
  if (next) void safeCycle(); 
}


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


export function getLocationId(db: Database.Database = getDb()): string | null {
  return loadCachedLicense(db)?.location_id ?? null;
}


export function getRegisterId(db: Database.Database = getDb()): string {
  return getMachineId(db);
}


export function enqueueLocalRow(
  table: string,
  operation: SyncOp,
  id: number | string,
  db: Database.Database = getDb()
): boolean {
  if (!isSupabaseConfigured()) return false;
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  if (!row) return false;
  
  return enqueueSync(table, id, operation, { ...row, tenant_id: getTenantId(db) }, db);
}


const CUSTOMER_CLOUD_COLUMNS = [
  'id', 'uid', 'first_name', 'last_name', 'phone', 'email', 'address', 'city', 'state', 'zip',
  'dob', 'license_number', 'notes', 'opt_in_sms', 'loyalty_points', 'lifetime_points', 'gold_member',
  'created_at', 'updated_at',
] as const;


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
  if (!isSupabaseConfigured()) return false; 
  const payload: Record<string, unknown> = { tenant_id: getTenantId(db) };
  for (const c of CUSTOMER_CLOUD_COLUMNS) payload[c] = row[c] ?? null;
  payload.opt_in_sms = !!row.opt_in_sms;
  payload.gold_member = !!row.gold_member;
  
  return enqueueSync('customers', String(row.uid), operation, payload, db);
}


function applyCustomer(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const uid = String(row.uid ?? '');
  if (!uid) return;

  let local = db.prepare('SELECT id, uid FROM customers WHERE uid = ?').get(uid) as
    | { id: number; uid: string | null }
    | undefined;
  
  if (!local && row.phone) {
    const byPhone = db.prepare('SELECT id, uid FROM customers WHERE phone = ? AND (uid IS NULL OR uid = ?) LIMIT 1')
      .get(String(row.phone), uid) as { id: number; uid: string | null } | undefined;
    if (byPhone) local = byPhone;
  }

  
  if (local) {
    const pending = db.prepare(
      `SELECT 1 FROM sync_queue WHERE table_name = 'customers' AND record_id = ? AND synced = 0 AND dead_letter = 0 LIMIT 1`
    ).get(uid);
    if (pending) return;
  }

  const cols = ['first_name', 'last_name', 'phone', 'email', 'address', 'city', 'state', 'zip', 'dob', 'license_number', 'notes'];
  const vals = cols.map((c) => (row[c] as string | null) ?? null);
  
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


export function enqueueInventorySnapshot(
  productId: number,
  reason: 'sale' | 'manual',
  db: Database.Database = getDb()
): boolean {
  if (!isSupabaseConfigured()) return false;
  const p = db
    .prepare('SELECT id, barcode, name, category, vendor, price, cost, stock_qty, low_stock_threshold, age_restricted FROM products WHERE id = ?')
    .get(productId) as
    | { id: number; barcode: string | null; name: string; category: string | null; vendor: string | null; price: number; cost: number; stock_qty: number; low_stock_threshold: number; age_restricted: number }
    | undefined;
  if (!p) return false;
  
  
  
  
  
  
  
  
  if (!p.barcode) return false;
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
    vendor: p.vendor,
    price: p.price,
    cost: p.cost,
    age_restricted: !!p.age_restricted,
    quantity: p.stock_qty,
    reorder_point: p.low_stock_threshold,
    adjustment_reason: reason,
    updated_at: new Date().toISOString(),
  };
  return enqueueSync('inventory', p.id, 'update', payload, db);
}


export function resyncAllInventory(db: Database.Database = getDb()): number {
  if (!isSupabaseConfigured()) return 0;
  const ids = db.prepare('SELECT id FROM products').all() as { id: number }[];
  let n = 0;
  for (const { id } of ids) if (enqueueInventorySnapshot(id, 'manual', db)) n++;
  return n;
}


export function resyncAllTransactions(db: Database.Database = getDb()): number {
  if (!isSupabaseConfigured()) return 0;
  let n = 0;
  const txnIds = db.prepare('SELECT id FROM transactions').all() as { id: number }[];
  for (const { id } of txnIds) if (enqueueLocalRow('transactions', 'insert', id, db)) n++;
  const itemIds = db.prepare('SELECT id FROM transaction_items').all() as { id: number }[];
  for (const { id } of itemIds) if (enqueueLocalRow('transaction_items', 'insert', id, db)) n++;
  const drawerIds = db.prepare('SELECT id FROM drawer_log').all() as { id: number }[];
  for (const { id } of drawerIds) if (enqueueDrawerEvent(id, db)) n++;
  return n;
}


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
  
  db.prepare(
    `INSERT INTO stock_movements (movement_uid, product_id, barcode, sku, delta, reason, register_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(movementUid, p.id, p.barcode, sku, delta, reason, getRegisterId(db), createdAt);

  if (!isSupabaseConfigured()) return false; 
  return enqueueSync(
    'stock_movements',
    movementUid,
    'insert',
    { movement_uid: movementUid, product_id: p.id, barcode: p.barcode, sku, delta, reason, created_at: createdAt },
    db
  );
}


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
  if (res.changes === 0 || !delta) return; 

  
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


export function applyProduct(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const barcode = String(row.barcode ?? '').trim();
  if (!barcode) return;

  const local = db.prepare('SELECT id FROM products WHERE barcode = ?').get(barcode) as { id: number } | undefined;
  if (local) {
    const pending = db.prepare(
      `SELECT 1 FROM sync_queue WHERE table_name = 'inventory' AND record_id = ? AND synced = 0 AND dead_letter = 0 LIMIT 1`
    ).get(String(local.id));
    if (pending) return;
  }

  const name = String(row.name ?? '').trim();
  if (!name) return; 
  const updatedAt = String(row.updated_at ?? new Date().toISOString());

  if (local) {
    db.prepare(
      `UPDATE products SET name = ?, category = ?, vendor = ?, price = ?, cost = ?,
         low_stock_threshold = ?, age_restricted = ?, updated_at = ? WHERE id = ?`
    ).run(
      name,
      (row.category as string) ?? null,
      (row.vendor as string) ?? null,
      Number(row.price) || 0,
      Number(row.cost) || 0,
      Number(row.reorder_point) || 5,
      row.age_restricted ? 1 : 0,
      updatedAt,
      local.id
    );
  } else {
    db.prepare(
      `INSERT INTO products (barcode, name, category, vendor, price, cost, stock_qty, low_stock_threshold, age_restricted, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      barcode,
      name,
      (row.category as string) ?? null,
      (row.vendor as string) ?? null,
      Number(row.price) || 0,
      Number(row.cost) || 0,
      Number(row.quantity) || 0,
      Number(row.reorder_point) || 5,
      row.age_restricted ? 1 : 0,
      updatedAt,
      updatedAt
    );
  }
}


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


export function enqueueZReport(zReportId: number, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const z = db.prepare('SELECT id, generated_at, shift_opened_at FROM z_reports WHERE id = ?').get(zReportId) as
    | { id: number; generated_at: string; shift_opened_at: string | null }
    | undefined;
  if (!z) return false;
  const payload = {
    id: z.id,
    tenant_id: getTenantId(db),
    location_id: getLocationId(db),
    register_id: getRegisterId(db),
    generated_at: z.generated_at,
    shift_opened_at: z.shift_opened_at,
  };
  return enqueueSync('z_reports', z.id, 'insert', payload, db);
}


async function pushRecord(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  row: SyncQueueRow
): Promise<void> {
  const verdict = isSyncAllowed(row.table_name, row.operation);
  if (!verdict.allowed) throw new Error(verdict.reason);
  const cloudTable = verdict.cloudTable as string;
  const tenantId = getTenantId();
  
  const payload: Record<string, unknown> = {
    ...(JSON.parse(row.payload) as Record<string, unknown>),
    tenant_id: tenantId,
  };
  
  
  if (verdict.scoped) {
    payload.location_id = getLocationId();
    payload.register_id = getRegisterId();
  }

  if (row.operation === 'insert') {
    
    
    const { error } = await supabase
      .from(cloudTable)
      .upsert(payload, { onConflict: verdict.conflictTarget as string, ignoreDuplicates: true });
    if (error) throw new Error(error.message);
    return;
  }

  if (row.operation === 'update') {
    
    const localUpdated = (payload.updated_at as string) ?? null;
    
    
    let sel = supabase.from(cloudTable).select('updated_at');
    for (const col of (verdict.conflictTarget as string).split(',')) {
      sel = sel.eq(col.trim(), payload[col.trim()] as string);
    }
    const { data: remote, error: rErr } = await sel.maybeSingle();
    if (rErr) throw new Error(rErr.message);
    const remoteUpdated = (remote?.updated_at as string) ?? null;
    if (localUpdated && remoteUpdated && new Date(remoteUpdated).getTime() > new Date(localUpdated).getTime()) {
      recordConflict(row, localUpdated, remoteUpdated);
      
      
      
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
        
      }
      return; 
    }
    const { error } = await supabase.from(cloudTable).upsert(payload, { onConflict: verdict.conflictTarget as string });
    if (error) throw new Error(error.message);
    return;
  }

  if (row.operation === 'delete') {
    
    
    
    
    
    
    
    let del = supabase.from(cloudTable).delete();
    for (const col of (verdict.conflictTarget as string).split(',')) {
      del = del.eq(col.trim(), payload[col.trim()] as string);
    }
    const { error } = await del;
    if (error) throw new Error(error.message);
    return;
  }

  throw new Error(`unsupported operation '${row.operation}'`);
}



export interface PullSpec {
  cloudTable: string;
  apply: (row: Record<string, unknown>, db: Database.Database) => void;
  
  
  scope?: 'location' | 'tenant';
}
const PULL_SPECS: Record<string, PullSpec> = {};


export function registerPullSpec(key: string, spec: PullSpec): void {
  PULL_SPECS[key] = spec;
}


registerPullSpec('stock_movements', { cloudTable: 'stock_movements_cloud', apply: applyStockMovement });

registerPullSpec('customers', { cloudTable: 'customers_cloud', apply: applyCustomer });

registerPullSpec('products', { cloudTable: 'inventory_cloud', apply: applyProduct });


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


function applyLayoutConfig(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const role = String(row.role ?? ''); if (!role) return;
  const slots = row.report_slots == null ? null : JSON.stringify(row.report_slots);
  const order = row.tile_order == null ? null : JSON.stringify(row.tile_order);
  db.prepare(
    `INSERT INTO pos_layout_config (role, report_slots, tile_order, updated_at)
     VALUES (@role, @slots, @order, @upd)
     ON CONFLICT(role) DO UPDATE SET report_slots=excluded.report_slots, tile_order=excluded.tile_order, updated_at=excluded.updated_at`
  ).run({ role, slots, order, upd: String(row.updated_at ?? new Date().toISOString()) });
}
registerPullSpec('pos_layout_config', { cloudTable: 'pos_layout_config_cloud', scope: 'tenant', apply: applyLayoutConfig });


function applyCategory(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const uid = String(row.uid ?? ''); if (!uid) return;
  const name = String(row.name ?? '').trim(); if (!name) return;
  const active = row.is_active === false ? 0 : 1;
  const upd = String(row.updated_at ?? new Date().toISOString());

  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const existingByUid = db.prepare('SELECT id FROM categories WHERE uid = ?').get(uid) as { id: number } | undefined;
  if (!existingByUid) {
    const existingByName = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE').get(name) as { id: number } | undefined;
    if (existingByName) {
      db.prepare('UPDATE categories SET uid = ?, name = ?, is_active = ?, updated_at = ? WHERE id = ?')
        .run(uid, name, active, upd, existingByName.id);
      return;
    }
  }
  db.prepare(
    `INSERT INTO categories (uid, name, is_active, updated_at)
     VALUES (@uid, @name, @active, @upd)
     ON CONFLICT(uid) DO UPDATE SET name = excluded.name, is_active = excluded.is_active, updated_at = excluded.updated_at`
  ).run({ uid, name, active, upd });
}
registerPullSpec('categories', { cloudTable: 'categories_cloud', scope: 'tenant', apply: applyCategory });


export function applyEmployee(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const uid = String(row.uid ?? ''); if (!uid) return;
  const role = row.role === 'admin' ? 'admin' : row.role === 'manager' ? 'manager' : 'cashier';
  const username = (row.username as string) ?? null; 
  const isCashier = role === 'cashier';
  
  
  
  
  
  
  const mcp = isCashier ? 0 : row.must_change_password ? 1 : 0;
  const mcpin = row.must_change_pin ? 1 : 0;
  const incomingPasswordHash = isCashier ? null : (row.password_hash as string) ?? null;
  const existing = db.prepare('SELECT id FROM users WHERE uid = ?').get(uid) as { id: number } | undefined;
  const params = {
    uid, username, name: (row.name as string) ?? null, role, pw: incomingPasswordHash,
    pin: (row.pin_hash as string) ?? null, active: row.is_active ? 1 : 0, mcp, mcpin,
    loc: (row.location_id as string) ?? null, isCashier: isCashier ? 1 : 0,
  };
  if (existing) {
    
    
    
    
    
    db.prepare(
      `UPDATE users SET username=@username, name=@name, role=@role,
         password_hash=CASE WHEN @isCashier=1 THEN NULL ELSE COALESCE(@pw, password_hash) END,
         pin_hash=COALESCE(@pin, pin_hash), is_active=@active, must_change_password=@mcp,
         must_change_pin=@mcpin, location_id=@loc WHERE uid=@uid`
    ).run(params);
  } else {
    
    if (username) {
      const clash = db.prepare('SELECT 1 FROM users WHERE username = ? AND (uid IS NULL OR uid <> ?)').get(username, uid);
      if (clash) return;
    }
    db.prepare(
      `INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active, must_change_password, must_change_pin, location_id)
       VALUES (@uid, @username, @name, @role, @pw, @pin, @active, @mcp, @mcpin, @loc)`
    ).run(params);
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

registerPullSpec('employees', { cloudTable: 'employees_cloud', scope: 'tenant', apply: applyEmployee });
registerPullSpec('employee_permissions', { cloudTable: 'employee_permissions_cloud', scope: 'tenant', apply: applyEmployeePermission });

export function applyTimeClock(row: Record<string, unknown>, db: Database.Database = getDb()): void {
  const uid = String(row.uid ?? ''); if (!uid) return;
  
  
  
  
  
  
  
  
  
  if (row.deleted) { db.prepare('DELETE FROM time_clock WHERE uid = ?').run(uid); return; }
  
  
  
  
  db.prepare(
    `INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out, register_id, updated_at)
     VALUES (@uid, @emp, @name, @in, @out, @reg, @upd)
     ON CONFLICT(uid) DO UPDATE SET clock_in=excluded.clock_in, clock_out=excluded.clock_out, employee_name=excluded.employee_name, updated_at=excluded.updated_at`
  ).run({
    uid, emp: String(row.employee_uid ?? ''), name: (row.employee_name as string) ?? null,
    in: String(row.clock_in ?? ''), out: (row.clock_out as string) ?? null,
    reg: (row.register_id as string) ?? null, upd: String(row.updated_at ?? new Date().toISOString()),
  });
}
registerPullSpec('time_clock', { cloudTable: 'time_clock_cloud', apply: applyTimeClock });


export function enqueueTimeClock(operation: SyncOp, uid: string, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const r = db.prepare('SELECT * FROM time_clock WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (!r) return false;
  return enqueueSync('time_clock', String(uid), operation, {
    uid: r.uid, employee_uid: r.employee_uid, employee_name: r.employee_name ?? null,
    clock_in: r.clock_in, clock_out: r.clock_out ?? null,
  }, db);
}


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

export function enqueueEmployeePermission(operation: SyncOp, uid: string, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const p = db.prepare('SELECT * FROM employee_permissions WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (!p) return false;
  return enqueueSync('employee_permissions', String(uid), operation, {
    tenant_id: getTenantId(db), uid: p.uid, employee_uid: p.employee_uid, permission_key: p.permission_key,
    is_granted: !!p.is_granted, value: p.value ?? null, updated_at: p.updated_at,
  }, db);
}

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



export function enqueueRebateRule(operation: SyncOp, uid: string, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const r = db.prepare('SELECT * FROM rebate_rules WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (!r) return false;
  const payload = {
    tenant_id: getTenantId(db),
    uid: r.uid, manufacturer_uid: r.manufacturer_uid ?? null, name: r.name, rule_type: r.rule_type,
    qualifying_skus: JSON.parse(String(r.qualifying_skus || '[]')), 
    qualifying_quantity: r.qualifying_quantity, discount_amount: r.discount_amount, discount_type: r.discount_type,
    is_manufacturer_funded: !!r.is_manufacturer_funded, active_start_date: r.active_start_date ?? null,
    active_end_date: r.active_end_date ?? null, is_active: !!r.is_active, register_id: getRegisterId(db),
    updated_at: r.updated_at,
  };
  return enqueueSync('rebate_rules', String(uid), operation, payload, db);
}

export function enqueueCategory(operation: SyncOp, uid: string, db: Database.Database = getDb()): boolean {
  if (!isSupabaseConfigured()) return false;
  const c = db.prepare('SELECT * FROM categories WHERE uid = ?').get(uid) as Record<string, unknown> | undefined;
  if (!c) return false;
  const payload = {
    tenant_id: getTenantId(db),
    uid: c.uid, name: c.name, is_active: !!c.is_active, register_id: getRegisterId(db),
    updated_at: c.updated_at,
  };
  return enqueueSync('categories', String(uid), operation, payload, db);
}

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


async function pullCycle(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  db: Database.Database
): Promise<string | null> {
  let tenantId: string;
  try { tenantId = getTenantId(db); } catch { return null; } 
  const locationId = getLocationId(db);
  const selfRegister = getRegisterId(db);
  
  
  
  
  
  
  
  
  
  
  const errors: string[] = [];

  await Promise.all(Object.entries(PULL_SPECS).map(async ([key, spec]) => {
    const scope = spec.scope ?? 'location';
    if (scope === 'location' && !locationId) return; 
    try {
      const cursor = getCursor(key, db);
      let q = supabase.from(spec.cloudTable).select('*');
      q = scope === 'tenant' ? q.eq('tenant_id', tenantId) : q.eq('location_id', locationId as string);
      
      
      
      
      
      
      
      if (cursor) {
        q =
          cursor.cloudId != null
            ? q.or(`updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},cloud_id.gt.${cursor.cloudId})`)
            : q.gte('updated_at', cursor.updatedAt); 
      }
      q = q.order('updated_at', { ascending: true }).order('cloud_id', { ascending: true }).limit(BATCH_SIZE);
      const { data, error } = await q;
      if (error) throw new Error(error.message);

      
      
      let newCursor = cursor;
      const applyAll = db.transaction((rows: Record<string, unknown>[]) => {
        for (const row of rows) {
          
          
          const skipOwn = scope === 'location' && row.register_id === selfRegister;
          if (!skipOwn) spec.apply(row, db);
        }
        if (rows.length) {
          const last = rows[rows.length - 1];
          const cloudId = last.cloud_id != null ? Number(last.cloud_id) : null;
          newCursor = { updatedAt: String(last.updated_at ?? ''), cloudId };
        }
      });
      applyAll((data ?? []) as Record<string, unknown>[]);

      if (newCursor && newCursor !== cursor) setCursor(key, newCursor, db);
    } catch (err) {
      const msg = `pull ${key}: ${String(err)}`;
      console.warn(`[sync] ${msg}`);
      errors.push(msg);
    }
  }));
  return errors.length ? errors[errors.length - 1] : null;
}

const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; 

const KEY_LAST_RECONCILE = 'last_txn_reconcile_at_v2';


function hasPendingDelete(db: Database.Database, table: string, id: number): boolean {
  return !!db.prepare(
    `SELECT 1 FROM sync_queue WHERE table_name = ? AND record_id = ? AND operation = 'delete' AND synced = 0 AND abandoned = 0 LIMIT 1`
  ).get(table, String(id));
}


export function restoreCloudRowIfMissing(db: Database.Database, table: string, cloudRow: Record<string, unknown>): boolean {
  const id = cloudRow.id as number;
  if (hasPendingDelete(db, table, id)) return false;
  const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
    .map((c) => c.name)
    .filter((c) => c in cloudRow);
  const info = db.prepare(
    `INSERT OR IGNORE INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
  ).run(...cols.map((c) => cloudRow[c]));
  return info.changes > 0;
}


async function reconcileOwnTransactions(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  db: Database.Database
): Promise<string | null> {
  let tenantId: string;
  try { tenantId = getTenantId(db); } catch { return null; }
  const locationId = getLocationId(db);
  if (!locationId) return null;

  const lastRun = readSetting(KEY_LAST_RECONCILE, db);
  if (lastRun && Date.now() - new Date(lastRun).getTime() < RECONCILE_INTERVAL_MS) return null;

  try {
    let restored = 0;
    let cursor = 0;
    for (;;) {
      const { data, error } = await supabase
        .from('transactions_cloud')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('location_id', locationId)
        .gt('id', cursor)
        .order('id', { ascending: true })
        .limit(BATCH_SIZE);
      if (error) throw new Error(error.message);
      if (!data || !data.length) break;

      const ids = data.map((r) => r.id as number);
      const placeholders = ids.map(() => '?').join(',');
      const existing = new Set(
        (db.prepare(`SELECT id FROM transactions WHERE id IN (${placeholders})`).all(...ids) as { id: number }[]).map((r) => r.id)
      );
      const missing = data.filter((r) => !existing.has(r.id as number));

      const insertAll = db.transaction((rows: Record<string, unknown>[]) => {
        for (const row of rows) if (restoreCloudRowIfMissing(db, 'transactions', row)) restored++;
      });
      if (missing.length) insertAll(missing);

      
      
      
      
      
      
      
      
      
      
      const nowLocalIds = new Set(
        (db.prepare(`SELECT id FROM transactions WHERE id IN (${placeholders})`).all(...ids) as { id: number }[]).map((r) => r.id)
      );
      for (const txn of missing) {
        if (!nowLocalIds.has(txn.id as number)) continue; 
        const { data: items, error: itemErr } = await supabase
          .from('transaction_items_cloud')
          .select('*')
          .eq('tenant_id', tenantId)
          .eq('location_id', locationId)
          .eq('transaction_id', txn.id as number);
        if (itemErr || !items || !items.length) continue;
        const insertItems = db.transaction((rows: Record<string, unknown>[]) => {
          for (const row of rows) restoreCloudRowIfMissing(db, 'transaction_items', row);
        });
        insertItems(items);
      }

      cursor = ids[ids.length - 1];
      if (data.length < BATCH_SIZE) break;
    }

    if (restored > 0) console.log(`[sync] reconcileOwnTransactions: restored ${restored} transaction(s) missing from local storage`);
    
    
    
    
    
    
    
    
    writeSetting('last_reconcile_result', JSON.stringify({ at: new Date().toISOString(), restored, error: null }), db);
    writeSetting(KEY_LAST_RECONCILE, new Date().toISOString(), db);
    return null;
  } catch (err) {
    writeSetting('last_reconcile_result', JSON.stringify({ at: new Date().toISOString(), restored: 0, error: String(err) }), db);
    return `reconcile own transactions: ${String(err)}`;
  }
}


async function pullLocationAddress(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  db: Database.Database
): Promise<void> {
  const locationId = getLocationId(db);
  if (!locationId) return;
  try {
    const { data, error } = await supabase.from('locations').select('address').eq('id', locationId).maybeSingle();
    if (error || !data) return;
    db.prepare('UPDATE receipt_config SET address = ? WHERE id = 1').run(data.address ?? '');
  } catch {
    
  }
}


async function pullMerchantFeeRate(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  db: Database.Database
): Promise<void> {
  const locationId = getLocationId(db);
  if (!locationId) return;
  try {
    const { data, error } = await supabase.from('locations')
      .select('merchant_fee_credit_pct, merchant_fee_debit_pct, merchant_fee_flat_cents').eq('id', locationId).maybeSingle();
    if (error || !data) return; 
    writeSetting('merchant_fee_credit_pct', String(data.merchant_fee_credit_pct ?? 0), db);
    writeSetting('merchant_fee_debit_pct', String(data.merchant_fee_debit_pct ?? 0), db);
    writeSetting('merchant_fee_flat_cents', String(data.merchant_fee_flat_cents ?? 0), db);
  } catch {
    
  }
}



async function pullBatchTime(
  supabase: NonNullable<ReturnType<typeof getSupabase>>,
  db: Database.Database
): Promise<void> {
  const locationId = getLocationId(db);
  if (!locationId) return;
  try {
    
    
    
    let data: { batch_time: string | null; timezone?: string | null } | null = null;
    const combined = await supabase.from('locations').select('batch_time, timezone').eq('id', locationId).maybeSingle();
    if (!combined.error) {
      data = combined.data;
    } else {
      const fallback = await supabase.from('locations').select('batch_time').eq('id', locationId).maybeSingle();
      if (fallback.error) return; 
      data = fallback.data;
    }
    writeSetting('batch_time', data?.batch_time ? String(data.batch_time).slice(0, 5) : '', db);
    if (data?.timezone) writeSetting('business_timezone', String(data.timezone), db);
  } catch {
    
  }
}


let cycleRunning = false;

async function runCycle(): Promise<void> {
  if (cycleRunning) return;
  cycleRunning = true;
  try {
    if (!isSupabaseConfigured()) return; 

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

    
    
    const pullError = await pullCycle(supabase, db);
    if (pullError && !lastError) lastError = pullError;
    await pullLocationAddress(supabase, db);
    await pullMerchantFeeRate(supabase, db);
    await pullBatchTime(supabase, db);
    
    
    
    
    const reconcileError = await reconcileOwnTransactions(supabase, db);
    if (reconcileError && !lastError) lastError = reconcileError;

    
    
    
    
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
    
    console.error('[sync] cycle failed (caught, will retry next tick):', err);
    try {
      writeSetting('last_sync_error', String(err));
    } catch {
      
    }
  } finally {
    cycleRunning = false;
  }
}


function safeCycle(): Promise<void> {
  return runCycle().catch((err) => {
    console.error('[sync] unhandled cycle error (swallowed):', err);
  });
}


let interval: NodeJS.Timeout | null = null;


export function startSyncWorker(): void {
  if (interval) return;
  void safeCycle(); 
  interval = setInterval(() => void safeCycle(), SYNC_INTERVAL_MS);
  console.log('[sync] worker started (every 60s; immediate, on-reconnect, and manual triggers).');
}


export function triggerSyncNow(): Promise<void> {
  return safeCycle();
}

export function stopSyncWorker(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
