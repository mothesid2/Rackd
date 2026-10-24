import { guardPublic } from '../../_lib/guard';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, tokenOf } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';

/** Redeems the emailed single-use link: verifies the email and issues a fresh resume token. */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  const magic = tokenOf(body, 'magic');
  await guardPublic(request, env, body, { bucket: 'resume', limit: LIMITS.magicLink });
  const resume_token = await rpc<string>(env, 'app_magic_redeem', { p_magic: magic });
  return { resume_token };
});
