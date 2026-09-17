
import { createClient } from '@supabase/supabase-js';
import fs from 'fs';


for (const line of (fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '').split(/\r?\n/)) {
  const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}

const URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || '';
const ANON = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || '';
const LICENSE_KEY = process.env.TEST_LICENSE_KEY || '';
const MACHINE_ID = 'verify-location-script'; 

const pass = (m: string) => console.log(`  PASS  ${m}`);
const fail = (m: string) => console.log(`  FAIL  ${m}`);

function decodeClaims(jwt: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
  } catch {
    return {};
  }
}

async function main() {
  if (!URL || !ANON || !LICENSE_KEY) {
    console.log('Missing SUPABASE_URL / SUPABASE_ANON_KEY / TEST_LICENSE_KEY in .env — cannot run.');
    process.exit(1);
  }

  console.log('1) Fetching JWT from jwt-issuer (with machine_id)...');
  const res = await fetch(`${URL.replace(/\/$/, '')}/functions/v1/jwt-issuer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: ANON, Authorization: `Bearer ${ANON}` },
    body: JSON.stringify({ license_key: LICENSE_KEY, machine_id: MACHINE_ID }),
  });
  if (!res.ok) {
    fail(`token fetch -> ${res.status} ${await res.text().catch(() => '')}`);
    process.exit(1);
  }
  const { token } = (await res.json()) as { token: string };
  const claims = decodeClaims(token);
  console.log('   claims:', JSON.stringify({
    tenant_id: claims.tenant_id, location_id: claims.location_id,
    register_id: claims.register_id, tier: claims.tier,
  }));

  
  if (claims.location_id) pass(`token carries location_id (${claims.location_id})`);
  else fail('token is MISSING location_id — is the redeployed jwt-issuer live?');
  if (claims.register_id === MACHINE_ID) pass('token carries register_id');
  else fail(`token register_id=${claims.register_id} (expected ${MACHINE_ID})`);

  const db = createClient(URL, ANON, { global: { headers: { Authorization: `Bearer ${token}` } } });

  
  const lic = await db.from('licenses').select('tenant_id, location_id').eq('license_key', LICENSE_KEY).maybeSingle();
  if (!lic.error && lic.data?.location_id) pass(`license row has location_id (${lic.data.location_id})`);
  else fail(`license location_id -> ${lic.error?.message ?? 'null (015 backfill did not run?)'}`);

  
  const loc = await db.from('locations').select('id, name').eq('id', String(claims.location_id)).maybeSingle();
  if (!loc.error && loc.data) pass(`locations row exists (name="${loc.data.name}")`);
  else fail(`locations read -> ${loc.error?.message ?? 'no row'}`);

  
  const cust = await db.from('customers_cloud').select('id, location_id').limit(5);
  if (!cust.error) {
    const foreign = (cust.data ?? []).filter((r) => r.location_id && r.location_id !== claims.location_id);
    if (foreign.length === 0) pass(`customers_cloud read scoped to location (${cust.data?.length ?? 0} row(s))`);
    else fail(`customers_cloud leaked ${foreign.length} row(s) from another location`);
  } else fail(`customers_cloud read -> ${cust.error.message}`);

  console.log('\nDone.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
