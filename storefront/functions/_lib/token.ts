// Capability tokens, hashing, and request identity helpers. Web Crypto only (Workers + Node 20+).

const enc = new TextEncoder();

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** 32 random bytes as 64 hex chars. Used for resume, magic-link and order-access tokens. */
export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}

export async function sha256Hex(input: string): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(input))));
}

const TOKEN_RE = /^[0-9a-f]{64}$/;
/** Cheap shape check before a token is sent to the database. */
export function looksLikeToken(s: unknown): s is string {
  return typeof s === 'string' && TOKEN_RE.test(s);
}

/** Compares two strings without early exit on the first differing character. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function clientIp(request: Request): string {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const xff = request.headers.get('X-Forwarded-For');
  if (xff) return xff.split(',')[0].trim();
  return 'unknown';
}

/** Salted, truncated hash so rate-limit buckets and audit rows never store raw IPs. */
export async function hashIp(ip: string, salt: string | undefined): Promise<string> {
  return (await sha256Hex(`${salt ?? 'rackd-ip'}:${ip}`)).slice(0, 32);
}

/**
 * Stable per-order token for links in emails. Derived (HMAC) rather than stored, so every email about
 * an order (confirmation, shipped) carries the same working link, and only its hash is in the database.
 */
export async function orderEmailToken(secret: string, orderId: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`rackd-hw-order-email:${orderId}`))));
}
