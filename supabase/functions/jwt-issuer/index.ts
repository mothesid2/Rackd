// Supabase Edge Function: jwt-issuer
//
// POST { "license_key": "..." }
//   -> validates the key is present + active in `licenses` (service role)
//   -> returns a signed JWT with tenant_id, license_key, tier, features (24h)
//
// Responses: 200 { token, expires_at } | 400 missing key | 401 invalid/inactive
// Rate limited to 10 requests/min per license_key (best-effort, per instance).
//
// Function env:
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY  — auto-injected in deployed functions
//   JWT_SECRET                               — set via `supabase secrets set JWT_SECRET=...`
//     (the project's legacy JWT secret; custom secrets can't be SUPABASE_-prefixed)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24 hours
const RATE_LIMIT = 10; // requests
const RATE_WINDOW_MS = 60 * 1000; // per minute, per license_key

// Best-effort in-memory rate limiter (resets when the instance recycles).
const hits = new Map<string, number[]>();
function rateLimited(key: string): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > RATE_LIMIT;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function signToken(secret: string, claims: Record<string, unknown>): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  return create({ alg: 'HS256', typ: 'JWT' }, claims, key);
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let licenseKey: string | undefined;
  try {
    licenseKey = (await req.json())?.license_key;
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!licenseKey) return json({ error: 'license_key is required' }, 400);

  if (rateLimited(licenseKey)) return json({ error: 'rate limit exceeded' }, 429);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!url || !serviceRole || !jwtSecret) {
    return json({ error: 'function not configured' }, 500);
  }

  // Validate the license with the service role (bypasses RLS).
  const admin = createClient(url, serviceRole, { auth: { persistSession: false } });
  const { data: license, error } = await admin
    .from('licenses')
    .select('tenant_id, license_key, tier, features, active')
    .eq('license_key', licenseKey)
    .maybeSingle();

  if (error) return json({ error: error.message }, 500);
  if (!license || license.active !== true) {
    return json({ error: 'license invalid or inactive' }, 401);
  }

  const exp = getNumericDate(TOKEN_TTL_SECONDS);
  const token = await signToken(jwtSecret, {
    // Claims Supabase RLS + PostgREST require:
    role: 'authenticated',
    aud: 'authenticated',
    iat: getNumericDate(0),
    exp,
    // Custom claims our RLS policies read:
    tenant_id: license.tenant_id,
    license_key: license.license_key,
    tier: license.tier,
    features: license.features ?? [],
  });

  return json({ token, expires_at: new Date(exp * 1000).toISOString() }, 200);
});
