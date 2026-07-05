/*
 * Rackd test harness — pure logic + DB-backed behavior.
 * Run: npm test   (builds, then runs under Electron)
 */
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { computeStatusFrom, computeStatus } = require('../dist/main/supabase/licenseCheck');
const {
  isSyncAllowed, failureUpdate, enqueueSync, recordFailure,
  getDeadLetters, retryDeadLetter, clearDeadLetter, getSyncStatus, getTenantId,
} = require('../dist/main/supabase/sync');
const { cacheToken, getValidToken } = require('../dist/main/supabase/tokenManager');
const { initSchema } = require('../dist/main/db/schema');
const { runMigrations } = require('../dist/main/db/migrations');

let passed = 0, failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '  — ' + e.message); }
}

async function main() {
  const now = new Date('2026-07-02T12:00:00Z');
  const hoursAgo = (h) => new Date(now.getTime() - h * 3.6e6);
  const active = { active: true, tier: 'pro', features: [], expires_at: null, tenant_id: 't', license_key: 'k' };

  console.log('license state machine:');
  await check('unconfigured -> full/unenforced', () => {
    const s = computeStatusFrom(active, hoursAgo(1), false, now);
    assert.equal(s.mode, 'full'); assert.equal(s.reason, 'unenforced');
  });
  await check('active 1h -> full/ok', () => assert.equal(computeStatusFrom(active, hoursAgo(1), true, now).reason, 'ok'));
  await check('active 50h -> grace_warning', () => {
    const s = computeStatusFrom(active, hoursAgo(50), true, now);
    assert.equal(s.reason, 'grace_warning'); assert.equal(s.readOnly, false);
  });
  await check('active 80h -> read_only/cache_expired', () => {
    const s = computeStatusFrom(active, hoursAgo(80), true, now);
    assert.equal(s.readOnly, true); assert.equal(s.reason, 'cache_expired');
  });
  await check('inactive -> read_only/invalid', () => assert.equal(computeStatusFrom({ ...active, active: false }, hoursAgo(1), true, now).reason, 'invalid'));
  await check('expired -> read_only/expired', () => assert.equal(computeStatusFrom({ ...active, expires_at: '2020-01-01T00:00:00Z' }, hoursAgo(1), true, now).reason, 'expired'));
  await check('configured, never cached -> full/unlicensed', () => {
    const s = computeStatusFrom(null, null, true, now);
    assert.equal(s.mode, 'full'); assert.equal(s.reason, 'unlicensed');
  });

  console.log('sync policy:');
  await check('transactions insert allowed', () => assert.equal(isSyncAllowed('transactions', 'insert').allowed, true));
  await check('transactions update blocked', () => assert.equal(isSyncAllowed('transactions', 'update').allowed, false));
  await check('customers update allowed', () => assert.equal(isSyncAllowed('customers', 'update').allowed, true));
  await check('inventory insert blocked', () => assert.equal(isSyncAllowed('inventory', 'insert').allowed, false));
  await check('settings never synced', () => assert.equal(isSyncAllowed('settings', 'update').allowed, false));

  console.log('dead-letter threshold (pure):');
  await check('failureUpdate(0) -> 1, not dead', () => { const r = failureUpdate(0); assert.equal(r.attempts, 1); assert.equal(r.dead_letter, false); });
  await check('failureUpdate(4) -> 5, dead', () => { const r = failureUpdate(4); assert.equal(r.attempts, 5); assert.equal(r.dead_letter, true); });

  // ── DB-backed ──────────────────────────────────────────────────────────
  const dbPath = path.join(os.tmpdir(), 'rackd-unit-' + Date.now() + '.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); db.pragma('foreign_keys = ON');
  initSchema(db); runMigrations(db);
  db.prepare("INSERT INTO settings (key,value) VALUES ('license_cache', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ active: true, tier: 'pro', features: [], expires_at: null, tenant_id: '11111111-1111-1111-1111-111111111111', license_key: 'K' }));

  console.log('sync queue (db-backed):');
  await check('getTenantId reads cached license', () => assert.equal(getTenantId(db), '11111111-1111-1111-1111-111111111111'));
  await check('enqueueSync stores an allowed row', () => {
    assert.equal(enqueueSync('transactions', 1, 'insert', { id: 1, total: 5 }, db), true);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sync_queue WHERE table_name='transactions'").get().n, 1);
  });
  await check('enqueueSync rejects a disallowed op', () => assert.equal(enqueueSync('transactions', 2, 'update', { id: 2 }, db), false));
  await check('recordFailure dead-letters at attempt 5', () => {
    for (let i = 0; i < 5; i++) { const a = db.prepare('SELECT attempts FROM sync_queue WHERE id=1').get().attempts; recordFailure(1, a, 'err', db); }
    assert.equal(db.prepare('SELECT dead_letter FROM sync_queue WHERE id=1').get().dead_letter, 1);
  });
  await check('getDeadLetters returns the row', () => assert.equal(getDeadLetters(db).length, 1));
  await check('retryDeadLetter resets attempts + dead_letter', () => {
    retryDeadLetter(1, db);
    const r = db.prepare('SELECT dead_letter, attempts FROM sync_queue WHERE id=1').get();
    assert.equal(r.dead_letter, 0); assert.equal(r.attempts, 0);
  });
  await check('clearDeadLetter marks abandoned + drops from count', () => {
    for (let i = 0; i < 5; i++) { const a = db.prepare('SELECT attempts FROM sync_queue WHERE id=1').get().attempts; recordFailure(1, a, 'err', db); }
    clearDeadLetter(1, db);
    assert.equal(db.prepare('SELECT abandoned FROM sync_queue WHERE id=1').get().abandoned, 1);
    assert.equal(getSyncStatus(db).dead_letter_count, 0);
  });

  console.log('token manager (db-backed):');
  await check('getValidToken returns a fresh cached token without fetching', async () => {
    cacheToken('tok.fresh', new Date(Date.now() + 10 * 3.6e6).toISOString(), db);
    assert.equal(await getValidToken(db), 'tok.fresh');
  });

  console.log('license (db-backed):');
  await check('computeStatus -> ok when recently checked', () => {
    db.prepare("INSERT INTO settings (key,value) VALUES ('license_last_check', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(new Date().toISOString());
    const s = computeStatus(new Date(), db);
    assert.equal(s.readOnly, false); assert.equal(s.reason, 'ok');
  });

  db.close();
  for (const f of [dbPath, dbPath + '-shm', dbPath + '-wal']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
