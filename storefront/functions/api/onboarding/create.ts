import { devReturnsEmailCode } from '../../_lib/env';
import { resumeLinkEmail, sendEmail, verificationCodeEmail } from '../../_lib/email';
import { guardPublic } from '../../_lib/guard';
import { HttpError } from '../../_lib/http';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, str } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';

const ROLES = ['owner', 'manager', 'other'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Step 1: creates the draft, returns the resume token, emails a verification code and a resume link. */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  const g = await guardPublic(request, env, body, {
    bucket: 'create-application',
    limit: LIMITS.createApplication,
    turnstile: { action: 'create' },
  });
  const fullName = str(body, 'full_name', { min: 2, max: 120 });
  const email = str(body, 'email', { max: 254 }).toLowerCase();
  const phone = str(body, 'phone', { optional: true, max: 30 });
  const role = str(body, 'role', { max: 20 });
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email_invalid');
  if (!ROLES.includes(role)) throw new HttpError(400, 'role_invalid');

  const rows = await rpc<{ application_id: string; resume_token: string }[]>(env, 'app_create', {
    p_full_name: fullName, p_email: email, p_phone: phone, p_role: role, p_ip_hash: g.ipHash,
  });
  const { resume_token } = rows[0];

  const code = await rpc<string>(env, 'app_email_code_issue', { p_token: resume_token });
  const codeMail = await sendEmail(env, { to: email, ...verificationCodeEmail(code) });

  const magic = await rpc<{ magic_token: string }[]>(env, 'app_magic_issue', { p_email: email });
  if (magic[0]) await sendEmail(env, { to: email, ...resumeLinkEmail(env, fullName, magic[0].magic_token) });

  return {
    resume_token,
    email_sent: codeMail.sent,
    ...(devReturnsEmailCode(env) ? { dev_email_code: code } : {}),
  };
});
