/*
 * Supabase client smoke test. Shows configured/dormant state and runs a live
 * reachability probe. Run under Electron (so better-sqlite3, pulled in
 * transitively, matches its ABI):
 *
 *   npx electron scripts/supabase-check.js
 *
 * Reads SUPABASE_URL/SUPABASE_ANON_KEY (or the VITE_ variants) from the
 * environment or a project .env.
 */
const { getSupabase, isSupabaseConfigured, checkConnection } = require('../dist/main/supabase/client');

function mask(v) {
  if (!v) return '(unset)';
  if (/your-.*-here/i.test(v)) return `(placeholder: ${v})`;
  return v.length <= 12 ? v : `${v.slice(0, 8)}…${v.slice(-4)}`;
}

(async () => {
  console.log('URL :', mask(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL));
  console.log('KEY :', mask(process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY));
  console.log('isSupabaseConfigured():', isSupabaseConfigured());
  console.log('client:', getSupabase() ? 'created' : 'null (dormant)');
  console.log('checkConnection():', await checkConnection());
  process.exit(0);
})();
