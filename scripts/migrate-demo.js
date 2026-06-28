/*
 * Migration demo — runs the real schema + migration runner against a throwaway
 * database so we can see exactly what the first migration creates, without
 * touching the live seivapes.db. Run under Electron so the better-sqlite3
 * native binding matches the ABI it was built for:
 *
 *   npx electron scripts/migrate-demo.js
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { initSchema } = require('../dist/main/db/schema');
const { runMigrations } = require('../dist/main/db/migrations');

const dbPath = path.join(os.tmpdir(), 'rackd-migrate-demo.db');
for (const f of [dbPath, dbPath + '-shm', dbPath + '-wal']) {
  try { fs.unlinkSync(f); } catch { /* not there */ }
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

console.log('--- running initSchema + migrations on a fresh DB ---');
initSchema(db);
runMigrations(db);

console.log('\n--- schema_migrations (what has run) ---');
console.table(db.prepare('SELECT id, name, applied_at FROM schema_migrations ORDER BY id').all());

const NEW_TABLES = ['employees', 'cash_drawer_sessions', 'sync_queue'];
const invGone = !db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='inventory'").get();
console.log(`\n--- inventory table dropped by migration 002? ${invGone ? 'YES' : 'NO'} ---`);
console.log('\n--- new local tables created by 001_local_tables ---');
for (const t of NEW_TABLES) {
  const cols = db.prepare(`PRAGMA table_info(${t})`).all();
  console.log(`\n${t}:`);
  console.table(cols.map((c) => ({ column: c.name, type: c.type, notnull: c.notnull, default: c.dflt_value, pk: c.pk })));
}

const allTables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r) => r.name);
console.log('\n--- all tables now present (existing reused + new) ---');
console.log(allTables.join(', '));

db.close();
console.log('\nDemo DB at:', dbPath);
process.exit(0);
