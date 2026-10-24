import { appBaseUrl } from '../../_lib/env';
import { escapeHtml, sendEmail } from '../../_lib/email';
import { guardPublic } from '../../_lib/guard';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, tokenOf } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';
import type { Draft } from '../../../lib/onboarding/types';

/** Final submit. Turnstile required. The database returns every validation problem at once. */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  const token = tokenOf(body);
  await guardPublic(request, env, body, { bucket: 'submit', limit: LIMITS.submit, turnstile: { action: 'submit' } });

  const result = await rpc<{ ok: boolean; errors?: string[] }>(env, 'app_submit', { p_token: token });
  if (!result.ok) return result;

  const draft = await rpc<Draft>(env, 'app_get', { p_token: token });
  const a = draft.application;
  await sendEmail(env, {
    to: a.email,
    subject: 'We received your Rackd application',
    html: `<p>Hi ${escapeHtml(a.full_name.split(' ')[0] || 'there')},</p>
<p>Thanks for applying${a.legal_name ? ` for ${escapeHtml(a.legal_name)}` : ''}. Our team will review it and email you if we need anything else.
You can check your status any time using the link in your earlier email, or at ${escapeHtml(appBaseUrl(env))}/get-started/submitted.</p>
<p>— Rackd</p>`,
  });
  if (env.ADMIN_NOTIFY_EMAIL) {
    await sendEmail(env, {
      to: env.ADMIN_NOTIFY_EMAIL,
      subject: 'New Rackd application submitted',
      html: `<p>${escapeHtml(a.legal_name ?? a.full_name)} submitted an application (${escapeHtml(a.plan_model ?? 'no plan')}). Review it in the admin console.</p>`,
    });
  }
  return { ok: true };
});
