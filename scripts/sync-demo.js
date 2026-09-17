
const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { initSchema } = require('../dist/main/db/schema');
const { runMigrations } = require('../dist/main/db/migrations');
const {
  isSyncAllowed,
  enqueueSync,
  recordFailure,
  getSyncStatus,
} = require('../dist/main/supabase/sync');

const dbPath = path.join(os.tmpdir(), 'rackd-sync-demo.db');
for (const f of [dbPath, dbPath + '-shm', dbPath + '-wal']) {
  try { fs.unlinkSync(f); } catch {  }
}
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
initSchema(db);
runMigrations(db);

console.log('=== 1) sync policy matrix (what gets synced) ===');
const checks = [
  ['transactions', 'insert'], ['transactions', 'update'],
  ['transaction_items', 'insert'],
  ['customers', 'insert'], ['customers', 'update'],
  ['inventory', 'update'], ['inventory', 'insert'],
  ['cash_drawer_sessions', 'insert'],
  ['scan_data_queue', 'insert'],
  ['settings', 'update'], ['sync_queue', 'insert'], ['employees', 'update'],
];
console.table(checks.map(([t, op]) => {
  const v = isSyncAllowed(t, op);
  return { table: t, operation: op, allowed: v.allowed, cloudTable: v.cloudTable || '—', reason: v.reason || '' };
}));

console.log('\n=== 2) enqueue filtering + sensitive-field stripping ===');
console.log('transactions insert  ->', enqueueSync('transactions', 101, 'insert', { id: 101, total: 42.5 }, db));
console.log('inventory update     ->', enqueueSync('inventory', 5, 'update', { id: 5, quantity: 12, updated_at: '2026-06-28T10:00:00Z' }, db));
console.log('customers update+pin ->', enqueueSync('customers', 9, 'update', { id: 9, first_name: 'Sam', pin: '1234', updated_at: '2026-06-28T11:00:00Z' }, db));
console.log('transactions update  ->', enqueueSync('transactions', 102, 'update', { id: 102 }, db), '(rejected by policy)');
console.log('settings insert      ->', enqueueSync('settings', 'x', 'insert', { id: 'x' }, db), '(never synced)');
console.table(db.prepare('SELECT id, table_name, record_id, operation, payload, synced, attempts, dead_letter FROM sync_queue ORDER BY id').all());

console.log('\n=== 3) dead-letter after 5 failed attempts (row #1) ===');
const steps = [];
for (let i = 0; i < 5; i++) {
  const r = db.prepare('SELECT attempts FROM sync_queue WHERE id = 1').get();
  const res = recordFailure(1, r.attempts, 'network error: ECONNRESET', db);
  steps.push({ attempt: res.attempts, dead_letter: res.dead_letter });
}
console.table(steps);
console.table(db.prepare('SELECT id, attempts, synced, dead_letter, error_message FROM sync_queue WHERE id = 1').all());

console.log('\n=== 4) sync status (exposed via IPC to manager PWA) ===');
console.log(getSyncStatus(db));

db.close();
process.exit(0);
