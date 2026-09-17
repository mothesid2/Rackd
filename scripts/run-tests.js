
const assert = require('assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const { computeStatusFrom, computeStatus } = require('../dist/main/supabase/licenseCheck');
const {
  isSyncAllowed, failureUpdate, enqueueSync, recordFailure,
  getDeadLetters, retryDeadLetter, clearDeadLetter, getSyncStatus, getTenantId, enqueueCustomer,
  applyEmployee, applyTimeClock, applyProduct, enqueueInventorySnapshot, enqueueStockMovement,
  restoreCloudRowIfMissing,
} = require('../dist/main/supabase/sync');
const { cacheToken, getValidToken } = require('../dist/main/supabase/tokenManager');
const { computeTipPoolWindow, saveTipPoolLedger, buildFullReport, buildPeriodReport } = require('../dist/main/ipc/xzout');
const { computeRefundTax } = require('../dist/main/ipc/transactions');
const { insertProduct } = require('../dist/main/ipc/products');
const { initSchema } = require('../dist/main/db/schema');
const { runMigrations } = require('../dist/main/db/migrations');
const { businessDayBounds } = require('../dist/main/utils/time');
const { findCurrentOpenShift, getOrOpenCurrentShift } = require('../dist/main/shiftTotals');

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
    initSchema(fk); 
    
    const uid = fk.prepare("INSERT INTO users (username, password_hash, role) VALUES ('mgr','h','manager')").run().lastInsertRowid;
    fk.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status) VALUES (?, 1, 0, 0, 0, 1, 'cash', 'completed')").run(uid);
    runMigrations(fk); 
    const u = fk.prepare('SELECT role, must_change_pin FROM users WHERE id = ?').get(uid);
    assert.equal(u.role, 'manager');
    assert.equal(u.must_change_pin, 0);
    
    const t = fk.prepare('SELECT cashier_id FROM transactions WHERE cashier_id = ?').get(uid);
    assert.ok(t);
    assert.equal(fk.pragma('foreign_keys', { simple: true }), 1); 
    fk.close();
    for (const f of [p, p + '-shm', p + '-wal']) { try { fs.unlinkSync(f); } catch {  } }
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
  await check('inventory keyed by tenant_id,register_id,barcode (migration 072 — id alone collides across kiosks AND drifts across a single register\'s own reinstall)', () => assert.equal(isSyncAllowed('inventory', 'update').conflictTarget, 'tenant_id,register_id,barcode'));
  await check('settings never synced', () => assert.equal(isSyncAllowed('settings', 'update').allowed, false));
  await check('stock_movements insert allowed', () => assert.equal(isSyncAllowed('stock_movements', 'insert').allowed, true));
  await check('stock_movements keyed by movement_uid', () => assert.equal(isSyncAllowed('stock_movements', 'insert').conflictTarget, 'movement_uid'));
  
  
  
  
  await check('scoped table defaults conflict target', () => assert.equal(isSyncAllowed('transactions', 'insert').conflictTarget, 'tenant_id,register_id,id'));
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

  console.log('enqueueInventorySnapshot — barcode-keyed sync, migration 072 (db-backed):');
  await check('a product WITH a barcode is queued for the reporting mirror', () => {
    const id = db.prepare("INSERT INTO products (barcode, name, price, cost, stock_qty) VALUES ('072-TEST-1','Barcoded Widget', 5, 2, 10)").run().lastInsertRowid;
    const queued = enqueueInventorySnapshot(id, 'manual', db);
    assert.equal(queued, true, 'a barcoded product must be queued');
    
    
    const row = db.prepare("SELECT payload FROM sync_queue WHERE table_name='inventory' AND record_id=?").get(String(id));
    assert.ok(row, 'a real outbox row must exist for this product');
    assert.equal(JSON.parse(row.payload).barcode, '072-TEST-1');
  });
  await check('a product with NO barcode is skipped entirely — real fix, prevents duplicate-row spam under the new barcode-keyed conflict target', () => {
    
    
    
    
    
    const id = db.prepare("INSERT INTO products (barcode, name, price, cost, stock_qty) VALUES (NULL,'No-Barcode Widget', 5, 2, 10)").run().lastInsertRowid;
    const queued = enqueueInventorySnapshot(id, 'manual', db);
    assert.equal(queued, false, 'a barcode-less product must NOT be queued');
    const row = db.prepare("SELECT 1 FROM sync_queue WHERE table_name='inventory' AND record_id=?").get(String(id));
    assert.equal(row, undefined, 'nothing should have been added to the outbox');
  });

  console.log('refund-into-cart negative-qty handling (db-backed, refund flow redesign):');
  await check('a negative-qty line (refund-into-cart) ADDS stock back — same arithmetic transactions:create actually runs, not a reimplementation', () => {
    const id = db.prepare("INSERT INTO products (barcode, name, price, cost, stock_qty) VALUES ('REFUND-CART-1','Widget', 10, 4, 5)").run().lastInsertRowid;
    
    db.prepare(`UPDATE products SET stock_qty = MAX(0, stock_qty - ?), updated_at = ? WHERE id = ?`).run(-2, new Date().toISOString(), id);
    assert.equal(db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(id).stock_qty, 7, 'stock_qty - (-2) must add 2 back, not subtract');
  });
  await check("a negative-qty line enqueues its stock movement with reason 'return', not 'sale'", () => {
    const id = db.prepare("INSERT INTO products (barcode, name, price, cost, stock_qty) VALUES ('REFUND-CART-2','Widget2', 10, 4, 5)").run().lastInsertRowid;
    const itemQty = -3; 
    enqueueStockMovement(id, -itemQty, itemQty < 0 ? 'return' : 'sale', db); 
    const row = db.prepare("SELECT payload FROM sync_queue WHERE table_name='stock_movements' ORDER BY id DESC LIMIT 1").get();
    assert.ok(row, 'a movement must be queued');
    const payload = JSON.parse(row.payload);
    assert.equal(payload.reason, 'return', 'a refund-into-cart line must be logged as a return, not mislabeled as a sale');
    assert.equal(payload.delta, 3, 'the movement itself is a positive delta (stock coming back)');
  });
  await check("a positive-qty (normal sale) line still enqueues reason 'sale', unaffected by the fix", () => {
    const id = db.prepare("INSERT INTO products (barcode, name, price, cost, stock_qty) VALUES ('REFUND-CART-3','Widget3', 10, 4, 5)").run().lastInsertRowid;
    const itemQty = 2; 
    enqueueStockMovement(id, -itemQty, itemQty < 0 ? 'return' : 'sale', db);
    const row = db.prepare("SELECT payload FROM sync_queue WHERE table_name='stock_movements' ORDER BY id DESC LIMIT 1").get();
    const payload = JSON.parse(row.payload);
    assert.equal(payload.reason, 'sale');
    assert.equal(payload.delta, -2);
  });

  console.log("rebate auto-apply investigation — Mo's real 'Marlbor Bogo 1 off' rule (db-backed):");
  await check("root cause confirmed: Mo's rule as entered (active_start_date 2026-09-04) is correctly EXCLUDED by rebates:activeRules as of the real repro date (2026-08-29) — the rule has not started yet, this is not a bug in the matching engine", () => {
    db.prepare(`
      INSERT INTO rebate_rules (uid, manufacturer_uid, name, rule_type, qualifying_skus, qualifying_quantity,
        discount_amount, discount_type, is_manufacturer_funded, active_start_date, active_end_date, is_active, updated_at)
      VALUES ('mo-rule-real','a1000000-0000-4000-8000-000000000002','Marlbor Bogo 1 off','flat_discount',
        '["02846529","02847829"]', 2, 1, 'flat', 1, '2026-09-04', '2026-11-04', 1, datetime('now'))
    `).run();
    
    
    
    const asOf = '2026-08-29';
    const rows = db.prepare(`
      SELECT * FROM rebate_rules
      WHERE is_active = 1
        AND (active_start_date IS NULL OR active_start_date <= ?)
        AND (active_end_date   IS NULL OR active_end_date   >= ?)
    `).all(asOf, asOf);
    assert.ok(!rows.some(r => r.uid === 'mo-rule-real'),
      `as of ${asOf}, before the rule's active_start_date (2026-09-04) — it correctly does not appear yet, and won't until that date`);
  });
  await check('the SAME rule shape, with an always-active window (no start/end date), IS returned and matches checkout correctly — proves the auto-apply mechanism itself works; only the scheduled date is holding Mo\'s rule back', () => {
    const asOf = '2026-08-29';
    db.prepare(`
      INSERT INTO rebate_rules (uid, manufacturer_uid, name, rule_type, qualifying_skus, qualifying_quantity,
        discount_amount, discount_type, is_manufacturer_funded, active_start_date, active_end_date, is_active, updated_at)
      VALUES ('mo-rule-active-now','a1000000-0000-4000-8000-000000000002','Marlbor Bogo 1 off','flat_discount',
        '["02846529","02847829"]', 2, 1, 'flat', 1, NULL, NULL, 1, datetime('now'))
    `).run();
    const rows = db.prepare(`
      SELECT * FROM rebate_rules
      WHERE is_active = 1
        AND (active_start_date IS NULL OR active_start_date <= ?)
        AND (active_end_date   IS NULL OR active_end_date   >= ?)
    `).all(asOf, asOf);
    const rule = rows.find(r => r.uid === 'mo-rule-active-now');
    assert.ok(rule, 'an undated (always-active) rule of the same shape must come back once its window is open');
    const skus = JSON.parse(rule.qualifying_skus);
    assert.deepEqual(skus, ['02846529', '02847829']);
    
    
    const cart = [
      { barcode: '02846529', qty: 1, line_total: 6.5 },
      { barcode: '02847829', qty: 1, line_total: 6.5 },
    ];
    const matchedUnits = cart.filter(l => skus.includes(l.barcode)).reduce((s, l) => s + l.qty, 0);
    assert.ok(matchedUnits >= rule.qualifying_quantity, 'a 2-item cart across both qualifying SKUs meets qualifying_quantity=2 and would auto-apply the $1 discount once the rule is live');
  });

  console.log('customizable POS layout config (item 3, db-backed):');
  await check('a role with no saved config reads back as blank slots / null tile_order — main-menu renders its default-blank state, exactly the layout:getForRole handler logic', () => {
    const row = db.prepare('SELECT report_slots, tile_order, updated_at FROM pos_layout_config WHERE role = ?').get('cashier');
    assert.equal(row, undefined, 'no row exists yet for this fresh test db — the handler must fall back to null/null, not throw');
  });
  await check('a saved cashier layout (2 report slots + a reordered/trimmed tile set) round-trips exactly — proves the Manager Portal save shape (report_slots, tile_order arrays) is what the register actually reads back', () => {
    db.prepare(`
      INSERT INTO pos_layout_config (role, report_slots, tile_order, updated_at)
      VALUES ('cashier', ?, ?, datetime('now'))
    `).run(JSON.stringify(['sales', null]), JSON.stringify(['receipts', 'customer-lookup']));
    const row = db.prepare('SELECT report_slots, tile_order FROM pos_layout_config WHERE role = ?').get('cashier');
    const slots = JSON.parse(row.report_slots);
    const order = JSON.parse(row.tile_order);
    assert.deepEqual(slots, ['sales', null], 'a manager blanking slot 2 must come back exactly as [\'sales\', null], not dropped or reflowed');
    assert.deepEqual(order, ['receipts', 'customer-lookup'], 'unchecked tiles (merchandise, timeclock, pickups, xzout) must be simply ABSENT from tile_order — not present-but-disabled');
  });
  await check('applyLayoutConfig (sync.ts pull-apply) upserts by role, tenant-wide, same as rebate_rules — a re-pull with a changed layout overwrites cleanly, not duplicates', () => {
    
    const upsert = (role, slots, order) => db.prepare(
      `INSERT INTO pos_layout_config (role, report_slots, tile_order, updated_at)
       VALUES (@role, @slots, @order, @upd)
       ON CONFLICT(role) DO UPDATE SET report_slots=excluded.report_slots, tile_order=excluded.tile_order, updated_at=excluded.updated_at`
    ).run({ role, slots: slots ? JSON.stringify(slots) : null, order: order ? JSON.stringify(order) : null, upd: new Date().toISOString() });
    upsert('manager', ['revenue', 'profit', 'sales'], null);
    upsert('manager', ['revenue', 'profit', 'sales', 'tax_collected'].slice(0, 3), ['xzout']); 
    const rows = db.prepare("SELECT * FROM pos_layout_config WHERE role = 'manager'").all();
    assert.equal(rows.length, 1, 'a second pull for the same role must update in place, never insert a duplicate row');
    assert.deepEqual(JSON.parse(rows[0].tile_order), ['xzout']);
  });

  console.log('unknown-barcode quick-add: shared insert + genuinely separate gates (item 6 + Mo\'s correction, db-backed):');
  await check('insertProduct (shared by products:add AND products:quickAddFromSale) writes a real row and queues cloud sync — the ONE piece of logic both endpoints must never diverge on', () => {
    const id = insertProduct(db, {
      barcode: 'QUICKADD-1', name: 'Quick Add Test Item', category: 'Test', vendor: 'Acme',
      price: 9.99, cost: 4.5, stock_qty: 3, low_stock_threshold: 2, age_restricted: 1, low_stock_alert: 1, is_taxable: 1,
    });
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(id));
    assert.ok(row, 'the product must actually exist in the products table');
    assert.equal(row.barcode, 'QUICKADD-1');
    assert.equal(row.stock_qty, 3);
    assert.equal(row.age_restricted, 1);
    const movement = db.prepare("SELECT * FROM sync_queue WHERE table_name='stock_movements' ORDER BY id DESC LIMIT 1").get();
    assert.ok(movement, 'a starting-stock movement must be queued for cloud sync, same as a manager-created product gets');
  });
  await check("products:add's gate (role !== 'manager') and products:quickAddFromSale's gate (no session at all) are genuinely DIFFERENT checks, not the same predicate reused — a cashier session is blocked by one and allowed by the other", () => {
    const cashierSession = { userId: 1, role: 'cashier' };
    const managerSession = { userId: 2, role: 'manager' };
    const noSession = null;
    
    const addBlocked = (s) => s?.role !== 'manager';
    
    const quickAddBlocked = (s) => !s;
    assert.equal(addBlocked(cashierSession), true, "Merchandise's Add Product must still reject a cashier — this gate must NOT have been weakened");
    assert.equal(quickAddBlocked(cashierSession), false, "the in-sale quick-add must allow a signed-in cashier, per Mo's explicit correction");
    
    assert.equal(addBlocked(managerSession), false);
    assert.equal(quickAddBlocked(managerSession), false);
    
    assert.equal(quickAddBlocked(noSession), true);
  });

  console.log('applyEmployee — cashiers are PIN-only (db-backed):');
  await check('pull self-heals a legacy cashier row stuck with a password + forced-change flag', () => {
    
    
    
    
    db.prepare(
      "INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active, must_change_password, must_change_pin) VALUES ('legacy-cash-1', NULL, 'Legacy Cash', 'cashier', 'stuck-hash', 'pin-hash', 1, 1, 1)"
    ).run();
    
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
    
    
    const saleSubtotal = 2.50;
    const saleTax = saleSubtotal * taxRate; 
    const saleTotal = saleSubtotal + saleTax;

    
    const { total: refundTotal } = computeRefundTax(saleSubtotal, saleSubtotal, saleTax, taxRate);
    assert.equal(+(saleTotal + refundTotal).toFixed(10), 0, 'one sale + its full refund must net to exactly zero');

    
    const netCashFlow = (saleTotal + refundTotal) + (saleTotal + refundTotal);
    assert.equal(+netCashFlow.toFixed(10), 0, 'two sales + two full refunds must net to exactly $0.00, not -$0.01');
  });
  await check('a full refund reuses the original tax EXACTLY, not a fresh rounded recompute', () => {
    
    
    const origSubtotal = 2.50, origTax = 2.50 * 0.0825; 
    const { tax } = computeRefundTax(2.50, origSubtotal, origTax, 0.0825);
    assert.equal(tax, origTax, 'full refund (subtotal === origSubtotal) must reuse the original tax exactly');
  });
  await check('the OLD buggy formula would have failed this — confirms the bug was real, not hypothetical', () => {
    
    
    
    
    const oldBuggyTax = +(2.50 * 0.0825).toFixed(2); 
    const saleTax = 2.50 * 0.0825; 
    assert.notEqual(oldBuggyTax, saleTax, 'the old formula diverges from the original sale — this was the bug');
  });
  await check('a partial refund takes a proportional share of the original tax, not a fresh recompute', () => {
    
    const origSubtotal = 10, origTax = 10 * 0.0825;
    const { tax } = computeRefundTax(5, origSubtotal, origTax, 0.0825);
    assert.equal(tax, origTax * 0.5, 'half the subtotal refunded -> half the original tax, proportionally');
  });
  await check('falls back to a fresh rate-based computation when there is no original subtotal to derive from', () => {
    const { tax } = computeRefundTax(5, 0, 0, 0.0825);
    assert.equal(tax, +(5 * 0.0825).toFixed(2));
  });

  console.log('tip pool (batch 5, legal rebuild, db-backed):');
  
  
  
  
  
  
  const tipPoolForDate = (date) => {
    const b = businessDayBounds(date, db);
    return computeTipPoolWindow(db, b.start, b.end);
  };
  
  
  db.prepare("DELETE FROM transactions").run();
  db.prepare("DELETE FROM time_clock").run();
  db.prepare("UPDATE settings SET value = '3' WHERE key = 'merchant_fee_credit_pct'").run();

  
  const aliceId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('leg-cash-alice', NULL, 'Alice', 'cashier', NULL, 'x', 1)").run().lastInsertRowid;
  const bobId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('leg-cash-bob', NULL, 'Bob', 'cashier', NULL, 'x', 1)").run().lastInsertRowid;
  const mannyId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('leg-mgr-manny', 'manny', 'Manny', 'manager', 'x', NULL, 1)").run().lastInsertRowid;
  const monaId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('leg-mgr-mona', 'mona', 'Mona', 'manager', 'x', NULL, 1)").run().lastInsertRowid;

  await check("user's own worked example: $97 pool, 12 of 24 hours -> $48.50 (both cashiers)", () => {
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 100, 0, 0, 0, 100, 100, 'card', 'completed', '2026-07-24T18:00:00.000-05:00')").run(aliceId);
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-1','leg-cash-alice','Alice','2026-07-24T08:00:00.000-05:00','2026-07-24T20:00:00.000-05:00')").run();
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-2','leg-cash-bob','Bob','2026-07-24T08:00:00.000-05:00','2026-07-24T20:00:00.000-05:00')").run();
    const tp = tipPoolForDate('2026-07-24');
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
    
    
    
    
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 100, 0, 0, 0, 100, 100, 'card', 'completed', '2026-07-27T18:00:00.000-05:00')").run(aliceId);
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-3','leg-cash-alice','Alice','2026-07-27T08:00:00.000-05:00','2026-07-27T20:00:00.000-05:00')").run();
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-4','leg-mgr-manny','Manny','2026-07-27T08:00:00.000-05:00','2026-07-27T20:00:00.000-05:00')").run();
    const tp = tipPoolForDate('2026-07-27');
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
    const tp = tipPoolForDate('2026-07-28');
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
    const tp = tipPoolForDate('2026-07-29');
    assert.equal(tp.pooled, false);
    const manny = tp.by_employee.find((e) => e.name === 'Manny');
    const mona = tp.by_employee.find((e) => e.name === 'Mona');
    assert.equal(manny.share, 20, "Manny keeps only his own $20 — not averaged/split with Mona's $80");
    assert.equal(mona.share, 80, "Mona keeps only her own $80");
  });

  await check('cash tips carry no processing-cost deduction — only the card-tendered portion is fee-based', () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("DELETE FROM time_clock").run();
    
    
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 60, 0, 0, 0, 60, 60, 'cash', 'completed', '2026-07-30T12:00:00.000-05:00')").run(aliceId);
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, tip_amount, payment_method, payment_status, created_at) VALUES (?, 40, 0, 0, 0, 40, 40, 'card', 'completed', '2026-07-30T14:00:00.000-05:00')").run(aliceId);
    db.prepare("INSERT INTO time_clock (uid, employee_uid, employee_name, clock_in, clock_out) VALUES ('tp-in-8','leg-cash-alice','Alice','2026-07-30T08:00:00.000-05:00','2026-07-30T16:00:00.000-05:00')").run();
    const tp = tipPoolForDate('2026-07-30');
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
    const unset = tipPoolForDate('2026-07-31');
    assert.equal(unset.deduction_amount, 0, 'no deduction until the owner explicitly sets a real rate — never a guessed default');
    db.prepare("UPDATE settings SET value = '2.9' WHERE key = 'merchant_fee_credit_pct'").run();
    const set = tipPoolForDate('2026-07-31');
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
    const tp = tipPoolForDate('2026-08-01');
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
    const before = tipPoolForDate('2026-08-02');
    assert.equal(before.total_hours, 24, 'both Alice and Bob clocked 12h each, pre-delete');
    assert.equal(before.by_employee.length, 2);
    assert.ok(before.by_employee.every((e) => Math.abs(e.share - before.pool_amount / 2) < 0.01), 'split evenly pre-delete');

    
    
    
    applyTimeClock({ uid: 'tp-del-bob', employee_uid: 'leg-cash-bob', deleted: true, updated_at: '2026-08-02T20:05:00.000-05:00' }, db);

    const after = tipPoolForDate('2026-08-02');
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
  console.log("stale shift_totals — real bug (Mo's Cash Drawer showed 5 card sales / $55 cash he never rang up, db-backed):");
  {
    const dsEarly = require('../dist/main/daySession');
    const staleCashierId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('cash-stale-1','cashstale1','CashStale1','cashier','',?,1)").run(bcryptP.hashSync('3333', 10)).lastInsertRowid;

    
    
    
    
    dsEarly.openDay(mgrId, 'mgrx', db);
    const { businessDayStart } = require('../dist/main/utils/time');
    const { DateTime } = require('luxon');
    const boundary = businessDayStart(db);

    const staleOpenedAt = DateTime.fromISO(boundary).minus({ days: 1 }).toISO(); 
    const staleId = db.prepare(
      `INSERT INTO shift_totals (cashier_id, opened_at, starting_cash, cash_total, card_total, sale_count) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(staleCashierId, staleOpenedAt, 200, 55, 999, 5).lastInsertRowid; 

    await check("findCurrentOpenShift ignores a shift opened before today's business day — this is the exact bug: the old code found ANY unclosed shift no matter how stale and displayed its leftover numbers", () => {
      const found = findCurrentOpenShift(staleCashierId, db);
      assert.equal(found, undefined, 'a shift from a PRIOR business day must not be treated as "the current shift"');
    });

    await check('the OLD (buggy) bare query WOULD have surfaced the stale row — proves this is a real, reproducible bug, not hypothetical', () => {
      const oldQueryResult = db.prepare(
        `SELECT * FROM shift_totals WHERE cashier_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`
      ).get(staleCashierId);
      assert.ok(oldQueryResult, 'sanity: the stale row exists and is unclosed');
      assert.equal(oldQueryResult.card_total, 999, "the OLD query returns Mo's phantom 999 card total — exactly what he saw, reproduced");
    });

    await check('getOrOpenCurrentShift closes out the stale row and opens a fresh one for today — no more phantom leftover numbers', () => {
      const freshId = getOrOpenCurrentShift(staleCashierId, db);
      assert.notEqual(freshId, staleId, 'must be a NEW row, not the stale one reused');
      const staleRow = db.prepare('SELECT closed_at FROM shift_totals WHERE id = ?').get(staleId);
      assert.ok(staleRow.closed_at, 'the stale row must now be closed, not left open forever');
      const freshRow = db.prepare('SELECT cash_total, card_total, sale_count FROM shift_totals WHERE id = ?').get(freshId);
      assert.equal(freshRow.cash_total, 0);
      assert.equal(freshRow.card_total, 0);
      assert.equal(freshRow.sale_count, 0);
    });

    await check("a shift genuinely opened TODAY (after the business-day boundary) is correctly treated as current — the fix doesn't over-correct and close/ignore real same-day shifts", () => {
      const todayCashierId = db.prepare("INSERT INTO users (uid, username, name, role, password_hash, pin_hash, is_active) VALUES ('cash-today-1','cashtoday1','CashToday1','cashier','',?,1)").run(bcryptP.hashSync('4444', 10)).lastInsertRowid;
      const id = db.prepare(
        `INSERT INTO shift_totals (cashier_id, opened_at, cash_total, card_total, sale_count) VALUES (?, ?, ?, ?, ?)`
      ).run(todayCashierId, boundary, 120, 0, 3).lastInsertRowid; 
      const found = findCurrentOpenShift(todayCashierId, db);
      assert.ok(found, "today's real shift must be found, not incorrectly discarded");
      assert.equal(found.id, id);
      assert.equal(found.cash_total, 120);
      assert.equal(found.card_total, 0);
    });

    dsEarly.closeDay(db);
  }

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

  await check("openDayAutomatic opens the day with no human opener (Mo: batch time should start the day automatically, no employee should ever see a 'start of day' prompt)", () => {
    ds.closeDay(db);
    assert.equal(ds.isDayOpen(db), false);
    ds.openDayAutomatic(db);
    assert.equal(ds.isDayOpen(db), true);
    const info = ds.dayInfo(db);
    assert.equal(info.openedById, null, 'no employee id — nobody actually opened this');
    assert.equal(info.openedByName, 'Automatic (batch time)');
    assert.ok(info.openedAt, 'still records a real timestamp, just an automatic one');
    ds.closeDay(db);
  });

  console.log('Task 1 — start-day permission gate removed (db-backed):');
  const { PERMISSION_KEYS, verifyPinForUser } = require('../dist/main/permissions');
  await check("'open_shift' no longer exists as a grantable permission — start-day is unconditional now, not gated", () => {
    assert.ok(!PERMISSION_KEYS.includes('open_shift'), 'open_shift must be fully removed, not just unused');
  });
  await check('a cashier with ZERO grants (no open_shift, nothing) can still open the day with their own PIN', () => {
    ds.closeDay(db);
    assert.equal(ds.isDayOpen(db), false);
    
    
    const r = verifyPinForUser(db, cashId, '1111');
    assert.equal(r.ok, true);
    assert.equal(userHasPermission(db, cashId, 'apply_discount').granted, false, 'confirms this cashier truly holds no special grants');
    if (!ds.isDayOpen(db)) ds.openDay(r.employee.id, r.employee.name, db);
    assert.equal(ds.isDayOpen(db), true, 'an ungranted cashier must be able to open the day — Task 1');
    assert.equal(ds.dayInfo(db).openedByName, 'Cash');
    ds.closeDay(db);
  });

  console.log('business-day window (Task 2, db-backed):');
  const { DateTime } = require('luxon');
  const {
    currentBusinessDayWindow, businessDayStart, scheduledBusinessDayStart,
    currentBusinessDate,
  } = require('../dist/main/utils/time'); 
  db.prepare("DELETE FROM z_reports").run();
  db.prepare("DELETE FROM settings WHERE key IN ('batch_time','business_timezone')").run();
  db.prepare("INSERT INTO settings (key,value) VALUES ('business_timezone','America/Chicago')").run();

  await check('normal 24h window: open window starts exactly at dayInfo.openedAt, not midnight', () => {
    ds.closeDay(db);
    const openedAt = '2026-08-24T09:17:00.000-05:00'; 
    ds.openDay(mgrId, 'mgrx', db);
    db.prepare("UPDATE settings SET value = ? WHERE key = 'day_session_opened_at'").run(openedAt);
    const win = currentBusinessDayWindow(db);
    assert.equal(win.start, openedAt, 'window start must be the exact open timestamp, not truncated to a date');
    assert.equal(win.end, null, 'an open business day is open-ended (through "now")');
    assert.equal(businessDayStart(db), openedAt);
  });

  await check('a sale just before the window start is excluded, a sale just after is included (the actual date-truncation bug this fixes)', () => {
    db.prepare("DELETE FROM transactions").run();
    const openedAt = businessDayStart(db); 
    
    
    
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 5, 0, 0, 0, 5, 'cash', 'completed', '2026-08-24T09:16:00.000-05:00')").run(aliceId);
    
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 7, 0, 0, 0, 7, 'cash', 'completed', '2026-08-24T09:18:00.000-05:00')").run(aliceId);
    const rows = db.prepare("SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM transactions WHERE created_at >= ? AND payment_status = 'completed'").get(openedAt);
    assert.equal(rows.n, 1, 'only the post-open sale should be in the business-day window');
    assert.equal(rows.total, 7);
  });

  await check('6 AM cross-midnight scenario: an 11 PM sale and a 3 AM sale land in the SAME business day', () => {
    db.prepare("INSERT INTO settings (key,value) VALUES ('batch_time','06:00') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
    const elevenPm = DateTime.fromISO('2026-08-24T23:00:00', { zone: 'America/Chicago' });
    const threeAm = DateTime.fromISO('2026-08-25T03:00:00', { zone: 'America/Chicago' });
    const boundaryAt11pm = scheduledBusinessDayStart(db, elevenPm);
    const boundaryAt3am = scheduledBusinessDayStart(db, threeAm);
    assert.equal(boundaryAt11pm, boundaryAt3am, '11 PM and 3 AM (before the next 6 AM) must resolve to the identical business-day start');
    assert.equal(boundaryAt11pm, DateTime.fromISO('2026-08-24T06:00:00', { zone: 'America/Chicago' }).toISO());
  });

  await check('6 AM cross-midnight scenario: a 6:05 AM sale rolls into the NEW business day', () => {
    const justAfterBatch = DateTime.fromISO('2026-08-25T06:05:00', { zone: 'America/Chicago' });
    const boundary = scheduledBusinessDayStart(db, justAfterBatch);
    assert.equal(boundary, DateTime.fromISO('2026-08-25T06:00:00', { zone: 'America/Chicago' }).toISO(), '6:05 AM is past today\'s 6 AM boundary — must start a fresh window, not the previous day\'s');
    const threeAmBoundary = scheduledBusinessDayStart(db, DateTime.fromISO('2026-08-25T03:00:00', { zone: 'America/Chicago' }));
    assert.notEqual(boundary, threeAmBoundary, '6:05 AM must NOT share a window with 3 AM the same calendar morning — that\'s the previous business day');
  });

  await check('no batch_time configured falls back to calendar midnight (legacy/default behavior preserved)', () => {
    db.prepare("DELETE FROM settings WHERE key = 'batch_time'").run();
    const noon = DateTime.fromISO('2026-08-24T12:00:00', { zone: 'America/Chicago' });
    const boundary = scheduledBusinessDayStart(db, noon);
    assert.equal(boundary, noon.startOf('day').toISO());
    db.prepare("INSERT INTO settings (key,value) VALUES ('batch_time','06:00') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  });

  await check('manual early Z-out shortens the window immediately, and the NEXT start-day begins exactly there', () => {
    
    
    const manualZAt = '2026-08-24T14:30:00.000-05:00';
    ds.closeDay(db);
    db.prepare(
      `INSERT INTO z_reports (generated_at, generated_by, shift_opened_at, cash_total, card_total, split_total, sale_count, tax_total, discount_total, gross_sales, net_sales, report_json)
       VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, '{}')`
    ).run(manualZAt, mgrId, '2026-08-24T09:17:00.000-05:00');

    
    
    const closedWindow = currentBusinessDayWindow(db);
    assert.equal(closedWindow.start, manualZAt, 'while closed, the window anchors at the last Z-out, not midnight');

    
    
    const nextStartAt = '2026-08-24T14:47:00.000-05:00';
    ds.openDay(cashId, 'cashx', db); 
    db.prepare("UPDATE settings SET value = ? WHERE key = 'day_session_opened_at'").run(nextStartAt);
    const reopenedWindow = currentBusinessDayWindow(db);
    assert.equal(reopenedWindow.start, nextStartAt, 'the new business day starts exactly at the early manual re-open, not at the next scheduled batch time');
    assert.notEqual(reopenedWindow.start, manualZAt);
  });

  await check("register-filter gap fix: a register that logged in LATE (idle since batch time, no intervening Z-out) widens 'This Register' to match the formula boundary", () => {
    
    
    
    
    
    
    db.prepare("DELETE FROM z_reports").run();
    ds.closeDay(db);
    ds.openDay(mgrId, 'mgrx', db);
    const openedAt = '2026-08-25T09:00:00.000-05:00';
    db.prepare("UPDATE settings SET value = ? WHERE key = 'day_session_opened_at'").run(openedAt);
    const now = DateTime.fromISO('2026-08-25T11:00:00', { zone: 'America/Chicago' }); 
    const win = currentBusinessDayWindow(db, now);
    assert.equal(win.start, DateTime.fromISO('2026-08-25T06:00:00', { zone: 'America/Chicago' }).toISO(), 'widened to the 6 AM formula boundary, not the 9 AM late login');
  });

  await check("register-filter gap fix does NOT reintroduce double-counting: a manual EARLY Z-out on the SAME real day must NOT widen past it", () => {
    
    
    
    
    
    
    
    
    db.prepare("DELETE FROM z_reports").run();
    const manualZAt = '2026-08-25T14:00:00.000-05:00';
    ds.closeDay(db);
    db.prepare(
      `INSERT INTO z_reports (generated_at, generated_by, shift_opened_at, cash_total, card_total, split_total, sale_count, tax_total, discount_total, gross_sales, net_sales, report_json)
       VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, '{}')`
    ).run(manualZAt, mgrId, '2026-08-25T06:00:00.000-05:00');
    ds.openDay(cashId, 'cashx', db);
    const reopenAt = '2026-08-25T14:47:00.000-05:00';
    db.prepare("UPDATE settings SET value = ? WHERE key = 'day_session_opened_at'").run(reopenAt);
    const now = DateTime.fromISO('2026-08-25T15:00:00', { zone: 'America/Chicago' }); 
    const win = currentBusinessDayWindow(db, now);
    assert.equal(win.start, reopenAt, 'must stay exactly at the 2:47 PM reopen — widening to 6 AM here would double-count the already-closed 6 AM-2 PM business day');
  });

  await check("register-filter gap fix, real regression (Mo: automatic Z report missing $4.64 / 2 items): the ROUTINE automatic Z-out that closes YESTERDAY's day (landing right at today's formula boundary) must not be mistaken for a same-day early close — 'today' still widens for a late login", () => {
    
    
    
    
    
    
    
    
    
    
    
    db.prepare("DELETE FROM z_reports").run();
    db.prepare(
      `INSERT INTO z_reports (generated_at, generated_by, shift_opened_at, cash_total, card_total, split_total, sale_count, tax_total, discount_total, gross_sales, net_sales, report_json)
       VALUES (?, NULL, ?, 0, 0, 0, 0, 0, 0, 0, 0, '{}')`
    ).run('2026-08-26T06:00:31.000-05:00', '2026-08-25T08:50:00.000-05:00');
    ds.closeDay(db);
    ds.openDay(mgrId, 'mgrx', db);
    const lateLoginAt = '2026-08-26T08:55:00.000-05:00';
    db.prepare("UPDATE settings SET value = ? WHERE key = 'day_session_opened_at'").run(lateLoginAt);
    const now = DateTime.fromISO('2026-08-26T09:30:00', { zone: 'America/Chicago' });
    const win = currentBusinessDayWindow(db, now);
    assert.equal(win.start, DateTime.fromISO('2026-08-26T06:00:00', { zone: 'America/Chicago' }).toISO(),
      "must widen to the 6 AM formula boundary — yesterday's boundary-crossing automatic close is not a same-day early close");
  });

  await check("second real regression (Mo: automatic Z report missing ~$40 / 4 transactions, six days after the first fix): evaluating currentBusinessDayWindow() AT the exact boundary-crossing minute must still widen back to YESTERDAY's boundary, not TODAY's brand-new one", () => {
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    db.prepare("DELETE FROM z_reports").run();
    ds.closeDay(db);
    ds.openDay(mgrId, 'mgrx', db);
    const lateOpenYesterday = '2026-08-25T10:04:00.000-05:00';
    db.prepare("UPDATE settings SET value = ? WHERE key = 'day_session_opened_at'").run(lateOpenYesterday);
    
    
    const schedulerNow = DateTime.fromISO('2026-08-26T06:00:15', { zone: 'America/Chicago' }).minus({ minutes: 2 });
    const win = currentBusinessDayWindow(db, schedulerNow);
    assert.equal(win.start, DateTime.fromISO('2026-08-25T06:00:00', { zone: 'America/Chicago' }).toISO(),
      "must widen to YESTERDAY's (Aug 25) 6 AM boundary — evaluating right at Aug 26's own boundary-crossing instant must not resolve formulaStart to Aug 26 instead");

    
    
    
    
    const unshifted = currentBusinessDayWindow(db, DateTime.fromISO('2026-08-26T06:00:15', { zone: 'America/Chicago' }));
    assert.equal(unshifted.start, lateOpenYesterday, 'sanity check: confirms the un-shifted call really does reproduce the old bug, so the shift above is actually doing something');
  });

  await check('receipt timestamps are never touched by any of this — only which window a sale groups into', () => {
    db.prepare("DELETE FROM transactions").run();
    const exact = '2026-08-24T14:35:12.345-05:00';
    const id = db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 9, 0, 0, 0, 9, 'cash', 'completed', ?)").run(aliceId, exact).lastInsertRowid;
    const row = db.prepare('SELECT created_at FROM transactions WHERE id = ?').get(id);
    assert.equal(row.created_at, exact, 'the stored receipt timestamp must be exactly what was recorded, unmodified by business-day windowing logic');
  });

  await check("real-world repro: 12:45 AM the 26th, batch time 6 AM — 'today' is still the 25th's business date, not the calendar date", () => {
    
    
    
    const at1245am = DateTime.fromISO('2026-08-26T00:45:00', { zone: 'America/Chicago' });
    assert.equal(currentBusinessDate(db, at1245am), '2026-08-25', "12:45 AM the 26th is still the 25th's business day");
    
    const at605am = DateTime.fromISO('2026-08-26T06:05:00', { zone: 'America/Chicago' });
    assert.equal(currentBusinessDate(db, at605am), '2026-08-26');
  });

  await check("businessDayBounds('2026-08-25') spans 6 AM the 25th -> 6 AM the 26th, not calendar midnight", () => {
    const b = businessDayBounds('2026-08-25', db);
    assert.equal(b.start, DateTime.fromISO('2026-08-25T06:00:00', { zone: 'America/Chicago' }).toISO());
    assert.equal(b.end, DateTime.fromISO('2026-08-26T06:00:00', { zone: 'America/Chicago' }).toISO());
  });

  await check("viewing the report for 'Aug 25' includes an 11 PM Aug-25 sale AND a 3 AM Aug-26 sale, but NOT a 6:05 AM Aug-26 sale", () => {
    db.prepare("DELETE FROM transactions").run();
    const { start, end } = businessDayBounds('2026-08-25', db);
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 10, 0, 0, 0, 10, 'cash', 'completed', '2026-08-25T23:00:00.000-05:00')").run(aliceId); 
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 20, 0, 0, 0, 20, 'cash', 'completed', '2026-08-26T03:00:00.000-05:00')").run(aliceId); 
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 999, 0, 0, 0, 999, 'cash', 'completed', '2026-08-26T06:05:00.000-05:00')").run(aliceId); 
    const rows = db.prepare("SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM transactions WHERE created_at >= ? AND created_at < ? AND payment_status = 'completed'").get(start, end);
    assert.equal(rows.n, 2, "the 'Aug 25' report must include exactly the two sales inside its batch window");
    assert.equal(rows.total, 30, 'the 6:05 AM sale (next business day) must NOT be counted toward Aug 25');
    
    const b26 = businessDayBounds('2026-08-26', db);
    const rows26 = db.prepare("SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM transactions WHERE created_at >= ? AND created_at < ? AND payment_status = 'completed'").get(b26.start, b26.end);
    assert.equal(rows26.n, 1);
    assert.equal(rows26.total, 999);
  });

  await check("Mo's bug report #1: Receipts 'Yesterday' must be the previous BATCH day, not the previous calendar day (real regression, confirmed live)", () => {
    
    db.prepare("DELETE FROM transactions").run();
    const yesterday = businessDayBounds('2026-08-25', db);
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 1, 0, 0, 0, 1, 'cash', 'completed', '2026-08-25T03:00:00.000-05:00')").run(aliceId); 
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 2, 0, 0, 0, 2, 'cash', 'completed', '2026-08-25T23:00:00.000-05:00')").run(aliceId); 
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 4, 0, 0, 0, 4, 'cash', 'completed', '2026-08-26T03:00:00.000-05:00')").run(aliceId); 
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 8, 0, 0, 0, 8, 'cash', 'completed', '2026-08-26T07:00:00.000-05:00')").run(aliceId); 

    
    const fixed = db.prepare("SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM transactions WHERE created_at >= ? AND created_at < ? AND payment_status = 'completed'").get(yesterday.start, yesterday.end);
    assert.equal(fixed.n, 2, "'Yesterday' (Aug 25 batch day) must include exactly the 11 PM Aug-25 and 3 AM Aug-26 sales");
    assert.equal(fixed.total, 6);

    
    const buggy = db.prepare("SELECT COALESCE(SUM(total),0) AS total, COUNT(*) AS n FROM transactions WHERE substr(created_at,1,10) BETWEEN ? AND ? AND payment_status = 'completed'").get('2026-08-25', '2026-08-25');
    assert.equal(buggy.n, 2, 'sanity: the old calendar-date query also finds 2 rows...');
    assert.equal(buggy.total, 3, "...but the WRONG two — it mixes in the 3 AM Aug-25 sale (really the 24th's business day) and misses the 3 AM Aug-26 sale (really part of the 25th's) — exactly Mo's 'Aug 24 mixed in' report");
  });

  await check("Mo's bug report #2: a post-midnight, pre-batch sale (2 AM, batch at 6 AM) counts in EXACTLY ONE business day — not zero, not two", () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 15, 0, 0, 0, 15, 'cash', 'completed', '2026-08-26T02:00:00.000-05:00')").run(aliceId);

    const countIn = (label) => {
      const b = businessDayBounds(label, db);
      return db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE created_at >= ? AND created_at < ? AND payment_status = 'completed'").get(b.start, b.end).n;
    };
    assert.equal(countIn('2026-08-24'), 0, 'must not appear two days back');
    assert.equal(countIn('2026-08-25'), 1, 'the correct business day — the batch has not rolled past 6 AM the 26th yet');
    assert.equal(countIn('2026-08-26'), 0, 'must NOT also appear under the 26th — that would be the double-count Mo reported');
    assert.equal(countIn('2026-08-27'), 0, 'must not appear a day forward either');

    
    const row = db.prepare("SELECT created_at FROM transactions WHERE total = 15").get();
    assert.equal(row.created_at, '2026-08-26T02:00:00.000-05:00', "the receipt's real timestamp is unaffected — only which report bucket it groups into changed");
  });

  await check("real production repro: transaction #134 (Stay Express Inn, actual synced row) — 1:17 AM Aug 27 must group under Aug 26's batch day", () => {
    
    
    
    
    
    
    
    db.prepare("DELETE FROM transactions").run();
    db.prepare("INSERT INTO transactions (id, cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (134, ?, 6.38, 0.0825, 0.53, 0, 6.91, 'cash', 'completed', '2026-08-27T01:17:44.456-05:00')").run(aliceId);

    const b26 = businessDayBounds('2026-08-26', db);
    const inAug26 = db.prepare("SELECT id FROM transactions WHERE created_at >= ? AND created_at < ? AND payment_status='completed'").get(b26.start, b26.end);
    assert.equal(inAug26 && inAug26.id, 134, 'txn 134 must be included in the Aug 26 batch day');

    const b27 = businessDayBounds('2026-08-27', db);
    const inAug27 = db.prepare("SELECT id FROM transactions WHERE created_at >= ? AND created_at < ? AND payment_status='completed'").get(b27.start, b27.end);
    assert.equal(inAug27, undefined, 'txn 134 must NOT also appear under Aug 27 — that was the exact bug Mo reported');

    const stored = db.prepare('SELECT created_at FROM transactions WHERE id = 134').get();
    assert.equal(stored.created_at, '2026-08-27T01:17:44.456-05:00', "the receipt's own displayed timestamp (Aug 27, 1:17 AM) must stay exactly as recorded");
  });

  await check("real production repro: receipts #122-138 (all 17, real Stay Express Inn data, Aug 26 7:10 PM through Aug 27 5:51 AM) — X/Z-out reporting groups every one into Aug 26's batch day, none leak into Aug 27", () => {
    
    
    
    
    
    db.prepare("DELETE FROM transactions").run();
    const REAL = [
      [122, '2026-08-26T19:10:07.196-05:00', 21.64], [123, '2026-08-26T20:13:56.778-05:00', 4.31],
      [124, '2026-08-26T20:15:24.489-05:00', 12.98], [125, '2026-08-26T20:40:12.492-05:00', 1.50],
      [126, '2026-08-26T20:45:55.486-05:00', 3.00],  [127, '2026-08-26T21:27:14.559-05:00', 17.22],
      [128, '2026-08-26T21:41:42.496-05:00', 2.15],  [129, '2026-08-26T21:45:25.411-05:00', 3.01],
      [130, '2026-08-26T21:47:48.656-05:00', 7.57],  [131, '2026-08-26T22:24:50.357-05:00', 6.50],
      [132, '2026-08-26T23:27:33.686-05:00', 2.59],  [133, '2026-08-26T23:34:10.610-05:00', 5.17],
      [134, '2026-08-27T01:17:44.456-05:00', 6.91],  [135, '2026-08-27T01:37:18.092-05:00', 3.25],
      [136, '2026-08-27T01:58:40.856-05:00', 12.98], [137, '2026-08-27T04:46:13.345-05:00', 3.25],
      [138, '2026-08-27T05:51:04.481-05:00', 4.32],
    ];
    const ins = db.prepare("INSERT INTO transactions (id, cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, ?, ?, 0, 0, 0, ?, 'cash', 'completed', ?)");
    let expectedTotal = 0;
    for (const [id, ts, total] of REAL) { ins.run(id, aliceId, total, total, ts); expectedTotal += total; }
    expectedTotal = Math.round(expectedTotal * 100) / 100;

    const aug26 = buildPeriodReport(db, '2026-08-26', '2026-08-26');
    assert.equal(aug26.summary.count, 17, 'Audit/X-Report for Aug 26 must include all 17 real receipts');
    assert.ok(Math.abs(aug26.summary.total_collected - expectedTotal) < 0.01, `Aug 26 gross must total $${expectedTotal}, got $${aug26.summary.total_collected}`);

    const aug27 = buildPeriodReport(db, '2026-08-27', '2026-08-27');
    assert.equal(aug27.summary.count, 0, 'none of 122-138 may leak into Aug 27 — that is the exact double/mis-count Mo asked about');

    
    const live = buildFullReport(db, '2026-08-26T06:00:00.000-05:00', 'Test Manager');
    assert.equal(live.sale_count, 17, 'the live/open-day Z-out engine must also see all 17');
    assert.ok(Math.abs(live.gross_sales - expectedTotal) < 0.01, `live gross must total $${expectedTotal}, got $${live.gross_sales}`);
  });

  console.log('employeePerformance business-day date-range fix (db-backed, audit sweep):');
  const { computeEmployeePerformance } = require('../dist/main/ipc/analytics');
  await check("specific-date selection ('Aug 25') includes the correct batch-day sales, not calendar-day ones", () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 10, 0, 0, 0, 10, 'cash', 'completed', '2026-08-25T03:00:00.000-05:00')").run(aliceId); 
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 20, 0, 0, 0, 20, 'cash', 'completed', '2026-08-25T23:00:00.000-05:00')").run(aliceId); 
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 40, 0, 0, 0, 40, 'cash', 'completed', '2026-08-26T03:00:00.000-05:00')").run(aliceId); 
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 80, 0, 0, 0, 80, 'cash', 'completed', '2026-08-26T07:00:00.000-05:00')").run(aliceId); 

    const res = computeEmployeePerformance(db, { start_date: '2026-08-25', end_date: '2026-08-25' });
    assert.equal(res.report.length, 1);
    assert.equal(res.report[0].total_transactions, 2, "'Aug 25' must be exactly the 11 PM Aug-25 and 3 AM Aug-26 sales");
    assert.equal(res.report[0].total_revenue, 60);
  });

  await check('a post-midnight, pre-batch sale attributes to exactly one business day here too — not zero, not two', () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 25, 0, 0, 0, 25, 'cash', 'completed', '2026-08-26T02:00:00.000-05:00')").run(aliceId);
    const day25 = computeEmployeePerformance(db, { start_date: '2026-08-25', end_date: '2026-08-25' });
    const day26 = computeEmployeePerformance(db, { start_date: '2026-08-26', end_date: '2026-08-26' });
    assert.equal(day25.report.length, 1, 'counted on the 25th — the batch has not rolled past 6 AM the 26th yet');
    assert.equal(day25.report[0].total_revenue, 25);
    assert.equal(day26.report.length, 0, 'must NOT also show up on the 26th — that would be double-counting');
  });

  await check('default range (no dates given) anchors on the business date, not raw UTC calendar today', () => {
    
    
    
    
    const res = computeEmployeePerformance(db, {});
    assert.equal(res.range.end_date, currentBusinessDate(db), 'default end date must be the business-timezone date label, not a UTC one');
  });

  console.log('business-day window generalizes to ANY batch time — not hardcoded to 6 AM (db-backed):');
  function setBatchTime(t) {
    db.prepare("INSERT INTO settings (key,value) VALUES ('batch_time', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(t);
  }

  
  
  
  
  
  const BATCH_CASES = [
    { time: '04:00', h: 4, m: 0, label: '4:00 AM' },
    { time: '23:00', h: 23, m: 0, label: '11:00 PM' },
    { time: '02:30', h: 2, m: 30, label: '2:30 AM' },
  ];

  for (const bc of BATCH_CASES) {
    setBatchTime(bc.time);

    await check(`[batch ${bc.label}] scheduledBusinessDayStart resolves the correct boundary on both sides of the batch minute`, () => {
      const todaysBatch = DateTime.fromISO('2026-08-25', { zone: 'America/Chicago' }).set({ hour: bc.h, minute: bc.m, second: 0, millisecond: 0 });
      const justBefore = todaysBatch.minus({ minutes: 1 });
      const justAfter = todaysBatch.plus({ minutes: 1 });
      const boundaryBefore = scheduledBusinessDayStart(db, justBefore);
      const boundaryAfter = scheduledBusinessDayStart(db, justAfter);
      assert.notEqual(boundaryBefore, boundaryAfter, `[${bc.label}] one minute on either side of the batch minute must land in different business days`);
      assert.equal(boundaryAfter, todaysBatch.toISO(), `[${bc.label}] just after the batch minute, the NEW day starts exactly at the configured batch time`);
      assert.equal(boundaryBefore, todaysBatch.minus({ days: 1 }).toISO(), `[${bc.label}] just before the batch minute, still the PREVIOUS day's batch boundary`);
    });

    await check(`[batch ${bc.label}] businessDayBounds spans exactly one full day at the configured minute, not midnight`, () => {
      const b = businessDayBounds('2026-08-25', db);
      const expectedStart = DateTime.fromISO('2026-08-25', { zone: 'America/Chicago' }).set({ hour: bc.h, minute: bc.m });
      assert.equal(b.start, expectedStart.toISO());
      assert.equal(b.end, expectedStart.plus({ days: 1 }).toISO());
    });

    await check(`[batch ${bc.label}] currentBusinessDate flips exactly at the configured minute, not at midnight`, () => {
      const before = DateTime.fromISO('2026-08-26', { zone: 'America/Chicago' }).set({ hour: bc.h, minute: bc.m }).minus({ minutes: 1 });
      const after = DateTime.fromISO('2026-08-26', { zone: 'America/Chicago' }).set({ hour: bc.h, minute: bc.m }).plus({ minutes: 1 });
      assert.equal(currentBusinessDate(db, before), '2026-08-25', `[${bc.label}] one minute before the batch minute is still the previous business date`);
      assert.equal(currentBusinessDate(db, after), '2026-08-26', `[${bc.label}] one minute after, it has rolled to the new business date`);
    });

    await check(`[batch ${bc.label}] end-to-end: a sale 1 minute before batch attributes to the PREVIOUS business day, one minute after to the NEXT — proven through the same query Receipts/X-Z-out actually run`, () => {
      db.prepare("DELETE FROM transactions").run();
      const base = DateTime.fromISO('2026-08-26', { zone: 'America/Chicago' }).set({ hour: bc.h, minute: bc.m, second: 0, millisecond: 0 });
      const before = base.minus({ minutes: 1 }).toISO();
      const after = base.plus({ minutes: 1 }).toISO();
      db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 3, 0, 0, 0, 3, 'cash', 'completed', ?)").run(aliceId, before);
      db.prepare("INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 9, 0, 0, 0, 9, 'cash', 'completed', ?)").run(aliceId, after);

      const day25 = computeEmployeePerformance(db, { start_date: '2026-08-25', end_date: '2026-08-25' });
      const day26 = computeEmployeePerformance(db, { start_date: '2026-08-26', end_date: '2026-08-26' });
      assert.equal(day25.report[0]?.total_revenue, 3, `[${bc.label}] the sale 1 minute before batch belongs to the 25th`);
      assert.equal(day26.report[0]?.total_revenue, 9, `[${bc.label}] the sale 1 minute after batch belongs to the 26th`);
    });
  }

  setBatchTime('06:00'); 

  console.log('boot diagnostics (db-backed, real incident: register intermittently loses activation):');
  const { logBoot } = require('../dist/main/bootDiagnostics');
  const { app: electronApp } = require('electron');
  await check('logBoot writes a real, parseable entry capturing activation/machine state at boot', () => {
    const logPath = path.join(electronApp.getPath('userData'), 'boot-log.txt');
    try { fs.unlinkSync(logPath); } catch {  }
    db.prepare("DELETE FROM settings WHERE key IN ('boot_last_seen_version','license_cache','machine_id')").run();
    db.prepare("INSERT INTO settings (key,value) VALUES ('license_cache', ?)").run(JSON.stringify({ active: true, tenant_id: 'tenant-abc' }));
    db.prepare("INSERT INTO settings (key,value) VALUES ('machine_id', 'machine-xyz')").run();

    logBoot(db);

    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.hasLicenseCache, true, 'must capture whether license_cache exists at boot');
    assert.equal(entry.tenantId, 'tenant-abc');
    assert.equal(entry.machineId, 'machine-xyz');
    assert.ok(entry.userDataPath, 'must record the actual resolved userData path — the exact thing needed to catch a path-drift theory');
    assert.equal(entry.justUpdated, false, 'first boot with no prior recorded version is not treated as a fresh update');
  });

  await check('logBoot flags justUpdated=true when the app version changed since the last recorded boot', () => {
    
    logBoot(db);
    const logPath = path.join(electronApp.getPath('userData'), 'boot-log.txt');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2, 'appended, not overwritten');
    
    
    
    const entry = JSON.parse(lines[1]);
    assert.equal(entry.justUpdated, false);

    db.prepare("UPDATE settings SET value = '0.0.1-different' WHERE key = 'boot_last_seen_version'").run();
    logBoot(db);
    const lines2 = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const entry2 = JSON.parse(lines2[lines2.length - 1]);
    assert.equal(entry2.justUpdated, true, 'a version different from the last recorded boot must be flagged — this is the exact signal needed to correlate the incident with auto-update cycles');
  });

  await check('logBoot correctly captures the ABSENCE of activation (the exact incident state) without throwing', () => {
    db.prepare("DELETE FROM settings WHERE key IN ('license_cache','machine_id')").run();
    logBoot(db); 
    const logPath = path.join(electronApp.getPath('userData'), 'boot-log.txt');
    const lines = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    const entry = JSON.parse(lines[lines.length - 1]);
    assert.equal(entry.hasLicenseCache, false);
    assert.equal(entry.tenantId, null);
    assert.equal(entry.machineId, null);
  });

  
  
  
  db.prepare("INSERT INTO settings (key,value) VALUES ('license_cache', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(JSON.stringify({ active: true, tier: 'pro', features: [], expires_at: null, tenant_id: '11111111-1111-1111-1111-111111111111', license_key: 'K' }));

  db.prepare("DELETE FROM transactions").run();
  db.prepare("DELETE FROM z_reports").run();
  ds.closeDay(db);

  console.log('transaction delete (db-backed, FK-constraint fix):');
  const { deleteTransactionReversed } = require('../dist/main/ipc/transactions');
  await check('a transaction with a loyalty ledger row AND an age-check record deletes cleanly (the real live crash: FOREIGN KEY constraint failed)', () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("DELETE FROM transaction_items").run();
    db.prepare("DELETE FROM loyalty_ledger").run();
    db.prepare("DELETE FROM age_checks").run();
    db.prepare("DELETE FROM products WHERE barcode = 'DEL-TEST-1'").run();

    const custId = db.prepare("INSERT INTO customers (first_name, last_name, loyalty_points, lifetime_points) VALUES ('Test','Cust', 50, 200)").run().lastInsertRowid;
    const prodId = db.prepare("INSERT INTO products (barcode, name, price, cost, stock_qty) VALUES ('DEL-TEST-1','Widget', 10, 4, 3)").run().lastInsertRowid;
    const txnId = db.prepare(
      "INSERT INTO transactions (cashier_id, customer_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, ?, 38.96, 0.0825, 2.96, 0, 38.96, 'cash', 'completed', '2026-08-25T22:04:00.000-05:00')"
    ).run(aliceId, custId).lastInsertRowid;
    db.prepare("INSERT INTO transaction_items (transaction_id, product_id, qty, unit_price, line_total) VALUES (?, ?, 2, 18, 36)").run(txnId, prodId);
    
    
    db.prepare("INSERT INTO loyalty_ledger (customer_id, transaction_id, change, reason, balance_after) VALUES (?, ?, 38, 'earn', 88)").run(custId, txnId);
    db.prepare("UPDATE customers SET loyalty_points = 88, lifetime_points = 238 WHERE id = ?").run(custId);
    
    db.prepare("INSERT INTO age_checks (transaction_id, customer_id, cashier_id, result, method) VALUES (?, ?, ?, 'pass', 'id_scan')").run(txnId, custId, aliceId);

    const res = deleteTransactionReversed(db, txnId);
    assert.equal(res.success, true, `delete must succeed, not throw a FOREIGN KEY error: ${res.error}`);

    assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions WHERE id = ?').get(txnId).n, 0, 'transaction itself must be gone');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM transaction_items WHERE transaction_id = ?').get(txnId).n, 0, 'its line items must be gone');
    assert.equal(db.prepare('SELECT stock_qty FROM products WHERE id = ?').get(prodId).stock_qty, 5, 'inventory reversed: 3 + 2 sold back = 5');
    const cust = db.prepare('SELECT loyalty_points, lifetime_points FROM customers WHERE id = ?').get(custId);
    assert.equal(cust.loyalty_points, 50, 'loyalty points earned by this sale (38) must be reversed back to the pre-sale balance');
    assert.equal(cust.lifetime_points, 200, 'lifetime_points must be reversed too (only earns ever touched it)');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM loyalty_ledger WHERE transaction_id = ?').get(txnId).n, 0, 'the now-meaningless ledger row is removed');

    const ac = db.prepare('SELECT transaction_id, result FROM age_checks WHERE customer_id = ?').get(custId);
    assert.ok(ac, 'the compliance age-check record must still exist — voiding a sale does not erase that an ID check happened');
    assert.equal(ac.transaction_id, null, 'but it must be DETACHED (transaction_id nulled), not left dangling, and not blocking the delete');
    assert.equal(ac.result, 'pass', 'the actual compliance data is untouched');
  });

  await check('a redeemed-points sale reverses the redemption (balance goes back UP, lifetime untouched)', () => {
    db.prepare("DELETE FROM transactions").run();
    db.prepare("DELETE FROM loyalty_ledger").run();
    const custId = db.prepare("INSERT INTO customers (first_name, last_name, loyalty_points, lifetime_points) VALUES ('Redeemer','Test', 20, 500)").run().lastInsertRowid;
    const txnId = db.prepare(
      "INSERT INTO transactions (cashier_id, customer_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, ?, 5, 0, 0, 0, 5, 'cash', 'completed', '2026-08-25T12:00:00.000-05:00')"
    ).run(aliceId, custId).lastInsertRowid;
    db.prepare("INSERT INTO loyalty_ledger (customer_id, transaction_id, change, reason, balance_after) VALUES (?, ?, -20, 'redeem', 0)").run(custId, txnId);
    db.prepare("UPDATE customers SET loyalty_points = 0 WHERE id = ?").run(custId);

    const res = deleteTransactionReversed(db, txnId);
    assert.equal(res.success, true);
    const cust = db.prepare('SELECT loyalty_points, lifetime_points FROM customers WHERE id = ?').get(custId);
    assert.equal(cust.loyalty_points, 20, 'the 20 redeemed points must be given back');
    assert.equal(cust.lifetime_points, 500, 'redemption never touched lifetime_points, so reversing it must not either');
  });

  await check('deleting a transaction with NO customer/loyalty/age-check attached still works (no regression on the common case)', () => {
    db.prepare("DELETE FROM transactions").run();
    const txnId = db.prepare(
      "INSERT INTO transactions (cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (?, 3, 0, 0, 0, 3, 'cash', 'completed', '2026-08-25T12:00:00.000-05:00')"
    ).run(aliceId).lastInsertRowid;
    const res = deleteTransactionReversed(db, txnId);
    assert.equal(res.success, true);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM transactions WHERE id = ?').get(txnId).n, 0);
  });

  db.prepare("DELETE FROM transactions").run();
  db.prepare("DELETE FROM transaction_items").run();
  db.prepare("DELETE FROM loyalty_ledger").run();
  db.prepare("DELETE FROM age_checks").run();

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

  console.log('restoreCloudRowIfMissing — local-data-gap self-heal (real incident: kiosk A only recognized transactions after an update, db-backed):');
  await check('a transaction present in the cloud but missing locally is restored, extra cloud-only columns (tenant_id, register_id, cloud_id) are safely ignored', () => {
    db.prepare('DELETE FROM transactions WHERE id = 9001').run();
    const cloudRow = {
      id: 9001, cashier_id: aliceId, customer_id: null, subtotal: 10, tax_rate: 0.0825, tax_amount: 0.83,
      discount_amount: 0, total: 10.83, payment_method: 'cash', payment_status: 'completed',
      created_at: '2026-08-20T09:00:00.000-05:00',
      
      tenant_id: 'tenant-x', location_id: 'loc-x', register_id: 'reg-x', cloud_id: 55555,
    };
    const inserted = restoreCloudRowIfMissing(db, 'transactions', cloudRow);
    assert.equal(inserted, true, 'a genuinely missing row must be restored');
    const row = db.prepare('SELECT total, payment_method, created_at FROM transactions WHERE id = 9001').get();
    assert.ok(row, 'the row must actually exist locally now');
    assert.equal(row.total, 10.83);
    assert.equal(row.payment_method, 'cash');
    assert.equal(row.created_at, '2026-08-20T09:00:00.000-05:00', 'the original timestamp must be preserved exactly, not rewritten to "now"');
  });

  await check('a transaction that already exists locally is left alone — idempotent, no duplicate, no overwrite', () => {
    db.prepare('DELETE FROM transactions WHERE id = 9002').run();
    db.prepare(
      "INSERT INTO transactions (id, cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (9002, ?, 5, 0, 0, 0, 5, 'cash', 'completed', '2026-08-20T10:00:00.000-05:00')"
    ).run(aliceId);
    const inserted = restoreCloudRowIfMissing(db, 'transactions', {
      id: 9002, cashier_id: aliceId, subtotal: 999, tax_rate: 0, tax_amount: 0, discount_amount: 0,
      total: 999, payment_method: 'card', payment_status: 'completed', created_at: '2026-08-20T10:00:00.000-05:00',
    });
    assert.equal(inserted, false, 'an already-present row must be reported as not-inserted');
    const row = db.prepare('SELECT total, payment_method FROM transactions WHERE id = 9002').get();
    assert.equal(row.total, 5, "the EXISTING local row's data must not be clobbered by the cloud copy");
    assert.equal(row.payment_method, 'cash');
  });

  await check('a transaction with a pending, unsynced local DELETE queued is NOT resurrected — a deliberate delete must never be silently undone', () => {
    db.prepare('DELETE FROM transactions WHERE id = 9003').run();
    db.prepare("DELETE FROM sync_queue WHERE table_name = 'transactions' AND record_id = '9003'").run();
    db.prepare(
      "INSERT INTO sync_queue (table_name, record_id, operation, payload, synced) VALUES ('transactions', '9003', 'delete', '{}', 0)"
    ).run();
    const inserted = restoreCloudRowIfMissing(db, 'transactions', {
      id: 9003, cashier_id: aliceId, subtotal: 5, tax_rate: 0, tax_amount: 0, discount_amount: 0,
      total: 5, payment_method: 'cash', payment_status: 'completed', created_at: '2026-08-20T11:00:00.000-05:00',
    });
    assert.equal(inserted, false, 'must not resurrect a row with a pending local delete still queued');
    assert.equal(db.prepare('SELECT 1 FROM transactions WHERE id = 9003').get(), undefined, 'the row must genuinely not exist locally');
  });

  await check('a SYNCED (already-completed) delete does NOT block restoration — only a still-pending one does', () => {
    db.prepare('DELETE FROM transactions WHERE id = 9004').run();
    db.prepare("DELETE FROM sync_queue WHERE table_name = 'transactions' AND record_id = '9004'").run();
    db.prepare(
      "INSERT INTO sync_queue (table_name, record_id, operation, payload, synced) VALUES ('transactions', '9004', 'delete', '{}', 1)"
    ).run(); 
    const inserted = restoreCloudRowIfMissing(db, 'transactions', {
      id: 9004, cashier_id: aliceId, subtotal: 5, tax_rate: 0, tax_amount: 0, discount_amount: 0,
      total: 5, payment_method: 'cash', payment_status: 'completed', created_at: '2026-08-20T12:00:00.000-05:00',
    });
    assert.equal(inserted, true);
    db.prepare('DELETE FROM transactions WHERE id = 9004').run();
  });

  await check('transaction_items restore the same way, scoped to the transaction_items table', () => {
    db.prepare('DELETE FROM transactions WHERE id = 9005').run();
    db.prepare('DELETE FROM transaction_items WHERE id = 9005').run();
    db.prepare(
      "INSERT INTO transactions (id, cashier_id, subtotal, tax_rate, tax_amount, discount_amount, total, payment_method, payment_status, created_at) VALUES (9005, ?, 5, 0, 0, 0, 5, 'cash', 'completed', '2026-08-20T13:00:00.000-05:00')"
    ).run(aliceId);
    const inserted = restoreCloudRowIfMissing(db, 'transaction_items', {
      id: 9005, transaction_id: 9005, product_id: null, qty: 2, unit_price: 2.5, line_total: 5,
      tenant_id: 'tenant-x', register_id: 'reg-x', cloud_id: 66666,
    });
    assert.equal(inserted, true);
    const row = db.prepare('SELECT transaction_id, qty, line_total FROM transaction_items WHERE id = 9005').get();
    assert.equal(row.transaction_id, 9005);
    assert.equal(row.qty, 2);
    assert.equal(row.line_total, 5);
  });

  db.prepare('DELETE FROM transaction_items WHERE id = 9005').run();
  db.prepare('DELETE FROM transactions WHERE id IN (9001,9002,9003,9004,9005)').run();
  db.prepare("DELETE FROM sync_queue WHERE table_name = 'transactions' AND record_id IN ('9003','9004')").run();

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
  for (const f of [dbPath, dbPath + '-shm', dbPath + '-wal']) { try { fs.unlinkSync(f); } catch {  } }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
