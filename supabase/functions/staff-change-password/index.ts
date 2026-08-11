// staff-change-password — portal-side forced/voluntary password change (item 1d).
//
// POST { license_key, username, old_password, new_password }
//   -> 200 { ok: true }  (updates employees_cloud, clears must_change_password)
// The new hash syncs down to every kiosk on the next pull, so the credential stays
// unified across the POS and the portal.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import bcrypt from 'https://esm.sh/bcryptjs@2.4.3';
import { rateLimited, clientIp } from '../_shared/rateLimit.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// Same brute-force target as staff-login (requires knowing/guessing
// old_password) — same two-limit shape (audit batch 8, item 9).
const IP_LIMIT = 20, IP_WINDOW_MS = 5 * 60 * 1000;
const ACCOUNT_LIMIT = 8, ACCOUNT_WINDOW_MS = 5 * 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: { license_key?: string; username?: string; old_password?: string; new_password?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const licenseKey = body.license_key?.trim();
  const username = body.username?.trim();
  const oldPassword = body.old_password ?? '';
  const newPassword = body.new_password ?? '';
  if (!licenseKey || !username) return json({ error: 'license_key and username are required' }, 400);
  if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return json({ error: 'Password must be at least 8 characters and include a letter and a number.' }, 400);
  }

  if (rateLimited(clientIp(req), IP_LIMIT, IP_WINDOW_MS)) return json({ error: 'Too many attempts. Try again in a few minutes.' }, 429);
  if (rateLimited(`${licenseKey}:${username.toLowerCase()}`, ACCOUNT_LIMIT, ACCOUNT_WINDOW_MS)) {
    return json({ error: 'Too many attempts for this account. Try again in a few minutes.' }, 429);
  }

  const url = Deno.env.get('SUPABASE_URL');
  const serviceRole = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRole) return json({ error: 'function not configured' }, 500);
  const admin = createClient(url, serviceRole, { auth: { persistSession: false } });

  const { data: lic } = await admin.from('licenses').select('tenant_id, active').eq('license_key', licenseKey).maybeSingle();
  if (!lic || lic.active !== true) return json({ error: 'business key invalid or inactive' }, 401);

  const { data: emp } = await admin.from('employees_cloud')
    .select('uid, password_hash, is_active, role').eq('tenant_id', lic.tenant_id).eq('username', username).maybeSingle();
  if (!emp || emp.is_active === false || !emp.password_hash || !bcrypt.compareSync(oldPassword, emp.password_hash)) {
    return json({ error: 'Current password is incorrect.' }, 401);
  }

  const { error } = await admin.from('employees_cloud')
    .update({ password_hash: bcrypt.hashSync(newPassword, 10), must_change_password: false })
    .eq('tenant_id', lic.tenant_id).eq('uid', emp.uid);
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true });
});
