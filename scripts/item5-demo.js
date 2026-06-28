/*
 * Item 5 demo — tenant_id injection guard, shared upsert conflict target, and
 * dead-letter retry/clear lifecycle, against a throwaway DB.
 *   npx electron scripts/item5-demo.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { initSchema } = require('../dist/main/db/schema');
const { runMigrations } = require('../dist/main/db/migrations');
const { getTenantId, enqueueSync, recordFailure, getDeadLetters, retryDeadLetter, clearDeadLetter, getSyncStatus } =
  require('../dist/main/supabase/sync');

const dbPath = path.join(os.tmpdir(), 'rackd-item5-demo.db');
for (const f of [dbPath, dbPath + '-shm', dbPath + '-wal']) { try { fs.unlinkSync(f); } catch {} }
const db = new Database(dbPath);
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
initSchema(db); runMigrations(db);

console.log('=== Follow-up #1: getTenantId() reads cached license, throws if missing ===');
try { getTenantId(db); } catch (e) { console.log('no license cached ->', e.message); }
db.prepare("INSERT INTO settings (key, value) VALUES ('license_cache', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  .run(JSON.stringify({ active: true, tier: 'pro', features: ['sms'], expires_at: null, tenant_id: '11111111-1111-1111-1111-111111111111', license_key: 'RACKD-DEMO' }));
console.log('after caching license -> tenant_id =', getTenantId(db));

console.log('\n=== Dead-letter lifecycle (retry + clear) ===');
enqueueSync('transactions', 501, 'insert', { id: 501, total: 9.99 }, db);
for (let i = 0; i < 5; i++) {
  const r = db.prepare('SELECT attempts FROM sync_queue WHERE id = 1').get();
  recordFailure(1, r.attempts, 'timeout', db);
}
console.log('dead-letters needing review:', getDeadLetters(db).map((r) => ({ id: r.id, table: r.table_name, attempts: r.attempts, dead_letter: r.dead_letter })));
console.log('status.dead_letter_count =', getSyncStatus(db).dead_letter_count);

console.log('retryDeadLetter(1) ->', retryDeadLetter(1, db), 'row affected');
console.table(db.prepare('SELECT id, attempts, dead_letter, abandoned, synced FROM sync_queue WHERE id=1').all());

// fail it back to dead-letter, then abandon it
for (let i = 0; i < 5; i++) { const r = db.prepare('SELECT attempts FROM sync_queue WHERE id = 1').get(); recordFailure(1, r.attempts, 'timeout', db); }
console.log('clearDeadLetter(1) ->', clearDeadLetter(1, db), 'row affected (abandoned)');
console.table(db.prepare('SELECT id, attempts, dead_letter, abandoned FROM sync_queue WHERE id=1').all());
console.log('dead-letters after abandon:', getDeadLetters(db).length, '| status.dead_letter_count =', getSyncStatus(db).dead_letter_count);

db.close();
process.exit(0);
