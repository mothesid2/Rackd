
const { getDb } = require('../dist/main/db/schema');
const { getSupabase } = require('../dist/main/supabase/client');
const { getTenantId, getLocationId, getRegisterId } = require('../dist/main/supabase/sync');
const { currentBusinessDayWindow } = require('../dist/main/utils/time');

(async () => {
  const db = getDb();
  const win = currentBusinessDayWindow(db);

  console.log('--- Local kiosk identity ---');
  console.log('register_id (this machine, right now):', getRegisterId(db));
  const locationId = getLocationId(db);
  console.log('location_id:', locationId);
  let tenantId;
  try { tenantId = getTenantId(db); } catch (e) { console.log('tenantId error:', e.message); process.exit(1); }
  console.log('tenant_id:', tenantId);
  console.log('business day window start:', win.start, '  end:', win.end || '(open, through now)');

  console.log("\n--- LOCAL (this kiosk's own transactions table) ---");
  const local = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS revenue
     FROM transactions WHERE created_at >= ? AND payment_status = 'completed'`
  ).get(win.start);
  console.log(local);

  const supabase = getSupabase();
  if (!supabase) { console.log('\nCloud not configured — cannot compare.'); process.exit(0); }
  if (!locationId) { console.log('\nNo location_id — cannot query cloud.'); process.exit(0); }

  console.log('\n--- CLOUD (transactions_cloud, this location, ALL registers, same window) ---');
  const { data, error } = await supabase
    .from('transactions_cloud')
    .select('id, register_id, total, created_at')
    .eq('tenant_id', tenantId)
    .eq('location_id', locationId)
    .eq('payment_status', 'completed')
    .gte('created_at', win.start);
  if (error) { console.log('error:', error.message); process.exit(1); }

  const byRegister = {};
  for (const row of data) {
    const r = row.register_id || '(none)';
    if (!byRegister[r]) byRegister[r] = { n: 0, revenue: 0 };
    byRegister[r].n++;
    byRegister[r].revenue += Number(row.total) || 0;
  }
  const cloudRevenue = data.reduce((s, r) => s + (Number(r.total) || 0), 0);
  console.log('Total cloud rows:', data.length, '  Total cloud revenue:', cloudRevenue.toFixed(2));
  console.log('\nBroken down by register_id — THE key check. Should be exactly ONE key here if this location is truly single-register:');
  console.log(JSON.stringify(byRegister, null, 2));

  console.log('\n--- DIFF ---');
  console.log('Local count:', local.n, '  Cloud count:', data.length, '  -> missing locally:', data.length - local.n);
  console.log('Local revenue:', local.revenue.toFixed(2), '  Cloud revenue:', cloudRevenue.toFixed(2), '  -> delta:', (cloudRevenue - local.revenue).toFixed(2));
  process.exit(0);
})();
