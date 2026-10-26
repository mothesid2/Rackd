import type { Env } from './env';
import { safeLog } from './redact';
import { rpc, type FetchLike } from './supabase';

export interface Limit {
  windowSeconds: number;
  max: number;
}

/** Per-IP-hash limits. Tune here; buckets are namespaced by route in guard.ts. */
export const LIMITS = {
  createApplication: { windowSeconds: 3600, max: 5 },
  emailCode: { windowSeconds: 900, max: 5 },
  magicLink: { windowSeconds: 3600, max: 5 },
  save: { windowSeconds: 60, max: 60 },
  upload: { windowSeconds: 600, max: 30 },
  submit: { windowSeconds: 3600, max: 10 },
  checkout: { windowSeconds: 600, max: 10 },
} satisfies Record<string, Limit>;

/**
 * true = allowed. Fails CLOSED: if the limiter cannot be reached the request is refused, because a
 * bot should not get a free pass by degrading the database.
 */
export async function checkRateLimit(env: Partial<Env>, bucket: string, limit: Limit, fetchImpl?: FetchLike): Promise<boolean> {
  try {
    const ok = await rpc<boolean>(env, 'rate_limit_hit', {
      p_bucket: bucket,
      p_window_seconds: limit.windowSeconds,
      p_max: limit.max,
    }, fetchImpl);
    return ok === true;
  } catch (e) {
    safeLog('error', 'rate limit check failed (denying)', e);
    return false;
  }
}
