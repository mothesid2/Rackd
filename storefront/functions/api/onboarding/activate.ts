import bcrypt from 'bcryptjs';
import { guardPublic } from '../../_lib/guard';
import { HttpError } from '../../_lib/http';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, tokenOf } from '../../_lib/route';
import { restInsert, restPatch, restSelect, rpc } from '../../_lib/supabase';

/**
 * Owner activation: the approved owner follows the emailed link and chooses their OWN password (no temporary
 * password is ever emailed). This creates their login in employees_cloud (role admin), the same table
 * the staff-login function checks with bcryptjs, then consumes the invite and marks the application activated.
 *
 * NOTE: bcrypt is CPU heavy. Cloudflare's free Workers plan allows ~10 ms of CPU per request, which is not
 * enough; run this on the Workers Paid plan (or move this one step into a Supabase Edge Function).
 */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  await guardPublic(request, env, body, { bucket: 'activate', limit: LIMITS.submit, turnstile: { action: 'activate' } });
  const token = tokenOf(body, 'invite');
  const password = typeof body.password === 'string' ? body.password : '';
  if (password.length < 10) throw new HttpError(400, 'password_too_short');
  if (password.length > 128) throw new HttpError(400, 'password_too_long');

  // 1. validate without consuming, so a failure below does not burn the owner's link
  const inv = await rpc<{ tenant_id: string; email: string; full_name: string }>(env, 'onb_peek_invite', { p_token: token });
  const username = inv.email.toLowerCase();
  const hash = bcrypt.hashSync(password, 10);

  // 2. create or update the owner login
  const existing = await restSelect<{ uid: string }[]>(env, 'employees_cloud', `select=uid&tenant_id=eq.${inv.tenant_id}&username=eq.${encodeURIComponent(username)}`);
  if (existing[0]) {
    await restPatch(env, 'employees_cloud', { tenant_id: inv.tenant_id, uid: existing[0].uid }, {
      password_hash: hash, is_active: true, must_change_password: false, updated_at: new Date().toISOString(),
    });
  } else {
    await restInsert(env, 'employees_cloud', {
      uid: crypto.randomUUID(), tenant_id: inv.tenant_id, location_id: null, username, name: inv.full_name, role: 'admin',
      password_hash: hash, pin_hash: null, is_active: true, must_change_password: false, must_change_pin: true,
    });
  }

  // 3. consume the invite and mark the application activated
  await rpc(env, 'onb_redeem_invite', { p_token: token });
  await rpc(env, 'onb_mark_activated', { p_tenant: inv.tenant_id });
  return { ok: true, username };
});
