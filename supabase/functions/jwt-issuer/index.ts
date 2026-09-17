


import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { create, getNumericDate } from 'https://deno.land/x/djwt@v3.0.2/mod.ts';

const TOKEN_TTL_SECONDS = 24 * 60 * 60; 
const RATE_LIMIT = 10; 
const RATE_WINDOW_MS = 60 * 1000; 


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

  let body: { license_key?: string; machine_id?: string; location_id?: string; list_locations?: boolean };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  
  
  
  
  
  
  
  
  
  
  const licenseKey = body?.license_key?.trim().toUpperCase();
  const machineId = body?.machine_id;
  const requestedLocation = body?.location_id?.trim() || null;
  const listLocations = body?.list_locations === true;
  if (!licenseKey) return json({ error: 'license_key is required' }, 400);

  if (rateLimited(licenseKey)) return json({ error: 'rate limit exceeded' }, 429);

  const url = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const jwtSecret = Deno.env.get('JWT_SECRET');
  if (!url || !serviceRole || !jwtSecret) {
    return json({ error: 'function not configured' }, 500);
  }

  
  const admin = createClient(url, serviceRole, { auth: { persistSession: false } });
  const { data: license, error } = await admin
    .from('licenses')
    .select('tenant_id, location_id, license_key, tier, features, active, max_registers, kind')
    .eq('license_key', licenseKey)
    .maybeSingle();

  if (error) return json({ error: error.message }, 500);
  if (!license || license.active !== true) {
    return json({ error: 'license invalid or inactive' }, 401);
  }

  const kind = (license.kind as string) ?? 'register';
  const isManager = kind === 'manager';
  const isBusiness = kind === 'business';

  
  
  
  if (listLocations) {
    const { data: locs, error: lErr } = await admin
      .from('locations')
      .select('id, name, is_storefront_enabled')
      .eq('tenant_id', license.tenant_id)
      .order('name', { ascending: true });
    if (lErr) return json({ error: lErr.message }, 500);
    return json({ locations: locs ?? [], kind, tenant_id: license.tenant_id }, 200);
  }

  
  
  
  
  
  let effectiveLocation: string | null;
  if (isBusiness) {
    if (requestedLocation) {
      const { data: loc, error: locErr } = await admin
        .from('locations')
        .select('id')
        .eq('id', requestedLocation)
        .eq('tenant_id', license.tenant_id)
        .maybeSingle();
      if (locErr) return json({ error: locErr.message }, 500);
      if (!loc) return json({ error: 'location does not belong to this business' }, 403);
      effectiveLocation = requestedLocation;
    } else {
      effectiveLocation = null; 
    }
  } else if (isManager) {
    effectiveLocation = null;
  } else {
    
    effectiveLocation = license.location_id ?? null;
    if (!effectiveLocation) return json({ error: 'license is not assigned to a location' }, 403);
  }

  
  
  if (machineId === 'manager') {
    return json({ error: 'invalid machine_id' }, 400);
  }

  
  
  
  
  
  const consumesSeat = !!machineId && !!effectiveLocation;
  if (consumesSeat) {
    const { data: regs, error: rErr } = await admin
      .from('license_registrations')
      .select('machine_id')
      .eq('license_key', licenseKey);
    if (rErr) return json({ error: rErr.message }, 500);

    const already = (regs ?? []).some((r) => r.machine_id === machineId);
    if (already) {
      await admin
        .from('license_registrations')
        .update({ last_seen_at: new Date().toISOString(), location_id: effectiveLocation })
        .eq('license_key', licenseKey)
        .eq('machine_id', machineId);
    } else {
      const max = Number(license.max_registers ?? 1);
      if ((regs ?? []).length >= max) {
        return json({ error: 'seat limit reached', max_registers: max }, 403);
      }
      await admin.from('license_registrations').insert({
        license_key: licenseKey,
        tenant_id: license.tenant_id,
        machine_id: machineId,
        location_id: effectiveLocation,
      });
    }
  }

  const exp = getNumericDate(TOKEN_TTL_SECONDS);
  const token = await signToken(jwtSecret, {
    
    role: 'authenticated',
    aud: 'authenticated',
    iat: getNumericDate(0),
    exp,
    
    tenant_id: license.tenant_id,
    
    
    location_id: effectiveLocation,
    
    register_id: machineId ?? null,
    
    kind,
    license_key: license.license_key,
    tier: license.tier,
    features: license.features ?? [],
  });

  return json({ token, expires_at: new Date(exp * 1000).toISOString() }, 200);
});
