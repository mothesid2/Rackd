import { guardPublic } from '../../_lib/guard';
import { HttpError } from '../../_lib/http';
import { beginPayment, type OrderRow } from '../../_lib/payments';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, tokenOf } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';
import { sha256Hex } from '../../_lib/token';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "Pay now" on the order page: the order id + its access token authorise creating a payment session. */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  await guardPublic(request, env, body, { bucket: 'hw-pay', limit: LIMITS.checkout });
  const token = tokenOf(body, 'token');
  if (typeof body.id !== 'string' || !UUID.test(body.id)) throw new HttpError(401, 'invalid_token');
  const order = await rpc<OrderRow>(env, 'hw_get_order', { p_id: body.id, p_token_hash: await sha256Hex(token) });
  return { redirect_url: await beginPayment(env, order, token) };
});
