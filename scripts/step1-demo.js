
const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { initSchema } = require('../dist/main/db/schema');
const { runMigrations } = require('../dist/main/db/migrations');
const { enqueueLocalRow } = require('../dist/main/supabase/sync');

const dbPath = path.join(os.tmpdir(), 'rackd-step1-demo.db');
for (const f of [dbPath, dbPath + '-shm', dbPath + '-wal']) { try { fs.unlinkSync(f); } catch {} }
const db = new Database(dbPath);
db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
initSchema(db); runMigrations(db);


db.prepare("INSERT INTO settings (key,value) VALUES ('license_cache', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
  .run(JSON.stringify({ active: true, tier: 'pro', features: [], expires_at: null, tenant_id: 'aaaaaaaa-1111-2222-3333-444444444444', license_key: 'K' }));

function seedCustomer() {
  return db.prepare(`INSERT INTO customers (first_name, last_name, phone, opt_in_sms) VALUES ('Jane','Doe','555',1)`).run().lastInsertRowid;
}

console.log('=== A) Supabase NOT configured -> producer is a no-op (pure local) ===');
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_ANON_KEY;
delete process.env.VITE_SUPABASE_URL; delete process.env.VITE_SUPABASE_ANON_KEY;
const id1 = seedCustomer();
console.log('enqueueLocalRow returned:', enqueueLocalRow('customers', 'insert', id1, db));
console.log('sync_queue rows:', db.prepare('SELECT COUNT(*) n FROM sync_queue').get().n, '(expected 0)');

console.log('\n=== B) Supabase configured -> enqueues with tenant_id injected ===');
process.env.SUPABASE_URL = 'https://demo.supabase.co';
process.env.SUPABASE_ANON_KEY = 'demo-anon-key';
const id2 = seedCustomer();
console.log('enqueueLocalRow returned:', enqueueLocalRow('customers', 'insert', id2, db));
const q = db.prepare('SELECT table_name, record_id, operation, payload FROM sync_queue ORDER BY id').all();
console.log('sync_queue:');
for (const r of q) {
  const p = JSON.parse(r.payload);
  console.log(`  ${r.table_name}#${r.record_id} ${r.operation}  tenant_id=${p.tenant_id}  first_name=${p.first_name}`);
}

console.log('\n=== C) Atomicity: a failed write inside the txn rolls back BOTH ===');
const before = db.prepare('SELECT COUNT(*) n FROM sync_queue').get().n;
try {
  db.transaction(() => {
    const r = db.prepare(`INSERT INTO customers (first_name,last_name) VALUES ('Will','Fail')`).run();
    enqueueLocalRow('customers', 'insert', r.lastInsertRowid, db);
    throw new Error('boom — simulated downstream failure');
  })();
} catch (e) { console.log('txn threw:', e.message); }
const afterQ = db.prepare('SELECT COUNT(*) n FROM sync_queue').get().n;
const failCust = db.prepare("SELECT COUNT(*) n FROM customers WHERE first_name='Will'").get().n;
console.log(`sync_queue rows ${before} -> ${afterQ} (unchanged), 'Will' customers: ${failCust} (rolled back)`);

db.close();
process.exit(0);
