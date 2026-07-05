// Supabase Edge Function: admin
//
// Owner-only tenant/license provisioning. Holds the service role (server-side)
// and is gated by a shared ADMIN_SECRET that only the owner console sends.
//
// POST { admin_secret, action, ...payload }
//   action: 'list' | 'create' | 'update' | 'delete' | 'setAds' | 'freeSeat'
//
// Function env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (auto-injected),
//               ADMIN_SECRET (set via `supabase secrets set ADMIN_SECRET=...`)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
function segment(n: number): string {
  let s = '';
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  for (const b of bytes) s += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return s;
}
function genKey(): string {
  return `RACKD-${segment(4)}-${segment(4)}-${segment(4)}`;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const adminSecret = Deno.env.get('ADMIN_SECRET');
  if (!adminSecret) return json({ error: 'admin not configured' }, 500);
  if (String(body.admin_secret || '') !== adminSecret) return json({ error: 'unauthorized' }, 401);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const action = String(body.action || '');
  try {
    switch (action) {
      case 'list': {
        const { data: licenses, error } = await admin
          .from('licenses')
          .select('id, name, license_key, tenant_id, active, tier, features, max_registers, expires_at, display_config, created_at')
          .order('created_at', { ascending: false });
        if (error) throw error;
        const { data: regs } = await admin.from('license_registrations').select('license_key');
        const used: Record<string, number> = {};
        for (const r of regs ?? []) used[r.license_key as string] = (used[r.license_key as string] || 0) + 1;
        return json({ licenses: (licenses ?? []).map((l) => ({ ...l, used_registers: used[l.license_key] || 0 })) });
      }

      case 'create': {
        const row = {
          name: (body.name as string) || null,
          license_key: (body.license_key as string)?.trim() || genKey(),
          tenant_id: crypto.randomUUID(),
          active: body.active !== false,
          tier: (body.tier as string) || 'standard',
          features: Array.isArray(body.features) ? body.features : [],
          max_registers: Math.max(1, Number(body.max_registers) || 1),
        };
        const { data, error } = await admin.from('licenses').insert(row).select().single();
        if (error) throw error;
        return json({ license: data });
      }

      case 'update': {
        const key = body.license_key as string;
        if (!key) return json({ error: 'license_key required' }, 400);
        const patch: Record<string, unknown> = {};
        for (const f of ['name', 'active', 'tier', 'max_registers', 'features', 'expires_at'] as const) {
          if (body[f] !== undefined) patch[f] = body[f];
        }
        if (patch.max_registers !== undefined) patch.max_registers = Math.max(1, Number(patch.max_registers) || 1);
        const { data, error } = await admin.from('licenses').update(patch).eq('license_key', key).select().single();
        if (error) throw error;
        return json({ license: data });
      }

      case 'setAds': {
        const key = body.license_key as string;
        if (!key) return json({ error: 'license_key required' }, 400);
        const { data, error } = await admin
          .from('licenses')
          .update({ display_config: body.display_config ?? {} })
          .eq('license_key', key)
          .select('license_key, display_config')
          .single();
        if (error) throw error;
        return json({ license: data });
      }

      case 'delete': {
        const key = body.license_key as string;
        if (!key) return json({ error: 'license_key required' }, 400);
        await admin.from('license_registrations').delete().eq('license_key', key);
        const { error } = await admin.from('licenses').delete().eq('license_key', key);
        if (error) throw error;
        return json({ ok: true });
      }

      case 'freeSeat': {
        const key = body.license_key as string;
        const machineId = body.machine_id as string;
        if (!key || !machineId) return json({ error: 'license_key + machine_id required' }, 400);
        const { error } = await admin
          .from('license_registrations')
          .delete()
          .eq('license_key', key)
          .eq('machine_id', machineId);
        if (error) throw error;
        return json({ ok: true });
      }

      default:
        return json({ error: `unknown action '${action}'` }, 400);
    }
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
