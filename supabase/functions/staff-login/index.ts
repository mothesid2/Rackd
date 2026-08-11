// staff-login — Manager Portal username/password sign-in (batch 3, item 1d).
//
// The portal is bound to a business once (with the business key). Managers then
// sign in with the SAME username + password they use for POS start-of-day. This
// validates the credential against employees_cloud (bcrypt) and mints the
// tenant-scoped JWT the portal already uses (kind='manager', no location claim).
//
// POST { license_key, username, password }
//   -> 200 { token, expires_at, must_change_password, name }
//   -> 401 invalid credential | 403 not a manager/admin
//
// Function env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto), JWT_SECRET.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';
import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';
import { rateLimited, clientIp } from '../_shared/rateLimit.ts';

const TOKEN_TTL_SECONDS = 12 * 60 * 60; // 12h portal session
// A password-verification endpoint with no limit at all is a standing
// brute-force target (audit batch 8, item 9) — two limits, since an
// attacker either hammers one known account from anywhere, or sprays many
// accounts from one IP.
const IP_LIMIT = 20, IP_WINDOW_MS = 5 * 60 * 1000;
const ACCOUNT_LIMIT = 8, ACCOUNT_WINDOW_MS = 5 * 60 * 1000;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

async function signToken(secret: string, claims: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return create({ alg: 'HS256', typ: 'JWT' }, claims, key);
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: { license_key?: string; username?: string; password?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const licenseKey = body.license_key?.trim();
  const username = body.username?.trim();
  const password = body.password ?? '';
  if (!licenseKey || !username || !password) return json({ error: 'license_key, username and password are required' }, 400);

  if (rateLimited(clientIp(req), IP_LIMIT, IP_WINDOW_MS)) return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  if (rateLimited(`${licenseKey}:${username.toLowerCase()}`, ACCOUNT_LIMIT, ACCOUNT_WINDOW_MS)) {
    return json({ error: 'Too many attempts for this account. Try again in a few minutes.' }, 429);
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!url || !serviceRole || !jwtSecret) return json({ error: 'function not configured' }, 500);

  const admin = createClient(url, serviceRole, { auth: { persistSession: false } });

  // Resolve the tenant from the business key.
  const { data: lic } = await admin.from('licenses').select('tenant_id, active, tier, features').eq('license_key', licenseKey).maybeSingle();
  if (!lic || lic.active !== true) return json({ error: 'business key invalid or inactive' }, 401);

  // Find the staff member in that tenant + verify the password.
  const { data: emp } = await admin.from('employees_cloud')
    .select('uid, name, role, password_hash, must_change_password, is_active')
    .eq('tenant_id', lic.tenant_id).eq('username', username).maybeSingle();
  if (!emp || emp.is_active === false || !emp.password_hash || !bcrypt.compareSync(password, emp.password_hash)) {
    return json({ error: 'Wrong username or password.' }, 401);
  }
  if (emp.role !== 'manager' && emp.role !== 'admin') {
    return json({ error: 'This account can’t sign in to the portal.' }, 403);
  }

  const exp = getNumericDate(TOKEN_TTL_SECONDS);
  const token = await signToken(jwtSecret, {
    role: 'authenticated', aud: 'authenticated', iat: getNumericDate(0), exp,
    tenant_id: lic.tenant_id,
    location_id: null,      // tenant-wide (portal sees every location)
    kind: 'manager',
    employee_uid: emp.uid,
    tier: lic.tier, features: lic.features ?? [],
  });
  return json({
    token, expires_at: new Date(exp * 1000).toISOString(),
    must_change_password: emp.must_change_password === true,
    name: emp.name ?? username,
  });
});
