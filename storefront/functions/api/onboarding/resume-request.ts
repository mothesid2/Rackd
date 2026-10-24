import { resumeLinkEmail, sendEmail } from '../../_lib/email';
import { guardPublic } from '../../_lib/guard';
import { HttpError } from '../../_lib/http';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, str } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';

/** "Email me a link to continue." Always answers ok so email addresses cannot be enumerated. */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  await guardPublic(request, env, body, {
    bucket: 'resume-request',
    limit: LIMITS.magicLink,
    turnstile: { action: 'resume' },
  });
  const email = str(body, 'email', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'email_invalid');
  const rows = await rpc<{ full_name: string; email: string; magic_token: string }[]>(env, 'app_magic_issue', { p_email: email });
  if (rows[0]) await sendEmail(env, { to: rows[0].email, ...resumeLinkEmail(env, rows[0].full_name, rows[0].magic_token) });
  return { ok: true };
});
