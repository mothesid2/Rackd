// Shared best-effort rate limiter for edge functions (audit batch 8, item 9).
// In-memory per-instance — Deno Edge Functions can scale to multiple
// concurrent instances, so this does NOT give an exact global limit across
// all of them. It still meaningfully raises the bar over no limit at all
// (each instance enforces its own cap, and low-traffic functions typically
// run on very few warm instances) — same trade-off jwt-issuer's own limiter
// already accepted; this just makes that pattern reusable instead of
// re-implemented per function.
const hits = new Map<string, number[]>();

/**
 * Returns true if `key` (e.g. an IP, license_key, or username) has exceeded
 * `limit` calls within `windowMs`. Records this call either way.
 */
export function rateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > limit;
}

/** Best-effort client IP from standard proxy headers (Supabase sits behind one). */
export function clientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim()
    || req.headers.get('cf-connecting-ip')
    || 'unknown';
}
