/*
 * Part 1.5 — end-to-end auth + RLS verification.
 *
 * Fetches a JWT from the jwt-issuer Edge Function using TEST_LICENSE_KEY, then:
 *   A) reads the caller's own licenses row     -> expect SUCCESS
 *   B) inserts a row for a DIFFERENT tenant_id  -> expect BLOCKED by RLS
 *   C) reads with a foreign tenant filter        -> expect 0 rows
 *
 * Prereqs (none of which can be faked locally):
 *   - cloud migrations deployed (licenses + *_cloud tables exist)
 *   - jwt-issuer Edge Function deployed with SUPABASE_JWT_SECRET set
 *   - .env has SUPABASE_URL, SUPABASE_ANON_KEY, TEST_LICENSE_KEY
 *
 * Run:  npx tsc scripts/auth-demo.ts --outDir .tmp --module commonjs \
 *          --target ES2020 --esModuleInterop --skipLibCheck && node .tmp/auth-demo.js
 */
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';

// minimal .env loader
for (const line of (fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const LICENSE_KEY = process.env.TEST_LICENSE_KEY || '';

const FOREIGN_TENANT = '00000000-0000-0000-0000-000000000000';
const pass = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string) => console.log(`  FAIL  ${m}`);

function decodeTenant(jwt: string): string | null {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString()).tenant_id ?? null;
  } catch {
    return null;
  }
}

async function main() {
  if (!URL || !ANON || !LICENSE_KEY) {
    console.log('Missing SUPABASE_URL / SUPABASE_ANON_KEY / TEST_LICENSE_KEY in .env — cannot run.');
    process.exit(1);
  }

  console.log('1) Fetching JWT from jwt-issuer...');
  const res = await fetch(`${URL.replace(/\/$/, '')}/functions/v1/jwt-issuer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: JSON.stringify({ license_key: LICENSE_KEY }),
  });
  if (!res.ok) {
    fail(`token fetch -> ${res.status} ${await res.text().catch(() => '')}`);
    process.exit(1);
  }
  const { token } = (await res.json()) as { token: string };
  const myTenant = decodeTenant(token);
  pass(`token issued (tenant_id=${myTenant})`);

  const db = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${token}` } } });

  // A) read own licenses row
  const a = await db.from('licenses').select('tenant_id, license_key').eq('license_key', LICENSE_KEY);
  if (!a.error && a.data && a.data.length === 1) pass('A read own license row');
  else fail(`A read own license row -> ${a.error?.message ?? `${a.data?.length} rows`}`);

  // B) cross-tenant write must be rejected by RLS
  const b = await db.from('customers_cloud').insert({ id: 999999999, tenant_id: FOREIGN_TENANT, first_name: 'RLS' });
  if (b.error) pass(`B cross-tenant insert blocked (${b.error.code ?? 'error'})`);
  else fail('B cross-tenant insert was ALLOWED — RLS not enforced');

  // C) foreign-tenant read returns nothing
  const c = await db.from('customers_cloud').select('id').eq('tenant_id', FOREIGN_TENANT);
  if (!c.error && (c.data?.length ?? 0) === 0) pass('C foreign-tenant read returns 0 rows');
  else fail(`C foreign-tenant read -> ${c.error?.message ?? `${c.data?.length} rows leaked`}`);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
