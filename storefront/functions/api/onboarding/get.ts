import { guardPublic } from '../../_lib/guard';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, tokenOf } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';

/** Returns the caller's own draft only (the token selects it). Never includes EIN ciphertext. */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  const token = tokenOf(body);
  await guardPublic(request, env, body, { bucket: 'get', limit: LIMITS.save });
  return rpc(env, 'app_get', { p_token: token });
});
