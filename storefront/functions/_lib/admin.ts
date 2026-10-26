// Guard for /api/admin/* endpoints. The caller's Supabase access token is verified BY THE DATABASE:
// admin_whoami() runs as that user and returns their id only if they are in platform_admins.
// There is no shared admin secret and no server-side role cache.

import { HttpError } from './http';
import { checkRateLimit } from './rateLimit';
import { postJson, type RouteCtx } from './route';
import { rpcAs } from './supabase';

export interface AdminCtx extends RouteCtx {
  adminId: string;
  jwt: string;
}

export function adminPost(handler: (ctx: AdminCtx) => Promise<unknown>) {
  return postJson(async (ctx) => {
    const auth = ctx.request.headers.get('Authorization') ?? '';
    if (!auth.startsWith('Bearer ') || auth.length > 4000) throw new HttpError(401, 'unauthorized');
    const jwt = auth.slice(7);
    let adminId: string | null = null;
    try {
      adminId = (await rpcAs<string | null>(ctx.env, jwt, 'admin_whoami')) ?? null;
    } catch {
      adminId = null; // invalid or expired token
    }
    if (!adminId) throw new HttpError(403, 'forbidden');
    if (!(await checkRateLimit(ctx.env, `admin:${adminId}`, { windowSeconds: 60, max: 120 }))) throw new HttpError(429, 'rate_limited');
    return handler({ ...ctx, adminId, jwt });
  });
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuidOf(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new HttpError(400, `${key}_invalid`);
  return v;
}
