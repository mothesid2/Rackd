// Minimal PostgREST client (service role). Pages Functions only; the key never reaches a browser.

import type { Env } from './env';
import { requireEnv } from './env';

export class SupabaseError extends Error {
  constructor(
    public readonly status: number,
    /** Postgres SQLSTATE when PostgREST supplies one (e.g. 28000, 42501, P0001). */
    public readonly sqlstate: string,
    public readonly dbMessage: string,
  ) {
    super(`supabase ${status} ${sqlstate}`);
    this.name = 'SupabaseError';
  }
}

export type FetchLike = typeof fetch;

function headers(env: Partial<Env>): Record<string, string> {
  return {
    apikey: env.SUPABASE_SERVICE_ROLE_KEY as string,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function toError(res: Response): Promise<SupabaseError> {
  let body: { code?: string; message?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON error body */
  }
  return new SupabaseError(res.status, body.code ?? String(res.status), body.message ?? '');
}

/** Calls a Postgres function through PostgREST: POST /rest/v1/rpc/<fn>. */
export async function rpc<T = unknown>(env: Partial<Env>, fn: string, args: Record<string, unknown> = {}, fetchImpl: FetchLike = fetch): Promise<T> {
  requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error('invalid rpc name');
  const res = await fetchImpl(`${env.SUPABASE_URL.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify(args),
  });
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}
