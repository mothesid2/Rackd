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
  getDeadLetters, retryDeadLetter, clearDeadLetter, getSyncStatus, getTenantId, enqueueCustomer,
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

  console.log('migrations (FK-safe rebuild):');
  await check('013 rebuilds users with foreign_keys ON + referencing rows', () => {
    const p = path.join(os.tmpdir(), `rackd-fk-${Date.now()}.db`);
    const fk = new Database(p);
    fk.pragma('foreign_keys = ON');
    initSchema(fk); // creates old-form users + FK tables (transactions.cashier_id -> users.id)
    // Simulate an existing install: a user + a transaction that references it.
    const uid = fk.prepare("INSERT INTO users (username, password_hash, role) VALUES ('mgr','h','manager')").run().lastInsertRowid;
    fk.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status) VALUES (?, 1, 0, 0, 0, 1, 'cash', 'completed')").run(uid);
    runMigrations(fk); // must NOT throw despite the FK reference + DROP TABLE users
    const u = fk.prepare('SELECT role, must_change_pin FROM users WHERE id = ?').get(uid);
    assert.equal(u.role, 'manager');
    assert.equal(u.must_change_pin, 0);
    // The rebuild preserved the id, so the transaction's FK still resolves.
    const t = fk.prepare('SELECT cashier_id FROM transactions WHERE cashier_id = ?').get(uid);
    assert.ok(t);
    assert.equal(fk.pragma('foreign_keys', { simple: true }), 1); // restored ON
    fk.close();
    for (const f of [p, p + '-shm', p + '-wal']) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  });

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
  await check('stock_movements insert allowed', () => assert.equal(isSyncAllowed('stock_movements', 'insert').allowed, true));
  await check('stock_movements keyed by movement_uid', () => assert.equal(isSyncAllowed('stock_movements', 'insert').conflictTarget, 'movement_uid'));
  await check('scoped table defaults conflict target', () => assert.equal(isSyncAllowed('transactions', 'insert').conflictTarget, 'tenant_id,id'));
  await check('scan_data_queue not location-scoped', () => assert.equal(isSyncAllowed('scan_data_queue', 'insert').scoped, false));
  await check('applied_rebates insert allowed, keyed by uid', () => { const v = isSyncAllowed('applied_rebates', 'insert'); assert.equal(v.allowed, true); assert.equal(v.conflictTarget, 'uid'); });
  await check('rebate_rules insert + update allowed', () => { assert.equal(isSyncAllowed('rebate_rules', 'insert').allowed, true); assert.equal(isSyncAllowed('rebate_rules', 'update').allowed, true); });
  await check('rebate_rules keyed by tenant_id,uid', () => assert.equal(isSyncAllowed('rebate_rules', 'insert').conflictTarget, 'tenant_id,uid'));
  await check('employees insert+update allowed', () => { assert.equal(isSyncAllowed('employees', 'insert').allowed, true); assert.equal(isSyncAllowed('employees', 'update').allowed, true); });
  await check('override log is insert-only (append-only)', () => { assert.equal(isSyncAllowed('permission_override_log', 'insert').allowed, true); assert.equal(isSyncAllowed('permission_override_log', 'update').allowed, false); });
  await check('users table never syncs', () => assert.equal(isSyncAllowed('users', 'insert').allowed, false));

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

  console.log('shared customers (db-backed):');
  await check('enqueueCustomer assigns a uid to a customer without one', () => {
    const r = db.prepare("INSERT INTO customers (first_name, last_name) VALUES ('Ada','L')").run();
    const id = r.lastInsertRowid;
    assert.equal(db.prepare('SELECT uid FROM customers WHERE id=?').get(id).uid, null);
    enqueueCustomer('insert', id, db);
    const uid = db.prepare('SELECT uid FROM customers WHERE id=?').get(id).uid;
    assert.ok(uid && uid.length >= 32, 'uid should be a generated uuid');
  });
  await check('enqueueCustomer keeps an existing uid stable', () => {
    const id = db.prepare("SELECT id FROM customers WHERE first_name='Ada'").get().id;
    const before = db.prepare('SELECT uid FROM customers WHERE id=?').get(id).uid;
    enqueueCustomer('update', id, db);
    assert.equal(db.prepare('SELECT uid FROM customers WHERE id=?').get(id).uid, before);
  });

  console.log('permissions (db-backed):');
  const bcryptP = require('bcryptjs');
  const { userHasPermission, verifyPin } = require('../dist/main/permissions');
  const mgrId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('mgr-1','mgrx','Mgr','manager','',?,1)").run(bcryptP.hashSync('4321', 10)).lastInsertRowid;
  const cashId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('cash-1','cashx','Cash','cashier','',?,1)").run(bcryptP.hashSync('1111', 10)).lastInsertRowid;
  await check('manager holds all permissions', () => assert.equal(userHasPermission(db, mgrId, 'process_refund').granted, true));
  await check('cashier lacks permission by default', () => assert.equal(userHasPermission(db, cashId, 'process_refund').granted, false));
  await check('cashier permission grant is honored', () => {
    db.prepare("INSERT INTO employee_permissions (uid, employee_uid, permission_key, is_granted) VALUES ('perm-1','cash-1','process_refund',1)").run();
    assert.equal(userHasPermission(db, cashId, 'process_refund').granted, true);
  });
  await check('verifyPin resolves the employee', () => { const r = verifyPin(db, '1111'); assert.equal(r.ok, true); assert.equal(r.employee.role, 'cashier'); });
  await check('verifyPin rejects a wrong PIN', () => assert.equal(verifyPin(db, '9999').ok, false));

  console.log('session model (db-backed):');
  const ds = require('../dist/main/daySession');
  await check('day starts closed', () => assert.equal(ds.isDayOpen(db), false));
  await check('openDay opens + records the manager', () => {
    ds.openDay(mgrId, 'mgrx', db);
    assert.equal(ds.isDayOpen(db), true);
    assert.equal(ds.dayInfo(db).openedByName, 'mgrx');
  });
  await check('idle: no activity is not locked; fresh touch is not locked', () => {
    ds.clearActivity(); assert.equal(ds.isIdleLocked(), false);
    ds.touchActivity(); assert.equal(ds.isIdleLocked(), false);
  });
  await check('closeDay closes + clears the opener and activity', () => {
    ds.touchActivity();
    ds.closeDay(db);
    assert.equal(ds.isDayOpen(db), false);
    assert.equal(ds.dayInfo(db).openedByName, null);
    assert.equal(ds.isIdleLocked(), false);
  });

  console.log('kiosk reset policy (pure):');
  const { decideReset } = require('../dist/main/kioskCommands');
  await check('defers while the day is open', () => assert.equal(decideReset({ dayOpen: true, hasSession: false, deadLetters: 0, pending: 0 }).action, 'defer'));
  await check('defers while an employee is signed in', () => assert.equal(decideReset({ dayOpen: false, hasSession: true, deadLetters: 0, pending: 0 }).action, 'defer'));
  await check('blocks (does not reset) on dead-letters', () => {
    const d = decideReset({ dayOpen: false, hasSession: false, deadLetters: 2, pending: 0 });
    assert.equal(d.action, 'blocked'); assert.equal(d.status, 'blocked');
  });
  await check('waits while the outbox is still draining', () => assert.equal(decideReset({ dayOpen: false, hasSession: false, deadLetters: 0, pending: 5 }).action, 'draining'));
  await check('resets only when idle, drained, and clean', () => assert.equal(decideReset({ dayOpen: false, hasSession: false, deadLetters: 0, pending: 0 }).action, 'reset'));

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
