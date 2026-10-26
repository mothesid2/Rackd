// Runs the onboarding/hardware migrations (081+) and their RLS tests against an embedded Postgres
// (PGlite) with a minimal Supabase-like stub, so no database or Docker is needed.
//   npm run test:sql
// It does NOT touch any real Supabase project.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..', 'supabase');
const order = [
  'tests/_local_stubs.sql',
  'migrations/081_platform_admin_audit_config.sql',
  'migrations/082_onboarding_tables.sql',
  'migrations/083_onboarding_storage.sql',
  'migrations/084_hardware_store.sql',
  'migrations/085_onboarding_functions.sql',
  'migrations/086_provisioning_permits.sql',
  'migrations/087_hardware_seed.sql',
  'migrations/088_agreement_ensure.sql',
  'migrations/089_hardware_orders_rpc.sql',
  'migrations/090_hardware_payments.sql',
  'migrations/091_admin_console.sql',
  'migrations/092_storefront_manager_core.sql',
  'migrations/093_storefront_reservations.sql',
  'migrations/094_storefront_backfill.sql',
  'migrations/095_storefront_outbox_worker.sql',
  'migrations/096_storefront_manager_reads.sql',
  'tests/onboarding_rls_tests.sql',
  'tests/storefront_manager_tests.sql',
  // demo seed: create, verify, remove, verify (all in the same scratch database)
  'seed/onboarding_demo.sql',
  'tests/seed_demo_check.sql',
  'seed/onboarding_demo_cleanup.sql',
  'tests/seed_demo_cleaned_check.sql',
];

(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto');
  const db = new PGlite({ extensions: { pgcrypto } });
  for (const f of order) {
    try {
      const res = await db.exec(fs.readFileSync(path.join(root, f), 'utf8'));
      const last = res[res.length - 1];
      const msg = last && last.rows && last.rows[0] && last.rows[0].result;
      console.log('ok  ', f, msg ? `=> ${msg}` : '');
    } catch (e) {
      console.error('FAIL', f, '\n    ', e.message);
      process.exit(1);
    }
  }
})();
