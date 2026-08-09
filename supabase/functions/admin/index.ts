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
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Readable random password for the delivered admin credential (bcrypt-hashed to
// employees_cloud; the admin must change it on first login).
function genPassword(): string {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const a = 'abcdefghijkmnpqrstuvwxyz';
  const d = '23456789';
  const pick = (s: string, n: number) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => s[b % s.length]).join('');
  return `${pick(A, 2)}${pick(a, 4)}-${pick(d, 4)}`;
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

// 4-digit PIN for a cashier's register sign-in (duplicates allowed — the
// register picks the person by name first, then the PIN — mirrors genUniquePin
// in src/main/ipc/permissions.ts).
function genPin4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return Array.from(bytes, (b) => String(b % 10)).join('');
}

const UPDATE_BUCKET = 'app-updates';
// Electron apps that publish via the update bucket. Layout: <app>/<channel>/…
const PUBLISHABLE_APPS = ['pos', 'manager', 'owner'] as const;

// deno-lint-ignore no-explicit-any
async function readYmlVersion(admin: any, path: string): Promise<string | null> {
  try {
    const { data, error } = await admin.storage.from(UPDATE_BUCKET).download(path);
    if (error || !data) return null;
    const m = (await data.text()).match(/^version:\s*(.+)$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
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
          // NOTE: do NOT select twilio_account_sid/twilio_from_number here — this
          // is the core business-list fetch every Owner Console screen depends on,
          // and those columns only exist once migration 051 is applied (deploy-051.sql,
          // still pending as of 2026-07-24). Selecting them before the migration runs
          // 500s this ENTIRE action, which is why the Owner Console showed no
          // businesses at all — a real incident, root-caused live 2026-07-24. The
          // Twilio section's Save action can 42703 safely (contained, one field) but
          // the list must never depend on a column that might not exist yet.
          .select('id, name, license_key, tenant_id, location_id, kind, active, tier, features, max_registers, expires_at, display_config, contact_email, contact_phone, created_at')
          .order('created_at', { ascending: false });
        if (error) throw error;
        const { data: regs } = await admin.from('license_registrations').select('license_key');
        const used: Record<string, number> = {};
        for (const r of regs ?? []) used[r.license_key as string] = (used[r.license_key as string] || 0) + 1;
        // Location names for the Tenant → Location → Register hierarchy in the UI.
        const { data: locs } = await admin.from('locations').select('id, name');
        const locName: Record<string, string> = {};
        for (const l of locs ?? []) locName[l.id as string] = l.name as string;
        return json({
          licenses: (licenses ?? []).map((l) => ({
            ...l,
            used_registers: used[l.license_key] || 0,
            location_name: l.location_id ? locName[l.location_id as string] || null : null,
          })),
        });
      }

      case 'create': {
        const kind = (body.kind as string) === 'manager' ? 'manager' : 'register';

        // A manager credential is tenant-wide: it belongs to an existing business
        // and has NO location (its JWT omits location_id -> reads/writes every
        // location in the tenant). It does not create a location row.
        if (kind === 'manager') {
          const tenantId = (body.tenant_id as string)?.trim();
          if (!tenantId) return json({ error: 'a manager code needs an existing business (tenant_id)' }, 400);
          const row = {
            name: (body.name as string)?.trim() || 'Manager',
            license_key: (body.license_key as string)?.trim() || genKey(),
            tenant_id: tenantId,
            location_id: null,
            kind: 'manager',
            active: body.active !== false,
            tier: (body.tier as string) || 'standard',
            features: Array.isArray(body.features) ? body.features : [],
            max_registers: 0,
          };
          const { data, error } = await admin.from('licenses').insert(row).select().single();
          if (error) throw error;
          return json({ license: data });
        }

        // A location code belongs to a business (tenant): reuse tenant_id to add a
        // location to an existing business, or mint a new one. Each code = one
        // location, so we create the location row and link it here.
        const tenantId = (body.tenant_id as string)?.trim() || crypto.randomUUID();
        const locName = (body.location_name as string)?.trim() || (body.name as string)?.trim() || 'Store';
        const { data: loc, error: locErr } = await admin
          .from('locations')
          .insert({ tenant_id: tenantId, name: locName })
          .select('id')
          .single();
        if (locErr) throw locErr;

        const row = {
          name: (body.name as string)?.trim() || locName,
          license_key: (body.license_key as string)?.trim() || genKey(),
          tenant_id: tenantId,
          location_id: loc.id,
          kind: 'register',
          active: body.active !== false,
          tier: (body.tier as string) || 'standard',
          features: Array.isArray(body.features) ? body.features : [],
          max_registers: Math.max(1, Number(body.max_registers) || 1),
        };
        const { data, error } = await admin.from('licenses').insert(row).select().single();
        if (error) throw error;
        return json({ license: data });
      }

      // Business-key model: one key for the whole business + N locations. The POS
      // activates with this key and picks a location; the Owner Console activates
      // with it and sees every location. max_registers = total kiosks allowed
      // across all the business's locations.
      case 'createBusiness': {
        const bizName = (body.name as string)?.trim() || 'Business';
        // Guard against a repeat of 2026-07-24's "BB Business LLC" duplicate-tenant
        // incident: two clicks (or a retry after a slow response) on "+ New
        // business" silently produced two separate tenants under the same name,
        // one of which orphaned real activity. Case-insensitive on the business
        // (kind='business') license row's name — per-location names aren't
        // checked, only the business identity itself.
        const { data: dupe } = await admin
          .from('licenses')
          .select('tenant_id')
          .eq('kind', 'business')
          .ilike('name', bizName)
          .maybeSingle();
        if (dupe) return json({ error: `A business named "${bizName}" already exists.` }, 409);

        const tenantId = (body.tenant_id as string)?.trim() || crypto.randomUUID();
        const rawLocs = Array.isArray(body.locations) ? body.locations : [];
        const locNames = rawLocs
          .map((l) => (typeof l === 'string' ? l : (l as { name?: string })?.name) || '')
          .map((n) => String(n).trim())
          .filter(Boolean);
        if (locNames.length === 0) locNames.push((body.name as string)?.trim() || 'Store');

        const { data: locs, error: locErr } = await admin
          .from('locations')
          .insert(locNames.map((name) => ({ tenant_id: tenantId, name })))
          .select('id, name');
        if (locErr) throw locErr;

        const row = {
          name: bizName,
          license_key: (body.license_key as string)?.trim() || genKey(),
          tenant_id: tenantId,
          location_id: null,
          kind: 'business',
          active: body.active !== false,
          tier: (body.tier as string) || 'standard',
          features: Array.isArray(body.features) ? body.features : [],
          max_registers: Math.max(1, Number(body.max_registers) || locNames.length),
        };
        const { data, error } = await admin.from('licenses').insert(row).select().single();
        if (error) throw error;

        // Provision the business ADMIN credential (delivered to the client at
        // onboarding). Business-wide (location_id null) so every kiosk can use it;
        // must change the password on first login. Synced to the POS on activation.
        const adminUsername = (body.admin_username as string)?.trim() || 'admin';
        const adminPassword = genPassword();
        const adminHash = bcrypt.hashSync(adminPassword, 10);
        await admin.from('employees_cloud').insert({
          uid: crypto.randomUUID(), tenant_id: tenantId, location_id: null,
          username: adminUsername, name: (body.name as string)?.trim() || 'Admin', role: 'admin',
          password_hash: adminHash, is_active: true, must_change_password: true, must_change_pin: false,
        });

        return json({
          license: data, tenant_id: tenantId, locations: locs ?? [],
          admin: { username: adminUsername, password: adminPassword },
        });
      }

      // List a business's locations with seat usage (owner console location manager).
      // Full detail (address/zip/tax/contact) so the "Business" view (item 16) can
      // show + edit everything about a location in one place.
      case 'locations': {
        const tenantId = (body.tenant_id as string)?.trim();
        if (!tenantId) return json({ error: 'tenant_id required' }, 400);
        const { data: locs, error } = await admin
          .from('locations')
          .select('id, name, is_storefront_enabled, address, zip, tax_rate, phone, email, logo_url, show_logo, created_at')
          .eq('tenant_id', tenantId)
          .order('name', { ascending: true });
        if (error) throw error;
        const { data: regs } = await admin
          .from('license_registrations')
          .select('machine_id, location_id, last_seen_at')
          .eq('tenant_id', tenantId);
        const byLoc: Record<string, number> = {};
        for (const r of regs ?? []) if (r.location_id) byLoc[r.location_id as string] = (byLoc[r.location_id as string] || 0) + 1;
        return json({ locations: (locs ?? []).map((l) => ({ ...l, kiosk_count: byLoc[l.id as string] || 0 })) });
      }

      case 'addLocation': {
        const tenantId = (body.tenant_id as string)?.trim();
        const name = (body.name as string)?.trim();
        if (!tenantId || !name) return json({ error: 'tenant_id + name required' }, 400);
        const { data, error } = await admin
          .from('locations')
          .insert({ tenant_id: tenantId, name })
          .select('id, name')
          .single();
        if (error) throw error;
        // Address (item 10) can be supplied right away at initial shop setup.
        if (body.address || body.zip) {
          await admin.rpc('set_location_address', {
            p_location: data.id, p_address: (body.address as string) || null, p_zip: (body.zip as string) || null,
          });
        }
        return json({ location: data });
      }

      case 'renameLocation': {
        const locationId = (body.location_id as string)?.trim();
        const name = (body.name as string)?.trim();
        if (!locationId || !name) return json({ error: 'location_id + name required' }, 400);
        const { data, error } = await admin
          .from('locations')
          .update({ name })
          .eq('id', locationId)
          .select('id, name')
          .single();
        if (error) throw error;
        return json({ location: data });
      }

      // Owner-only: set (or correct) a location's address — tax_rate is recomputed
      // from the ZIP in the same call (item 10 + item 11). Flows down to the POS
      // and the Manager Portal automatically from here; neither can edit it.
      case 'setLocationAddress': {
        const locationId = (body.location_id as string)?.trim();
        if (!locationId) return json({ error: 'location_id required' }, 400);
        const { data, error } = await admin.rpc('set_location_address', {
          p_location: locationId, p_address: (body.address as string) ?? null, p_zip: (body.zip as string) ?? null,
        });
        if (error) throw error;
        return json({ location: data });
      }

      // Owner-only: real merchant/card-processing rate for this location
      // (batch 5 legal rework) — used both to compute the actual tip-pool
      // deduction and an estimated processing-cost line on revenue reports.
      // Isolated on purpose: never added to the `list`/`locations` SELECTs
      // that every other screen depends on, so a save here can 42703 safely
      // (contained) before migration 052 is applied, instead of repeating the
      // 2026-07-24 outage where a premature column reference broke the whole
      // business list.
      case 'setLocationMerchantFee': {
        const locationId = (body.location_id as string)?.trim();
        if (!locationId) return json({ error: 'location_id required' }, 400);
        const clampPct = (v: unknown) => Math.max(0, Math.min(100, Number(v) || 0));
        const creditPct = clampPct(body.merchant_fee_credit_pct);
        const debitPct = clampPct(body.merchant_fee_debit_pct);
        const flatCents = Math.max(0, Math.round(Number(body.merchant_fee_flat_cents) || 0));
        const { data, error } = await admin
          .from('locations').update({
            merchant_fee_credit_pct: creditPct, merchant_fee_debit_pct: debitPct, merchant_fee_flat_cents: flatCents,
          }).eq('id', locationId)
          .select('id, merchant_fee_credit_pct, merchant_fee_debit_pct, merchant_fee_flat_cents').single();
        if (error) throw error;
        return json({ location: data });
      }

      // Owner-only: store-level contact info (item 17).
      case 'setLocationContact': {
        const locationId = (body.location_id as string)?.trim();
        if (!locationId) return json({ error: 'location_id required' }, 400);
        const { data, error } = await admin.rpc('set_location_contact', {
          p_location: locationId, p_phone: (body.phone as string) ?? null, p_email: (body.email as string) ?? null,
        });
        if (error) throw error;
        return json({ location: data });
      }

      // Owner-only: business/owner-level contact info, stored on the business's
      // own license row (kind='business') (item 17).
      case 'setBusinessContact': {
        const tenantId = (body.tenant_id as string)?.trim();
        if (!tenantId) return json({ error: 'tenant_id required' }, 400);
        const patch: Record<string, unknown> = {};
        if (body.contact_email !== undefined) patch.contact_email = body.contact_email;
        if (body.contact_phone !== undefined) patch.contact_phone = body.contact_phone;
        const { data, error } = await admin
          .from('licenses').update(patch).eq('tenant_id', tenantId).eq('kind', 'business')
          .select('tenant_id, contact_email, contact_phone').maybeSingle();
        if (error) throw error;
        return json({ business: data });
      }

      // Owner-only: Twilio SMS config, moved out of POS Settings entirely — same
      // owner-only treatment as address/tax rate and contact info above.
      case 'setTwilioConfig': {
        const tenantId = (body.tenant_id as string)?.trim();
        if (!tenantId) return json({ error: 'tenant_id required' }, 400);
        const patch: Record<string, unknown> = {};
        if (body.twilio_account_sid !== undefined) patch.twilio_account_sid = body.twilio_account_sid || null;
        if (body.twilio_auth_token !== undefined) patch.twilio_auth_token = body.twilio_auth_token || null;
        if (body.twilio_from_number !== undefined) patch.twilio_from_number = body.twilio_from_number || null;
        const { data, error } = await admin
          .from('licenses').update(patch).eq('tenant_id', tenantId).eq('kind', 'business')
          .select('tenant_id, twilio_account_sid, twilio_from_number').maybeSingle();
        if (error) throw error;
        return json({ business: data });
      }

      // Owner-only: edit a business's enabled feature flags (item 17).
      case 'setFeatures': {
        const tenantId = (body.tenant_id as string)?.trim();
        const features = Array.isArray(body.features) ? body.features : null;
        if (!tenantId || !features) return json({ error: 'tenant_id + features[] required' }, 400);
        const { data, error } = await admin
          .from('licenses').update({ features }).eq('tenant_id', tenantId).eq('kind', 'business')
          .select('tenant_id, features').maybeSingle();
        if (error) throw error;
        return json({ business: data });
      }

      // Owner-only: create a manager account directly (bypasses the POS's 60s
      // sync entirely, so it's usable in the Manager Portal immediately — a second,
      // more reliable provisioning path alongside POS-side creation, item 1 + 17).
      // Owner-only: create a staff account directly (bypasses the POS's 60s sync
      // entirely, so it's usable immediately — a second, more reliable
      // provisioning path alongside POS-side creation, item 1 + item 11). Covers
      // both roles: a manager (username+password, for the Manager Portal + POS
      // start-of-day) and a cashier (name+PIN, for register sign-in only — no
      // portal access). 'createManager' kept as an alias for the pre-existing
      // manager-only call sites.
      case 'createManager':
      case 'createStaffUser': {
        const tenantId = (body.tenant_id as string)?.trim();
        const isCashier = (body.role as string) === 'cashier';
        const name = (body.name as string)?.trim();
        if (!tenantId) return json({ error: 'tenant_id required' }, 400);
        const uid = crypto.randomUUID();

        if (isCashier) {
          if (!name) return json({ error: 'name required' }, 400);
          const pin = genPin4();
          const pinHash = bcrypt.hashSync(pin, 10);
          const { error } = await admin.from('employees_cloud').insert({
            uid, tenant_id: tenantId, location_id: null, username: null, name, role: 'cashier',
            pin_hash: pinHash, is_active: true, must_change_password: false, must_change_pin: true,
          });
          if (error) throw error;
          await admin.from('owner_audit_log').insert({
            tenant_id: tenantId, action: 'create_cashier', target_uid: uid, target_label: name, detail: {},
          });
          return json({ uid, name, role: 'cashier', pin });
        }

        const username = (body.username as string)?.trim();
        const managerName = name || username;
        if (!username) return json({ error: 'tenant_id + username required' }, 400);
        const { data: existing } = await admin.from('employees_cloud')
          .select('uid').eq('tenant_id', tenantId).eq('username', username).maybeSingle();
        if (existing) return json({ error: 'That username is already taken on this business.' }, 400);
        const password = genPassword();
        const passwordHash = bcrypt.hashSync(password, 10);
        // FIX: this insert never set pin_hash (and set must_change_pin: false, so
        // the normal forced-first-login flow would never prompt for one either) —
        // a manager created here was permanently PIN-less, silently invisible from
        // every kiosk's "who's signing in" list forever (auth:listPinUsers requires
        // a non-empty pin_hash). Every other manager-creation path (perms.ts
        // saveEmployee, this same function's cashier branch above) already
        // generates one; this just brings Owner Console in line with that.
        const pin = genPin4();
        const pinHash = bcrypt.hashSync(pin, 10);
        const { error } = await admin.from('employees_cloud').insert({
          uid, tenant_id: tenantId, location_id: null, username, name: managerName, role: 'manager',
          password_hash: passwordHash, pin_hash: pinHash, is_active: true, must_change_password: true, must_change_pin: true,
        });
        if (error) throw error;
        await admin.from('owner_audit_log').insert({
          tenant_id: tenantId, action: 'create_manager', target_uid: uid, target_label: username, detail: {},
        });
        return json({ uid, username, name: managerName, role: 'manager', password, pin });
      }

      // List a business's kiosks (registered machines) with their location + any
      // pending remote-reset command. Powers the Owner Console kiosk manager.
      case 'kiosks': {
        const tenantId = (body.tenant_id as string)?.trim();
        if (!tenantId) return json({ error: 'tenant_id required' }, 400);
        const { data: regs, error } = await admin
          .from('license_registrations')
          .select('machine_id, location_id, last_seen_at, activated_at, license_key')
          .eq('tenant_id', tenantId)
          .order('last_seen_at', { ascending: false });
        if (error) throw error;
        const { data: locs } = await admin.from('locations').select('id, name').eq('tenant_id', tenantId);
        const locName: Record<string, string> = {};
        for (const l of locs ?? []) locName[l.id as string] = l.name as string;
        const { data: cmds } = await admin
          .from('register_commands')
          .select('machine_id, command, status, note, created_at, acked_at')
          .eq('tenant_id', tenantId)
          .in('status', ['pending', 'acked', 'blocked'])
          .order('created_at', { ascending: false });
        const cmdOf: Record<string, unknown> = {};
        for (const c of cmds ?? []) if (!cmdOf[c.machine_id as string]) cmdOf[c.machine_id as string] = c;
        return json({
          kiosks: (regs ?? []).map((r) => ({
            ...r,
            location_name: r.location_id ? locName[r.location_id as string] || null : null,
            pending_command: cmdOf[r.machine_id as string] || null,
          })),
        });
      }

      // Queue a remote reset for a specific kiosk. The POS applies it on its next
      // sync cycle (flush-then-reset, deferred past an open day). One live command
      // per kiosk: supersede any existing pending/acked one.
      case 'resetKiosk': {
        const tenantId = (body.tenant_id as string)?.trim();
        const machineId = (body.machine_id as string)?.trim();
        if (!tenantId || !machineId) return json({ error: 'tenant_id + machine_id required' }, 400);
        await admin.from('register_commands')
          .update({ status: 'cancelled' })
          .eq('tenant_id', tenantId).eq('machine_id', machineId).in('status', ['pending', 'acked', 'blocked']);
        const { data, error } = await admin.from('register_commands')
          .insert({ tenant_id: tenantId, machine_id: machineId, command: 'reset', status: 'pending' })
          .select('id').single();
        if (error) throw error;
        return json({ ok: true, command_id: data.id });
      }

      case 'cancelReset': {
        const tenantId = (body.tenant_id as string)?.trim();
        const machineId = (body.machine_id as string)?.trim();
        if (!tenantId || !machineId) return json({ error: 'tenant_id + machine_id required' }, 400);
        const { error } = await admin.from('register_commands')
          .update({ status: 'cancelled' })
          .eq('tenant_id', tenantId).eq('machine_id', machineId).in('status', ['pending', 'acked', 'blocked']);
        if (error) throw error;
        return json({ ok: true });
      }

      // Online orders overview (Owner Console) — tenant-wide (or all businesses).
      case 'onlineOrders': {
        const tenantId = (body.tenant_id as string)?.trim() || null;
        let q = admin.from('online_orders')
          .select('id, order_number, tenant_id, location_id, status, subtotal, tax, total, created_at, ready_at, online_order_items(name, qty)')
          .order('created_at', { ascending: false })
          .limit(200);
        if (tenantId) q = q.eq('tenant_id', tenantId);
        const { data: orders, error } = await q;
        if (error) throw error;
        const { data: locs } = await admin.from('locations').select('id, name');
        const locName: Record<string, string> = {};
        for (const l of locs ?? []) locName[l.id as string] = l.name as string;
        return json({ orders: (orders ?? []).map((o) => ({ ...o, location_name: locName[o.location_id as string] || null })) });
      }

      // What version each app has on staging vs production (Publish hub).
      case 'publishStatus': {
        const apps = [];
        for (const a of PUBLISHABLE_APPS) {
          apps.push({
            app: a,
            staging_version: await readYmlVersion(admin, `${a}/staging/latest.yml`),
            production_version: await readYmlVersion(admin, `${a}/production/latest.yml`),
          });
        }
        return json({ apps });
      }

      // Promote an app's STAGING build to PRODUCTION (clients update on next launch).
      // Copies every file under <app>/staging/ to <app>/production/ (overwrite).
      // Storefront is a web deploy — POSTs a configured deploy hook instead.
      case 'publish': {
        const appId = String(body.app || '');
        if (appId === 'storefront') {
          const hook = Deno.env.get('STOREFRONT_DEPLOY_HOOK');
          if (!hook) return json({ error: 'Storefront deploy hook not set. Add the STOREFRONT_DEPLOY_HOOK secret (your Vercel deploy hook URL).' }, 400);
          const r = await fetch(hook, { method: 'POST' });
          return json({ ok: r.ok, storefront: true });
        }
        if (!(PUBLISHABLE_APPS as readonly string[]).includes(appId)) return json({ error: `unknown app '${appId}'` }, 400);
        const { data: files, error: lErr } = await admin.storage.from(UPDATE_BUCKET).list(`${appId}/staging`, { limit: 200 });
        if (lErr) throw lErr;
        const real = (files ?? []).filter((f: { name: string; id: string | null }) => f.id !== null); // skip folder rows
        if (real.length === 0) return json({ error: `Nothing on ${appId} staging to publish yet.` }, 400);
        for (const f of real) {
          const from = `${appId}/staging/${f.name}`;
          const to = `${appId}/production/${f.name}`;
          const { data: blob, error: dErr } = await admin.storage.from(UPDATE_BUCKET).download(from);
          if (dErr) throw dErr;
          const buf = new Uint8Array(await blob.arrayBuffer());
          const { error: uErr } = await admin.storage.from(UPDATE_BUCKET).upload(to, buf, {
            upsert: true, contentType: f.name.endsWith('.yml') ? 'text/yaml' : 'application/octet-stream',
          });
          if (uErr) throw uErr;
        }
        return json({ ok: true, app: appId, promoted: real.length });
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
        // Keep the linked location's name in sync when the owner renames it.
        if (body.location_name !== undefined && data?.location_id) {
          await admin.from('locations').update({ name: String(body.location_name) }).eq('id', data.location_id);
        }
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
        // Remove the linked location too (one code = one location).
        const { data: lic } = await admin.from('licenses').select('location_id').eq('license_key', key).maybeSingle();
        await admin.from('license_registrations').delete().eq('license_key', key);
        const { error } = await admin.from('licenses').delete().eq('license_key', key);
        if (error) throw error;
        if (lic?.location_id) await admin.from('locations').delete().eq('id', lic.location_id);
        return json({ ok: true });
      }

      // Delete an ENTIRE business (batch 5): every license (business + any
      // manager/register codes), every location, every employee, and kiosk
      // registration for the tenant. Unlike `delete` above (single license_key,
      // written for the old one-license-per-location model where a business
      // license's location_id was always set), this is tenant-scoped — the
      // current business-key model leaves location_id null on the business
      // license, so `delete` alone would silently orphan the location and
      // every employee. Built specifically so an accidental duplicate business
      // (see 2026-07-24's "BB Business LLC" duplicate-tenant incident) can be
      // cleaned up from the UI instead of needing a hand-run SQL script.
      case 'deleteBusiness': {
        const tenantId = (body.tenant_id as string)?.trim();
        if (!tenantId) return json({ error: 'tenant_id required' }, 400);
        const { data: biz } = await admin.from('licenses').select('name').eq('tenant_id', tenantId).eq('kind', 'business').maybeSingle();
        if (!biz) return json({ error: 'business not found' }, 404);
        await admin.from('license_registrations').delete().eq('tenant_id', tenantId);
        await admin.from('employee_permissions_cloud').delete().eq('tenant_id', tenantId);
        await admin.from('time_clock_cloud').delete().eq('tenant_id', tenantId);
        await admin.from('employees_cloud').delete().eq('tenant_id', tenantId);
        await admin.from('locations').delete().eq('tenant_id', tenantId);
        const { error } = await admin.from('licenses').delete().eq('tenant_id', tenantId);
        if (error) throw error;
        return json({ ok: true, name: biz.name });
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

      // spec §4 — cross-store aggregation for the owner "All Stores" dashboard.
      // Aggregates the per-tenant cloud mirrors across every license (each license
      // = one store). Reporting-only; local SQLite remains each store's truth.
      case 'aggregate': {
        const now = new Date();
        const end = body.end ? new Date(String(body.end)) : now;
        const start = body.start ? new Date(String(body.start)) : new Date(end.getTime() - 7 * 86400000);
        const windowMs = Math.max(1, end.getTime() - start.getTime());
        const priorStart = new Date(start.getTime() - windowMs);

        const { data: licenses } = await admin.from('licenses').select('name, tenant_id, active');
        const nameOf: Record<string, string> = {};
        const activeOf: Record<string, boolean> = {};
        for (const l of licenses ?? []) {
          if (l.tenant_id) { nameOf[l.tenant_id] = l.name || 'Store'; activeOf[l.tenant_id] = l.active !== false; }
        }

        const iso = (d: Date) => d.toISOString();
        const [cur, prev, tops, last] = await Promise.all([
          admin.rpc('store_sales_agg', { p_start: iso(start), p_end: iso(end) }),
          admin.rpc('store_sales_agg', { p_start: iso(priorStart), p_end: iso(start) }),
          admin.rpc('store_top_skus', { p_start: iso(start), p_end: iso(end), p_limit: 5 }),
          admin.rpc('store_last_activity', {}),
        ]);

        // deno-lint-ignore no-explicit-any
        const byTenant = <T>(rows: any[], key = 'tenant_id') => {
          const m: Record<string, T> = {}; for (const r of rows ?? []) m[r[key]] = r; return m;
        };
        const prevBy = byTenant<any>(prev.data ?? []);
        const lastBy: Record<string, string> = {};
        for (const r of last.data ?? []) lastBy[r.tenant_id] = r.last_txn_at;
        const topsBy: Record<string, any[]> = {};
        for (const r of tops.data ?? []) (topsBy[r.tenant_id] ||= []).push({ product_id: r.product_id, name: r.name, units: Number(r.units) });

        const dayAgo = new Date(now.getTime() - 86400000);
        const tenantIds = new Set<string>([...Object.keys(nameOf), ...(cur.data ?? []).map((r: any) => r.tenant_id)]);

        let cRev = 0, cTxn = 0;
        const stores = [...tenantIds].map((tid) => {
          const c = (cur.data ?? []).find((r: any) => r.tenant_id === tid) || { revenue: 0, txn_count: 0, refund_count: 0 };
          const revenue = Number(c.revenue) || 0;
          const txns = Number(c.txn_count) || 0;
          const refunds = Number(c.refund_count) || 0;
          const priorRev = Number(prevBy[tid]?.revenue) || 0;
          const voidRate = txns > 0 ? refunds / txns : 0;
          const lastAt = lastBy[tid] || null;
          const flags: string[] = [];
          if (priorRev > 0 && revenue < priorRev * 0.8) flags.push('revenue_down_wow');
          if (voidRate > 0.05) flags.push('high_void_rate');
          if (!lastAt || new Date(lastAt) < dayAgo) flags.push('no_sales_24h');
          cRev += revenue; cTxn += txns;
          return {
            tenant_id: tid, store_name: nameOf[tid] || 'Store', active: activeOf[tid] !== false,
            revenue: +revenue.toFixed(2), transaction_count: txns,
            avg_transaction_value: txns > 0 ? +(revenue / txns).toFixed(2) : 0,
            refund_count: refunds, prior_revenue: +priorRev.toFixed(2),
            last_txn_at: lastAt, top_5_skus: topsBy[tid] || [], flags,
          };
        }).sort((a, b) => b.revenue - a.revenue);

        return json({
          window: { start: iso(start), end: iso(end) },
          stores,
          combined: {
            revenue: +cRev.toFixed(2), transaction_count: cTxn,
            avg_transaction_value: cTxn > 0 ? +(cRev / cTxn).toFixed(2) : 0,
            store_count: stores.length,
          },
        });
      }

      // ── staff & permissions (spec item 8) ─────────────────────────────────
      // List every employee for a tenant with their per-permission grants, so the
      // owner can edit ANY user's permissions and reset ANY user's password.
      case 'staff': {
        const tenantId = body.tenant_id as string;
        if (!tenantId) return json({ error: 'tenant_id required' }, 400);
        const { data: emps } = await admin
          .from('employees_cloud')
          .select('uid, username, name, role, location_id, is_active, must_change_password')
          .eq('tenant_id', tenantId).order('role').order('name');
        const { data: perms } = await admin
          .from('employee_permissions_cloud')
          .select('employee_uid, permission_key, is_granted, value')
          .eq('tenant_id', tenantId);
        const permsByEmp: Record<string, Record<string, { is_granted: boolean; value: number | null }>> = {};
        for (const p of perms ?? []) {
          (permsByEmp[p.employee_uid as string] ||= {})[p.permission_key as string] = {
            is_granted: !!p.is_granted, value: (p.value as number | null) ?? null,
          };
        }
        const { data: locs } = await admin.from('locations').select('id, name').eq('tenant_id', tenantId);
        const locName: Record<string, string> = {};
        for (const l of locs ?? []) locName[l.id as string] = l.name as string;
        return json({
          staff: (emps ?? []).map((e) => ({
            ...e, location_name: e.location_id ? (locName[e.location_id as string] || '—') : 'All locations',
            permissions: permsByEmp[e.uid as string] || {},
          })),
        });
      }

      // Grant/revoke ONE permission for an employee. Updates the existing cloud row
      // in place (preserving its uid so the POS pull converges) or inserts a new
      // grant. Audited. The POS applies it on its next sync pull.
      case 'setStaffPermission': {
        const tenantId = body.tenant_id as string;
        const employeeUid = body.employee_uid as string;
        const permissionKey = body.permission_key as string;
        const isGranted = !!body.is_granted;
        const value = (body.value as number | null) ?? null;
        if (!tenantId || !employeeUid || !permissionKey) return json({ error: 'tenant_id + employee_uid + permission_key required' }, 400);
        const { data: emp } = await admin.from('employees_cloud')
          .select('location_id, register_id, username, name').eq('tenant_id', tenantId).eq('uid', employeeUid).maybeSingle();
        if (!emp) return json({ error: 'employee not found' }, 404);
        const { data: existing } = await admin.from('employee_permissions_cloud')
          .select('uid').eq('tenant_id', tenantId).eq('employee_uid', employeeUid).eq('permission_key', permissionKey).maybeSingle();
        const nowIso = new Date().toISOString();
        if (existing?.uid) {
          const { error } = await admin.from('employee_permissions_cloud')
            .update({ is_granted: isGranted, value, updated_at: nowIso })
            .eq('tenant_id', tenantId).eq('uid', existing.uid);
          if (error) throw error;
        } else {
          const { error } = await admin.from('employee_permissions_cloud').insert({
            uid: crypto.randomUUID(), tenant_id: tenantId, location_id: emp.location_id, register_id: emp.register_id,
            employee_uid: employeeUid, permission_key: permissionKey, is_granted: isGranted, value,
            created_at: nowIso, updated_at: nowIso,
          });
          if (error) throw error;
        }
        await admin.from('owner_audit_log').insert({
          tenant_id: tenantId, action: 'set_permission', target_uid: employeeUid,
          target_label: emp.username || emp.name, detail: { permission_key: permissionKey, is_granted: isGranted, value },
        });
        return json({ ok: true });
      }

      // Reset a MANAGER's password to a new temporary one (shown once), forcing a
      // change on next login. Never silent — always audited. Cashiers are
      // PIN-only, full stop — rejected here (use resetStaffPin instead) so this
      // can never hand one a password_hash/must_change_password, which is
      // exactly the shape of the bug that forced a credential-change prompt on
      // every single cashier login instead of just the first (see the POS's
      // auth.ts and sync.ts for the full story).
      case 'resetStaffPassword': {
        const tenantId = body.tenant_id as string;
        const employeeUid = body.employee_uid as string;
        if (!tenantId || !employeeUid) return json({ error: 'tenant_id + employee_uid required' }, 400);
        const { data: emp } = await admin.from('employees_cloud')
          .select('username, name, role').eq('tenant_id', tenantId).eq('uid', employeeUid).maybeSingle();
        if (!emp) return json({ error: 'employee not found' }, 404);
        if (emp.role === 'cashier') return json({ error: 'Cashiers sign in with a PIN only — reset their PIN instead.' }, 400);
        const temp = genPassword();
        const hash = bcrypt.hashSync(temp, 10);
        const { error } = await admin.from('employees_cloud')
          .update({ password_hash: hash, must_change_password: true, updated_at: new Date().toISOString() })
          .eq('tenant_id', tenantId).eq('uid', employeeUid);
        if (error) throw error;
        await admin.from('owner_audit_log').insert({
          tenant_id: tenantId, action: 'reset_password', target_uid: employeeUid,
          target_label: emp.username || emp.name, detail: { role: emp.role },
        });
        return json({ ok: true, username: emp.username, temp_password: temp });
      }

      // Reset a CASHIER's PIN to a new temporary one (shown once), forcing a
      // change on next login. The manager-portal/owner-console equivalent of the
      // POS's own PIN reset — same must_change_pin-only shape, no password field.
      case 'resetStaffPin': {
        const tenantId = body.tenant_id as string;
        const employeeUid = body.employee_uid as string;
        if (!tenantId || !employeeUid) return json({ error: 'tenant_id + employee_uid required' }, 400);
        const { data: emp } = await admin.from('employees_cloud')
          .select('username, name, role').eq('tenant_id', tenantId).eq('uid', employeeUid).maybeSingle();
        if (!emp) return json({ error: 'employee not found' }, 404);
        if (emp.role !== 'cashier') return json({ error: 'Only cashiers use a PIN — reset their password instead.' }, 400);
        const temp = genPin4();
        const hash = bcrypt.hashSync(temp, 10);
        const { error } = await admin.from('employees_cloud')
          .update({ pin_hash: hash, must_change_pin: true, updated_at: new Date().toISOString() })
          .eq('tenant_id', tenantId).eq('uid', employeeUid);
        if (error) throw error;
        await admin.from('owner_audit_log').insert({
          tenant_id: tenantId, action: 'reset_pin', target_uid: employeeUid,
          target_label: emp.username || emp.name, detail: { role: emp.role },
        });
        return json({ ok: true, name: emp.name, temp_pin: temp });
      }

      // Per-location POS revenue for the "Revenue" tab.
      case 'revenueByLocation': {
        const tenantId = body.tenant_id as string;
        const end = body.end ? new Date(String(body.end)) : new Date();
        const start = body.start ? new Date(String(body.start)) : new Date(end.getTime() - 30 * 86400000);
        const { data: rows, error } = await admin.rpc('store_sales_by_location', { p_start: start.toISOString(), p_end: end.toISOString() });
        if (error) throw error;
        const { data: locs } = await admin.from('locations').select('id, name, tenant_id').eq('tenant_id', tenantId);
        const locName: Record<string, string> = {};
        for (const l of locs ?? []) locName[l.id as string] = l.name as string;
        // deno-lint-ignore no-explicit-any
        const mine = (rows as any[] ?? []).filter((r) => r.tenant_id === tenantId);
        const byLoc = (locs ?? []).map((l) => {
          const agg = mine.find((r) => r.location_id === l.id);
          return { location_id: l.id, location_name: l.name, revenue: Number(agg?.revenue) || 0,
                   txn_count: Number(agg?.txn_count) || 0, refund_count: Number(agg?.refund_count) || 0 };
        });
        // Any sales with no/legacy location_id (unattributed).
        const unattrib = mine.filter((r) => !r.location_id || !locName[r.location_id]);
        if (unattrib.length) {
          byLoc.push({ location_id: null as unknown as string, location_name: 'Unattributed',
            revenue: unattrib.reduce((s, r) => s + Number(r.revenue || 0), 0),
            txn_count: unattrib.reduce((s, r) => s + Number(r.txn_count || 0), 0),
            refund_count: unattrib.reduce((s, r) => s + Number(r.refund_count || 0), 0) });
        }
        byLoc.sort((a, b) => b.revenue - a.revenue);
        return json({ window: { start: start.toISOString(), end: end.toISOString() }, locations: byLoc });
      }

      // Recent owner audit trail for a tenant.
      case 'auditLog': {
        const tenantId = body.tenant_id as string;
        if (!tenantId) return json({ error: 'tenant_id required' }, 400);
        const { data, error } = await admin.from('owner_audit_log')
          .select('action, target_label, detail, created_at')
          .eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100);
        if (error) throw error;
        return json({ log: data ?? [] });
      }

      // ── manufacturer SFTP credentials (rebate scan-data submission) ────────
      case 'mfrList': {
        const tenantId = body.tenant_id as string;
        if (!tenantId) return json({ error: 'tenant_id required' }, 400);
        const { data: mfrs } = await admin
          .from('manufacturers_cloud')
          .select('uid, name, parent_company_code, batch_end_dow, due_dow')
          .eq('tenant_id', tenantId).order('name');
        const { data: creds } = await admin
          .from('manufacturer_credentials')
          .select('manufacturer_uid, sftp_host, sftp_port, sftp_user, remote_dir, vault_secret_id')
          .eq('tenant_id', tenantId);
        // deno-lint-ignore no-explicit-any
        const credOf: Record<string, any> = {};
        for (const c of creds ?? []) {
          credOf[c.manufacturer_uid] = { ...c, has_secret: !!c.vault_secret_id, vault_secret_id: undefined };
        }
        return json({ manufacturers: (mfrs ?? []).map((m) => ({ ...m, cred: credOf[m.uid] || null })) });
      }

      case 'mfrCredsSet': {
        const tenantId = body.tenant_id as string;
        const mfrUid = body.manufacturer_uid as string;
        if (!tenantId || !mfrUid) return json({ error: 'tenant_id + manufacturer_uid required' }, 400);
        // Store the SFTP password/key in Vault (only when a new one is provided).
        let vaultId: string | null = null;
        if (body.sftp_secret) {
          const { data: sid, error: sErr } = await admin.rpc('rebate_set_secret', {
            p_value: String(body.sftp_secret), p_name: `sftp_${tenantId}_${mfrUid}`,
          });
          if (sErr) throw sErr;
          vaultId = sid as string;
        }
        const row: Record<string, unknown> = {
          tenant_id: tenantId, manufacturer_uid: mfrUid,
          sftp_host: (body.sftp_host as string) || null,
          sftp_port: Math.max(1, Number(body.sftp_port) || 22),
          sftp_user: (body.sftp_user as string) || null,
          remote_dir: (body.remote_dir as string) || '.',
        };
        if (vaultId) row.vault_secret_id = vaultId; // omit → keep existing secret on edit
        const { error } = await admin.from('manufacturer_credentials').upsert(row, { onConflict: 'tenant_id,manufacturer_uid' });
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
