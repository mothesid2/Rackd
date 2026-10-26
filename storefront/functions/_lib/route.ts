// Wrapper for POST JSON endpoints: content-type check, body parse, uniform error mapping.
// Tokens travel in the body (never the URL) so they stay out of logs and referrers.

import type { Env } from './env';
import { errorResponse, HttpError, json, readJson } from './http';
import { looksLikeToken } from './token';

export interface PagesCtx {
  request: Request;
  env: Env;
}

export interface RouteCtx extends PagesCtx {
  body: Record<string, unknown>;
}

export function postJson(handler: (ctx: RouteCtx) => Promise<unknown>): (ctx: PagesCtx) => Promise<Response> {
  return async (ctx) => {
    try {
      const ct = ctx.request.headers.get('Content-Type') ?? '';
      // A cross-site form cannot send application/json without a CORS preflight, which we never allow.
      if (!ct.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'unsupported_media_type');
      const body = await readJson(ctx.request);
      const out = await handler({ ...ctx, body });
      return out instanceof Response ? out : json(out);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export function tokenOf(body: Record<string, unknown>, key = 'token'): string {
  const t = body[key];
  if (!looksLikeToken(t)) throw new HttpError(401, 'invalid_token');
  return t;
}

export function str(body: Record<string, unknown>, key: string, opts: { min?: number; max?: number; optional?: boolean } = {}): string {
  const v = body[key];
  if (v == null || v === '') {
    if (opts.optional) return '';
    throw new HttpError(400, `${key}_required`);
  }
  if (typeof v !== 'string') throw new HttpError(400, `${key}_invalid`);
  const s = v.trim();
  if (s.length < (opts.min ?? 1) && !opts.optional) throw new HttpError(400, `${key}_required`);
  if (s.length > (opts.max ?? 200)) throw new HttpError(400, `${key}_too_long`);
  return s;
}
