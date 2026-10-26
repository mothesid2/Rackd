import { ConfigError } from './env';
import { safeLog } from './redact';
import { SupabaseError } from './supabase';

export class HttpError extends Error {
  constructor(public readonly status: number, public readonly code: string, message?: string) {
    super(message ?? code);
    this.name = 'HttpError';
  }
}

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...extra } });
}

/** Reads a JSON object body with a hard size cap. Throws HttpError(400|413). */
export async function readJson(request: Request, maxBytes = 256 * 1024): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get('Content-Length') ?? 0);
  if (declared > maxBytes) throw new HttpError(413, 'payload_too_large');
  const text = await request.text();
  if (new TextEncoder().encode(text).length > maxBytes) throw new HttpError(413, 'payload_too_large');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new HttpError(400, 'invalid_json');
  return parsed as Record<string, unknown>;
}

/** Hidden form field. Real users never fill it; bots that auto-fill every input do. */
export const HONEYPOT_FIELD = 'fax_number';

export function honeypotTripped(body: Record<string, unknown>): boolean {
  const v = body[HONEYPOT_FIELD];
  return typeof v === 'string' ? v.trim() !== '' : v != null && v !== false;
}

// Database exceptions are raised as slugs ("invalid_token", "email_invalid", ...). Only slugs are
// echoed to the client; anything else is a 500 with a generic message.
const SLUG = /^[a-z][a-z0-9_]{1,60}$/;

/** Maps any thrown value to a safe JSON response. Never includes stack traces or raw SQL text. */
export function errorResponse(e: unknown): Response {
  if (e instanceof HttpError) return json({ error: e.code }, e.status);
  if (e instanceof ConfigError) {
    safeLog('error', 'config error', { missing: e.missing });
    return json({ error: 'server_not_configured' }, 503);
  }
  if (e instanceof SupabaseError) {
    if (e.sqlstate === '28000') return json({ error: 'invalid_token' }, 401);
    if (e.sqlstate === '42501') return json({ error: 'forbidden' }, 403);
    if (e.sqlstate === 'P0001' && SLUG.test(e.dbMessage.split(':')[0])) {
      return json({ error: e.dbMessage.split(':')[0] }, 400);
    }
    if (e.sqlstate === '23514' || e.sqlstate === '22P02' || e.sqlstate === '23505') {
      return json({ error: 'invalid_request' }, 400);
    }
  }
  safeLog('error', 'unhandled error', e);
  return json({ error: 'internal_error' }, 500);
}
