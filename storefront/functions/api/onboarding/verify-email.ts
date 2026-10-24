import { guardPublic } from '../../_lib/guard';
import { HttpError } from '../../_lib/http';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, tokenOf } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';

export const onRequestPost = postJson(async ({ request, env, body }) => {
  const token = tokenOf(body);
  await guardPublic(request, env, body, { bucket: 'verify-email', limit: LIMITS.emailCode });
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^\d{6}$/.test(code)) throw new HttpError(400, 'code_invalid');
  const verified = await rpc<boolean>(env, 'app_email_code_verify', { p_token: token, p_code: code });
  return { verified: verified === true };
});
