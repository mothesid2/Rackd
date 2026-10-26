import { guardPublic } from '../../_lib/guard';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson } from '../../_lib/route';
import { processOutbox } from '../../_lib/storefrontOutbox';

/**
 * Called by the customer site and the manager apps right after something happens (new reservation, status
 * change) so emails go out within seconds instead of waiting for the next scheduled run. It takes no input
 * that influences what is sent: it only drains rows the database already queued, so it is safe to expose,
 * and it is rate limited per IP.
 */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  await guardPublic(request, env, body, { bucket: 'sf-kick', limit: LIMITS.save });
  const s = await processOutbox(env, 10);
  return { ok: true, sent: s.sent };
});
