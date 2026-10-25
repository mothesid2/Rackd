import { guardPublic } from '../../_lib/guard';
import { HttpError } from '../../_lib/http';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, tokenOf } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';
import { sha256Hex } from '../../_lib/token';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guest order lookup: the order id plus its secret access token (sent in the body, never a query string). */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  await guardPublic(request, env, body, { bucket: 'hw-order', limit: LIMITS.save });
  const token = tokenOf(body, 'token');
  if (typeof body.id !== 'string' || !UUID.test(body.id)) throw new HttpError(401, 'invalid_token');
  return rpc(env, 'hw_get_order', { p_id: body.id, p_token_hash: await sha256Hex(token) });
});
