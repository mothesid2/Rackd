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
  'tests/onboarding_rls_tests.sql',
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
