import { devReturnsEmailCode } from '../../_lib/env';
import { sendEmail, verificationCodeEmail } from '../../_lib/email';
import { guardPublic } from '../../_lib/guard';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, tokenOf } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';
import type { Draft } from '../../../lib/onboarding/types';

/** Re-sends the 6-digit email verification code (database throttles to one per minute). */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  const token = tokenOf(body);
  await guardPublic(request, env, body, { bucket: 'send-code', limit: LIMITS.emailCode });
  const draft = await rpc<Draft>(env, 'app_get', { p_token: token });
  const code = await rpc<string>(env, 'app_email_code_issue', { p_token: token });
  const mail = await sendEmail(env, { to: draft.application.email, ...verificationCodeEmail(code) });
  return { email_sent: mail.sent, ...(devReturnsEmailCode(env) ? { dev_email_code: code } : {}) };
});
