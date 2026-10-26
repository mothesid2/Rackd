import { requireEnv, type Env } from '../../_lib/env';
import { errorResponse, HttpError, json } from '../../_lib/http';
import { periodFor, runStatements } from '../../_lib/storefrontStatements';
import { timingSafeEqual } from '../../_lib/token';

/**
 * Monthly statement job (bearer CRON_SECRET). Run on the 1st of each month for the previous month.
 * Body (optional): { "period": "2026-09", "dry_run": true }. A dry run previews totals and writes/sends nothing.
 */
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  try {
    requireEnv(env, ['CRON_SECRET', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
    const auth = request.headers.get('Authorization') ?? '';
    const given = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!given || !timingSafeEqual(given, env.CRON_SECRET)) throw new HttpError(401, 'unauthorized');
    const body = (await request.json().catch(() => ({}))) as { period?: string; dry_run?: boolean };
    if (body.period !== undefined && !/^[0-9]{4}-(0[1-9]|1[0-2])$/.test(body.period)) throw new HttpError(400, 'period_invalid');
    const summary = await runStatements(env, { period: periodFor(new Date(), body.period), dryRun: body.dry_run === true });
    return json({ ok: true, ...summary });
  } catch (e) {
    return errorResponse(e);
  }
};
