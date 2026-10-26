// One call that every PUBLIC mutating endpoint makes first: honeypot, rate limit, Turnstile.

import type { Env } from './env';
import { requireEnv } from './env';
import { HttpError, honeypotTripped } from './http';
import { checkRateLimit, type Limit } from './rateLimit';
import type { FetchLike } from './supabase';
import { clientIp, hashIp } from './token';
import { verifyTurnstile } from './turnstile';

export interface GuardOptions {
  /** Route-specific namespace, e.g. "create-application". */
  bucket: string;
  limit: Limit;
  /** Require a valid Turnstile token in body.turnstileToken (account creation and submit). */
  turnstile?: { action?: string };
  fetchImpl?: FetchLike;
}

export interface GuardResult {
  ip: string;
  ipHash: string;
}

export async function guardPublic(request: Request, env: Partial<Env>, body: Record<string, unknown>, opts: GuardOptions): Promise<GuardResult> {
  requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const ip = clientIp(request);
  const ipHash = await hashIp(ip, env.IP_HASH_SALT);

  // 1. honeypot: cheapest check first; generic error so bots learn nothing
  if (honeypotTripped(body)) throw new HttpError(400, 'invalid_request');

  // 2. rate limit per route and IP hash (fails closed)
  if (!(await checkRateLimit(env, `${opts.bucket}:${ipHash}`, opts.limit, opts.fetchImpl))) {
    throw new HttpError(429, 'rate_limited');
  }

  // 3. Turnstile
  if (opts.turnstile) {
    const r = await verifyTurnstile({
      token: body.turnstileToken,
      secret: env.TURNSTILE_SECRET_KEY,
      ip,
      action: opts.turnstile.action,
      fetchImpl: opts.fetchImpl,
    });
    if (!r.ok) throw new HttpError(403, 'bot_check_failed');
  }
  return { ip, ipHash };
}
