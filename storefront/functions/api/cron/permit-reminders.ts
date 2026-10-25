import { requireEnv, type Env } from '../../_lib/env';
import { errorResponse, HttpError, json } from '../../_lib/http';
import { runPermitReminders } from '../../_lib/permitReminders';
import { timingSafeEqual } from '../../_lib/token';

/**
 * Daily scheduled job (see docs/permit-reminders.md). Not for browsers: it needs
 * `Authorization: Bearer <CRON_SECRET>`. Safe to call more than once a day, because the database
 * remembers which reminders were already sent.
 */
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  try {
    requireEnv(env, ['CRON_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
    const auth = request.headers.get('Authorization') ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!given || !timingSafeEqual(given, env.CRON_SECRET)) throw new HttpError(401, 'unauthorized');
    return json({ ok: true, ...(await runPermitReminders(env)) });
  } catch (e) {
    return errorResponse(e);
  }
};
