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
  applyEmployee, applyTimeClock, applyProduct,
} = require('../dist/main/supabase/sync');
const { cacheToken, getValidToken } = require('../dist/main/supabase/tokenManager');
const { computeTipPool, saveTipPoolLedger } = require('../dist/main/ipc/xzout');
const { computeRefundTax } = require('../dist/main/ipc/transactions');
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

  console.log('applyEmployee — cashiers are PIN-only (db-backed):');
  await check('pull self-heals a legacy cashier row stuck with a password + forced-change flag', () => {
    // Simulates a row created by the old buggy auth:createUser, before cashiers
    // were made PIN-only — password_hash set, must_change_password permanently 1
    // because nothing ever cleared it for a cashier, forcing a credential-change
    // prompt on every login instead of just the first.
    db.prepare(
      "INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active, must_change_password, must_change_pin) VALUES ('legacy-cash-1', NULL, 'Legacy Cash', 'cashier', 'stuck-hash', 'pin-hash', 1, 1, 1)"
    ).run();
    // Worst case: the stale cloud copy also still says must_change_password true.
    applyEmployee({ uid: 'legacy-cash-1', role: 'cashier', name: 'Legacy Cash', is_active: true, must_change_password: true, must_change_pin: true, pin_hash: 'pin-hash-2' }, db);
    const row = db.prepare('SELECT password_hash, must_change_password FROM users WHERE uid=?').get('legacy-cash-1');
    assert.equal(row.password_hash, null);
    assert.equal(row.must_change_password, 0);
  });
  await check('a freshly-inserted cashier never gets a password even if the payload has one', () => {
    applyEmployee({ uid: 'new-cash-1', role: 'cashier', name: 'New Cash', is_active: true, must_change_password: true, must_change_pin: true, pin_hash: 'ph', password_hash: 'should-be-dropped' }, db);
    const row = db.prepare('SELECT password_hash, must_change_password FROM users WHERE uid=?').get('new-cash-1');
    assert.equal(row.password_hash, null);
    assert.equal(row.must_change_password, 0);
  });
  await check('a manager keeps a real password + must_change_password (not swept up by the cashier fix)', () => {
    applyEmployee({ uid: 'mgr-pull-1', role: 'manager', name: 'Pulled Mgr', username: 'pulledmgr', is_active: true, must_change_password: true, password_hash: 'real-hash' }, db);
    const row = db.prepare('SELECT password_hash, must_change_password FROM users WHERE uid=?').get('mgr-pull-1');
    assert.equal(row.password_hash, 'real-hash');
    assert.equal(row.must_change_password, 1);
  });

  console.log('applyTimeClock — clock_in survives a pull (batch 5, item 8 fix):');
  await check('a corrected clock_in from the cloud actually overwrites the local one', () => {
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('punch-1','emp-1','Worker','2026-07-24T09:00:00Z',NULL)").run();
    applyTimeClock({ uid: 'punch-1', employee_uid: 'emp-1', employee_name: 'Worker', clock_in: '2026-07-24T08:30:00Z', clock_out: null, updated_at: '2026-07-24T10:00:00Z' }, db);
    const row = db.prepare('SELECT clock_in FROM time_clock WHERE uid=?').get('punch-1');
    assert.equal(row.clock_in, '2026-07-24T08:30:00Z');
  });

  console.log('applyTimeClock — Manager Portal shift delete (soft-delete tombstone, batch 6):');
  await check('a deleted=true pull removes the local punch entirely, not just marks it', () => {
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('punch-del-1','emp-2','Worker2','2026-07-24T09:00:00Z','2026-07-24T17:00:00Z')").run();
    applyTimeClock({ uid: 'punch-del-1', employee_uid: 'emp-2', deleted: true, updated_at: '2026-07-24T18:00:00Z' }, db);
    const row = db.prepare('SELECT * FROM time_clock WHERE uid=?').get('punch-del-1');
    assert.equal(row, undefined, 'the row must be gone, not just flagged');
  });
  await check('a deleted=true pull for a punch this kiosk never had is a harmless no-op', () => {
    applyTimeClock({ uid: 'punch-never-existed-here', employee_uid: 'emp-2', deleted: true, updated_at: '2026-07-24T18:00:00Z' }, db);
    const row = db.prepare('SELECT * FROM time_clock WHERE uid=?').get('punch-never-existed-here');
    assert.equal(row, undefined);
  });

  console.log('applyProduct — cloud-to-kiosk catalog pull (new):');
  await check('a peer product this kiosk has never seen creates a new local row, seeded with its quantity', () => {
    applyProduct({
      barcode: 'NEW-BARCODE-1', name: 'Widget', category: 'Gadgets', vendor: 'Acme',
      price: 9.99, cost: 4, quantity: 12, reorder_point: 3, age_restricted: false,
      updated_at: '2026-07-26T00:00:00Z',
    }, db);
    const row = db.prepare('SELECT * FROM products WHERE barcode=?').get('NEW-BARCODE-1');
    assert.ok(row, 'product should have been created');
    assert.equal(row.name, 'Widget');
    assert.equal(row.category, 'Gadgets');
    assert.equal(row.vendor, 'Acme');
    assert.equal(row.price, 9.99);
    assert.equal(row.stock_qty, 12, 'brand-new product has no local count to protect — seed from the snapshot');
    assert.equal(row.age_restricted, 0);
  });
  await check('an age-restricted peer product keeps its 21+ flag on create (compliance-critical)', () => {
    applyProduct({
      barcode: 'NEW-BARCODE-VAPE', name: 'Disposable Vape', category: 'Vape', vendor: 'Geek Bar',
      price: 15, cost: 8, quantity: 5, reorder_point: 2, age_restricted: true,
      updated_at: '2026-07-26T00:00:00Z',
    }, db);
    const row = db.prepare('SELECT age_restricted FROM products WHERE barcode=?').get('NEW-BARCODE-VAPE');
    assert.equal(row.age_restricted, 1);
  });
  await check('a row with no barcode is skipped — no stable key to land it on', () => {
    const before = db.prepare('SELECT COUNT(*) n FROM products').get().n;
    applyProduct({ name: 'No Barcode Item', price: 1, quantity: 1, updated_at: '2026-07-26T00:00:00Z' }, db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n, before);
  });
  await check('editing an EXISTING product on a peer updates catalog fields locally but never touches stock_qty', () => {
    const { lastInsertRowid: id } = db.prepare(
      `INSERT INTO products (barcode, name, category, vendor, price, cost, stock_qty, low_stock_threshold, age_restricted)
       VALUES ('SHARED-BARCODE-1','Old Name','Old Cat','Old Vendor',5,2,42,5,0)`
    ).run();
    applyProduct({
      barcode: 'SHARED-BARCODE-1', name: 'New Name', category: 'New Cat', vendor: 'New Vendor',
      price: 7.5, cost: 3, quantity: 999, reorder_point: 8, age_restricted: true,
      updated_at: '2026-07-26T01:00:00Z',
    }, db);
    const row = db.prepare('SELECT * FROM products WHERE id=?').get(id);
    assert.equal(row.name, 'New Name');
    assert.equal(row.category, 'New Cat');
    assert.equal(row.vendor, 'New Vendor');
    assert.equal(row.price, 7.5);
    assert.equal(row.age_restricted, 1);
    assert.equal(row.stock_qty, 42, 'stock count is owned by the movement-delta pull, not the catalog pull');
  });
  await check('re-applying the same peer row (cursor boundary re-fetch) is idempotent — no duplicate, no error', () => {
    const before = db.prepare('SELECT COUNT(*) n FROM products WHERE barcode=?').get('NEW-BARCODE-1').n;
    applyProduct({
      barcode: 'NEW-BARCODE-1', name: 'Widget', category: 'Gadgets', vendor: 'Acme',
      price: 9.99, cost: 4, quantity: 12, reorder_point: 3, age_restricted: false,
      updated_at: '2026-07-26T00:00:00Z',
    }, db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM products WHERE barcode=?').get('NEW-BARCODE-1').n, before);
  });
  await check('a pending unsynced local edit wins over an inbound peer pull for the same product', () => {
    const { lastInsertRowid: id } = db.prepare(
      `INSERT INTO products (barcode, name, category, vendor, price, cost, stock_qty, low_stock_threshold, age_restricted)
       VALUES ('SHARED-BARCODE-2','Local Edit In Flight','Cat','V',20,10,3,5,0)`
    ).run();
    // Simulate: this kiosk just edited the product and queued the push, but it
    // hasn't sent yet (synced=0) — mirrors enqueueInventorySnapshot's queue row.
    db.prepare(
      "INSERT INTO sync_queue (table_name, record_id, operation, payload) VALUES ('inventory', ?, 'update', '{}')"
    ).run(String(id));
    applyProduct({
      barcode: 'SHARED-BARCODE-2', name: 'Stale Peer Value', category: 'Cat', vendor: 'V',
      price: 1, cost: 1, quantity: 1, reorder_point: 5, age_restricted: false,
      updated_at: '2026-07-26T02:00:00Z',
    }, db);
    const row = db.prepare('SELECT name, price FROM products WHERE id=?').get(id);
    assert.equal(row.name, 'Local Edit In Flight', 'inbound pull must not clobber the not-yet-pushed local edit');
    assert.equal(row.price, 20);
  });

  console.log('computeRefundTax — refund nets exactly against the sale it reverses (pure):');
  await check("user's exact repro: two $2.50+tax sales, fully refunded, net to precisely $0.00", () => {
    const taxRate = 0.0825;
    // Original sale, as actually stored: unrounded, exactly what the renderer's
    // computeTotals() produces and transactions:create writes verbatim.
    const saleSubtotal = 2.50;
    const saleTax = saleSubtotal * taxRate; // 0.20625, unrounded — matches the real insert
    const saleTotal = saleSubtotal + saleTax;

    // A full refund of that same sale.
    const { total: refundTotal } = computeRefundTax(saleSubtotal, saleSubtotal, saleTax, taxRate);
    assert.equal(+(saleTotal + refundTotal).toFixed(10), 0, 'one sale + its full refund must net to exactly zero');

    // The user's actual scenario: TWO such pairs.
    const netCashFlow = (saleTotal + refundTotal) + (saleTotal + refundTotal);
    assert.equal(+netCashFlow.toFixed(10), 0, 'two sales + two full refunds must net to exactly $0.00, not -$0.01');
  });
  await check('a full refund reuses the original tax EXACTLY, not a fresh rounded recompute', () => {
    // computeRefundTax returns the positive magnitude being reversed — the
    // caller negates it when storing tax_amount (see refundItems: `-tax`).
    const origSubtotal = 2.50, origTax = 2.50 * 0.0825; // 0.20625
    const { tax } = computeRefundTax(2.50, origSubtotal, origTax, 0.0825);
    assert.equal(tax, origTax, 'full refund (subtotal === origSubtotal) must reuse the original tax exactly');
  });
  await check('the OLD buggy formula would have failed this — confirms the bug was real, not hypothetical', () => {
    // What the code did before this fix: recompute tax fresh from the refunded
    // subtotal and round it to cents, ignoring what the original sale actually
    // stored. Demonstrating this against the same numbers shows the discrepancy
    // the user actually saw.
    const oldBuggyTax = +(2.50 * 0.0825).toFixed(2); // 0.21 — rounded
    const saleTax = 2.50 * 0.0825; // 0.20625 — unrounded, as actually stored
    assert.notEqual(oldBuggyTax, saleTax, 'the old formula diverges from the original sale — this was the bug');
  });
  await check('a partial refund takes a proportional share of the original tax, not a fresh recompute', () => {
    // A $10 sale (two $5 items) with $0.825 tax; refunding just one $5 item.
    const origSubtotal = 10, origTax = 10 * 0.0825;
    const { tax } = computeRefundTax(5, origSubtotal, origTax, 0.0825);
    assert.equal(tax, origTax * 0.5, 'half the subtotal refunded -> half the original tax, proportionally');
  });
  await check('falls back to a fresh rate-based computation when there is no original subtotal to derive from', () => {
    const { tax } = computeRefundTax(5, 0, 0, 0.0825);
    assert.equal(tax, +(5 * 0.0825).toFixed(2));
  });

  console.log('tip pool (batch 5, legal rebuild, db-backed):');
  // Clean slate — the applyTimeClock test above left an open (no clock_out)
  // punch in time_clock, which would otherwise bleed into today's hours here.
  db.prepare("DELETE FROM transactions").run();
  db.prepare("DELETE FROM time_clock").run();
  db.prepare("UPDATE settings SET value = '3' WHERE key = 'merchant_fee_credit_pct'").run();

  // Known staff — role is what makes the FLSA exclusion testable at all.
  const aliceId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('leg-cash-alice', NULL, 'Alice', 'cashier', NULL, 'x', 1)").run().lastInsertRowid;
  const bobId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('leg-cash-bob', NULL, 'Bob', 'cashier', NULL, 'x', 1)").run().lastInsertRowid;
  const mannyId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('leg-mgr-manny', 'manny', 'Manny', 'manager', 'x', NULL, 1)").run().lastInsertRowid;
  const monaId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('leg-mgr-mona', 'mona', 'Mona', 'manager', 'x', NULL, 1)").run().lastInsertRowid;

  await check("user's own worked example: $97 pool, 12 of 24 hours -> $48.50 (both cashiers)", () => {
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 100, 0, 0, 0, 100, 100, 'card', 'completed', '2026-07-24T18:00:00.000-05:00')").run(aliceId);
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-1','leg-cash-alice','Alice','2026-07-24T08:00:00.000-05:00','2026-07-24T20:00:00.000-05:00')").run();
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-2','leg-cash-bob','Bob','2026-07-24T08:00:00.000-05:00','2026-07-24T20:00:00.000-05:00')").run();
    const tp = computeTipPool(db, '2026-07-24', '2026-07-24');
    assert.equal(tp.pooled, true);
    assert.equal(tp.total_tips, 100);
    assert.equal(tp.merchant_fee_effective_pct, 3);
    assert.equal(tp.deduction_amount, 3);
    assert.equal(tp.pool_amount, 97);
    assert.equal(tp.total_hours, 24);
    assert.equal(tp.by_employee.length, 2);
    for (const e of tp.by_employee) assert.equal(e.share, 48.5);
    const sum = tp.by_employee.reduce((s, e) => s + e.share, 0);
    assert.ok(Math.abs(sum - tp.pool_amount) < 0.001, 'shares must sum to the pool exactly');
  });

  await check('FLSA: a manager who also worked gets ZERO and is excluded from the hours denominator entirely', () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("DELETE FROM time_clock").run();
    // Same $100/3% as above, but Manny (manager) also clocked 12h alongside
    // Alice (cashier). If Manny leaked into the split, Alice would get less
    // than the full pool. She must get the WHOLE $97 — Manny gets nothing and
    // must not even appear in by_employee.
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 100, 0, 0, 0, 100, 100, 'card', 'completed', '2026-07-27T18:00:00.000-05:00')").run(aliceId);
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-3','leg-cash-alice','Alice','2026-07-27T08:00:00.000-05:00','2026-07-27T20:00:00.000-05:00')").run();
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-4','leg-mgr-manny','Manny','2026-07-27T08:00:00.000-05:00','2026-07-27T20:00:00.000-05:00')").run();
    const tp = computeTipPool(db, '2026-07-27', '2026-07-27');
    assert.equal(tp.pooled, true);
    assert.equal(tp.total_hours, 12, 'only Alice (cashier) counts toward hours — Manny (manager) must not');
    assert.equal(tp.by_employee.length, 1);
    assert.equal(tp.by_employee[0].name, 'Alice');
    assert.equal(tp.by_employee[0].share, 97);
    assert.ok(!tp.by_employee.some((e) => e.name === 'Manny'), 'a manager must never appear as a tip-pool recipient');
  });

  await check('29 CFR 531.52 sole-service exception: only a manager worked -> not pooled, no deduction, direct attribution', () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("DELETE FROM time_clock").run();
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 50, 0, 0, 0, 50, 50, 'card', 'completed', '2026-07-28T18:00:00.000-05:00')").run(mannyId);
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-5','leg-mgr-manny','Manny','2026-07-28T08:00:00.000-05:00','2026-07-28T20:00:00.000-05:00')").run();
    const tp = computeTipPool(db, '2026-07-28', '2026-07-28');
    assert.equal(tp.pooled, false);
    assert.ok(typeof tp.skip_reason === 'string' && tp.skip_reason.length > 0, 'skip_reason should explain why pooling was skipped');
    assert.equal(tp.deduction_amount, 0, 'no processing-fee deduction on directly-attributed tips');
    assert.equal(tp.pool_amount, 0);
    assert.equal(tp.by_employee.length, 1);
    assert.equal(tp.by_employee[0].name, 'Manny');
    assert.equal(tp.by_employee[0].share, 50, "Manny keeps his own directly-rung tips in full — sole-service exception");
  });

  await check('multiple managers, no cashiers: each keeps only their own rung tips, never pooled with each other', () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("DELETE FROM time_clock").run();
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 20, 0, 0, 0, 20, 20, 'card', 'completed', '2026-07-29T12:00:00.000-05:00')").run(mannyId);
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 80, 0, 0, 0, 80, 80, 'card', 'completed', '2026-07-29T14:00:00.000-05:00')").run(monaId);
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-6','leg-mgr-manny','Manny','2026-07-29T08:00:00.000-05:00','2026-07-29T16:00:00.000-05:00')").run();
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-7','leg-mgr-mona','Mona','2026-07-29T08:00:00.000-05:00','2026-07-29T16:00:00.000-05:00')").run();
    const tp = computeTipPool(db, '2026-07-29', '2026-07-29');
    assert.equal(tp.pooled, false);
    const manny = tp.by_employee.find((e) => e.name === 'Manny');
    const mona = tp.by_employee.find((e) => e.name === 'Mona');
    assert.equal(manny.share, 20, "Manny keeps only his own $20 — not averaged/split with Mona's $80");
    assert.equal(mona.share, 80, "Mona keeps only her own $80");
  });

  await check('cash tips carry no processing-cost deduction — only the card-tendered portion is fee-based', () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("DELETE FROM time_clock").run();
    // $60 cash tip + $40 card tip = $100 total; only the $40 card portion is
    // subject to the 3% fee ($1.20), not the full $100 (which would be $3).
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 60, 0, 0, 0, 60, 60, 'cash', 'completed', '2026-07-30T12:00:00.000-05:00')").run(aliceId);
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 40, 0, 0, 0, 40, 40, 'card', 'completed', '2026-07-30T14:00:00.000-05:00')").run(aliceId);
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-8','leg-cash-alice','Alice','2026-07-30T08:00:00.000-05:00','2026-07-30T16:00:00.000-05:00')").run();
    const tp = computeTipPool(db, '2026-07-30', '2026-07-30');
    assert.equal(tp.total_tips, 100);
    assert.equal(tp.card_tip_total, 40);
    assert.equal(tp.deduction_amount, 1.2, '3% of the $40 card portion, not 3% of the full $100');
    assert.equal(tp.pool_amount, 98.8);
  });

  await check('merchant fee is read from settings (configurable, not hardcoded) and defaults to 0 until set', () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("DELETE FROM time_clock").run();
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 100, 0, 0, 0, 100, 100, 'card', 'completed', '2026-07-31T12:00:00.000-05:00')").run(aliceId);
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-9','leg-cash-alice','Alice','2026-07-31T08:00:00.000-05:00','2026-07-31T16:00:00.000-05:00')").run();
    db.prepare("UPDATE settings SET value = '0' WHERE key = 'merchant_fee_credit_pct'").run();
    const unset = computeTipPool(db, '2026-07-31', '2026-07-31');
    assert.equal(unset.deduction_amount, 0, 'no deduction until the owner explicitly sets a real rate — never a guessed default');
    db.prepare("UPDATE settings SET value = '2.9' WHERE key = 'merchant_fee_credit_pct'").run();
    const set = computeTipPool(db, '2026-07-31', '2026-07-31');
    assert.equal(set.merchant_fee_effective_pct, 2.9);
    assert.equal(set.deduction_amount, 2.9);
    db.prepare("UPDATE settings SET value = '3' WHERE key = 'merchant_fee_credit_pct'").run();
  });

  await check('audit ledger persists the fee rate and deduction actually used, not just the final shares', () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("DELETE FROM time_clock").run();
    db.prepare("DELETE FROM tip_pool_shares").run();
    db.prepare("DELETE FROM tip_pool_ledger").run();
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 100, 0, 0, 0, 100, 100, 'card', 'completed', '2026-08-01T12:00:00.000-05:00')").run(aliceId);
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-10','leg-cash-alice','Alice','2026-08-01T08:00:00.000-05:00','2026-08-01T16:00:00.000-05:00')").run();
    const tp = computeTipPool(db, '2026-08-01', '2026-08-01');
    saveTipPoolLedger(db, '2026-08-01', null, tp);
    const ledger = db.prepare("SELECT * FROM tip_pool_ledger WHERE report_date = '2026-08-01'").get();
    assert.ok(ledger, 'ledger row must exist');
    assert.equal(ledger.merchant_fee_credit_pct, 3);
    assert.equal(ledger.deduction_amount, tp.deduction_amount);
    assert.equal(ledger.pool_amount, tp.pool_amount);
    assert.equal(ledger.pooled, 1);
    const shares = db.prepare("SELECT * FROM tip_pool_shares WHERE ledger_id = ?").all(ledger.id);
    assert.equal(shares.length, 1);
    assert.equal(shares[0].employee_name, 'Alice');
    assert.equal(shares[0].share_amount, tp.by_employee[0].share);
  });

  await check('Manager Portal shift deletion actually flows into tip-pool hours (batch 6, end-to-end)', () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("DELETE FROM time_clock").run();
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 100, 0, 0, 0, 100, 100, 'card', 'completed', '2026-08-02T18:00:00.000-05:00')").run(aliceId);
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-del-alice','leg-cash-alice','Alice','2026-08-02T08:00:00.000-05:00','2026-08-02T20:00:00.000-05:00')").run();
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-del-bob','leg-cash-bob','Bob','2026-08-02T08:00:00.000-05:00','2026-08-02T20:00:00.000-05:00')").run();
    const before = computeTipPool(db, '2026-08-02', '2026-08-02');
    assert.equal(before.total_hours, 24, 'both Alice and Bob clocked 12h each, pre-delete');
    assert.equal(before.by_employee.length, 2);
    assert.ok(before.by_employee.every((e) => Math.abs(e.share - before.pool_amount / 2) < 0.01), 'split evenly pre-delete');

    // This is the exact call Manager Portal's delete-shift button drives, one
    // hop removed (portal:deleteTimeClock soft-deletes in the cloud; this is
    // what applying that tombstone on pull does on the kiosk).
    applyTimeClock({ uid: 'tp-del-bob', employee_uid: 'leg-cash-bob', deleted: true, updated_at: '2026-08-02T20:05:00.000-05:00' }, db);

    const after = computeTipPool(db, '2026-08-02', '2026-08-02');
    assert.equal(after.total_hours, 12, "Bob's deleted shift must not count toward hours anymore");
    assert.equal(after.by_employee.length, 1, 'Bob must not appear as a recipient once his shift is deleted');
    assert.equal(after.by_employee[0].name, 'Alice');
    assert.equal(after.by_employee[0].share, after.pool_amount, 'Alice alone now gets the whole pool');
  });

  db.prepare("DELETE FROM transactions").run();
  db.prepare("DELETE FROM time_clock").run();
  db.prepare("DELETE FROM tip_pool_shares").run();
  db.prepare("DELETE FROM tip_pool_ledger").run();

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
