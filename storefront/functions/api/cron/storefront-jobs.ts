import { requireEnv, type Env } from '../../_lib/env';
import { errorResponse, HttpError, json } from '../../_lib/http';
import { processOutbox } from '../../_lib/storefrontOutbox';
import { rpc } from '../../_lib/supabase';
import { timingSafeEqual } from '../../_lib/token';

/**
 * Every-minute storefront job (bearer CRON_SECRET): expire reservation holds per each shop's settings, then drain
 * the notification outbox. Both steps are idempotent, so overlapping or repeated runs are harmless.
 */
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  try {
    requireEnv(env, ['CRON_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
    const auth = request.headers.get('Authorization') ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!given || !timingSafeEqual(given, env.CRON_SECRET)) throw new HttpError(401, 'unauthorized');
    const expired = await rpc<number>(env, 'expire_reservation_holds', {});
    const outbox = await processOutbox(env, 50);
    return json({ ok: true, expired, outbox });
  } catch (e) {
    return errorResponse(e);
  }
};
