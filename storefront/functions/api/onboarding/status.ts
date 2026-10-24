import { guardPublic } from '../../_lib/guard';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, tokenOf } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';

export const onRequestPost = postJson(async ({ request, env, body }) => {
  const token = tokenOf(body);
  await guardPublic(request, env, body, { bucket: 'status', limit: LIMITS.save });
  return rpc(env, 'app_status', { p_token: token });
});
