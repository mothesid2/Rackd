/*
 * Rackd test harness — asserts the pure license + sync logic.
 * Run: npm test   (builds, then runs under Electron)
 */
const assert = require('assert');
const { computeStatusFrom } = require('../dist/main/supabase/licenseCheck');
const { isSyncAllowed, failureUpdate } = require('../dist/main/supabase/sync');

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  PASS  ' + name); }
  catch (e) { failed++; console.log('  FAIL  ' + name + '  — ' + e.message); }
}

const now = new Date('2026-07-02T12:00:00Z');
const hoursAgo = (h) => new Date(now.getTime() - h * 3.6e6);
const active = { active: true, tier: 'pro', features: [], expires_at: null, tenant_id: 't', license_key: 'k' };

console.log('license state machine:');
check('unconfigured -> full/unenforced', () => {
  const s = computeStatusFrom(active, hoursAgo(1), false, now);
  assert.equal(s.mode, 'full'); assert.equal(s.reason, 'unenforced'); assert.equal(s.readOnly, false);
});
check('active, checked 1h -> full/ok', () => {
  const s = computeStatusFrom(active, hoursAgo(1), true, now);
  assert.equal(s.mode, 'full'); assert.equal(s.reason, 'ok');
});
check('active, checked 50h -> grace_warning (still full)', () => {
  const s = computeStatusFrom(active, hoursAgo(50), true, now);
  assert.equal(s.reason, 'grace_warning'); assert.equal(s.readOnly, false); assert.equal(s.banner.level, 'warning');
});
check('active, checked 80h -> read_only/cache_expired', () => {
  const s = computeStatusFrom(active, hoursAgo(80), true, now);
  assert.equal(s.readOnly, true); assert.equal(s.reason, 'cache_expired');
});
check('inactive license -> read_only/invalid', () => {
  const s = computeStatusFrom({ ...active, active: false }, hoursAgo(1), true, now);
  assert.equal(s.readOnly, true); assert.equal(s.reason, 'invalid');
});
check('expired license -> read_only/expired', () => {
  const s = computeStatusFrom({ ...active, expires_at: '2020-01-01T00:00:00Z' }, hoursAgo(1), true, now);
  assert.equal(s.readOnly, true); assert.equal(s.reason, 'expired');
});
check('configured, never cached -> full/unlicensed (not bricked)', () => {
  const s = computeStatusFrom(null, null, true, now);
  assert.equal(s.mode, 'full'); assert.equal(s.reason, 'unlicensed'); assert.equal(s.readOnly, false);
});

console.log('sync policy:');
check('transactions insert allowed', () => assert.equal(isSyncAllowed('transactions', 'insert').allowed, true));
check('transactions update blocked', () => assert.equal(isSyncAllowed('transactions', 'update').allowed, false));
check('customers update allowed', () => assert.equal(isSyncAllowed('customers', 'update').allowed, true));
check('inventory update allowed', () => assert.equal(isSyncAllowed('inventory', 'update').allowed, true));
check('inventory insert blocked', () => assert.equal(isSyncAllowed('inventory', 'insert').allowed, false));
check('settings never synced', () => assert.equal(isSyncAllowed('settings', 'update').allowed, false));

console.log('dead-letter threshold:');
check('failureUpdate(0) -> attempts 1, not dead', () => {
  const r = failureUpdate(0); assert.equal(r.attempts, 1); assert.equal(r.dead_letter, false);
});
check('failureUpdate(4) -> attempts 5, dead-lettered', () => {
  const r = failureUpdate(4); assert.equal(r.attempts, 5); assert.equal(r.dead_letter, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
