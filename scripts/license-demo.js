/*
 * License engine demo — exercises computeStatusFrom() across every scenario so
 * the grace/expiry/lockdown behavior is visible without a live Supabase.
 *   npx electron scripts/license-demo.js
 */
const { computeStatusFrom } = require('../dist/main/supabase/licenseCheck');

const now = new Date('2026-06-28T12:00:00Z');
const hoursAgo = (h) => new Date(now.getTime() - h * 3.6e6);
const active = { active: true, tier: 'pro', features: ['sms', 'rebates'], expires_at: null };

const scenarios = [
  ['Supabase not configured', active, hoursAgo(1), false],
  ['Active, checked 1h ago', active, hoursAgo(1), true],
  ['Active, checked 50h ago (warn)', active, hoursAgo(50), true],
  ['Active, checked 80h ago (lock)', active, hoursAgo(80), true],
  ['License inactive (active=false)', { ...active, active: false }, hoursAgo(1), true],
  ['Expired (expires_at past)', { ...active, expires_at: '2026-01-01T00:00:00Z' }, hoursAgo(1), true],
  ['Configured, never cached', null, null, true],
];

const rows = scenarios.map(([name, cached, lastCheck, configured]) => {
  const s = computeStatusFrom(cached, lastCheck, configured, now);
  return {
    scenario: name,
    mode: s.mode,
    reason: s.reason,
    banner: s.banner.level,
    message: s.banner.message || '—',
  };
});

console.table(rows);
process.exit(0);
