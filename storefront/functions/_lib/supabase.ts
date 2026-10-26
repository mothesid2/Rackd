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

// ---------------------------------------------------------------- Storage (private bucket)
const STORAGE_BUCKET = 'onboarding-docs';
export { STORAGE_BUCKET };

function storageBase(env: Partial<Env>): string {
  return `${(env.SUPABASE_URL as string).replace(/\/+$/, '')}/storage/v1`;
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** Short-lived (about 2 hours, Supabase default) signed upload token for one exact object path. */
export async function createSignedUpload(env: Partial<Env>, path: string, fetchImpl: FetchLike = fetch): Promise<{ path: string; token: string }> {
  requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const res = await fetchImpl(`${storageBase(env)}/object/upload/sign/${STORAGE_BUCKET}/${encodePath(path)}`, {
    method: 'POST',
    headers: headers(env),
    body: '{}',
  });
  if (!res.ok) throw await toError(res);
  const data = (await res.json()) as { url?: string; token?: string };
  const token = data.token ?? (data.url ? new URL(data.url, 'https://x.invalid').searchParams.get('token') : null);
  if (!token) throw new SupabaseError(502, 'storage', 'no_upload_token');
  return { path, token };
}

export interface ObjectProbe {
  size: number;
  head: Uint8Array;
}

/** Reads the first bytes and total size of an uploaded object (service role). Returns null if missing. */
export async function probeObject(env: Partial<Env>, path: string, fetchImpl: FetchLike = fetch): Promise<ObjectProbe | null> {
  requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const res = await fetchImpl(`${storageBase(env)}/object/${STORAGE_BUCKET}/${encodePath(path)}`, {
    headers: { ...headers(env), Range: 'bytes=0-15' },
  });
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw await toError(res);
  const head = new Uint8Array(await res.arrayBuffer());
  const range = res.headers.get('Content-Range'); // "bytes 0-15/12345"
  const total = range ? Number(range.split('/')[1]) : Number(res.headers.get('Content-Length') ?? head.length);
  return { size: Number.isFinite(total) ? total : head.length, head: head.slice(0, 16) };
}

export async function deleteObject(env: Partial<Env>, path: string, fetchImpl: FetchLike = fetch): Promise<void> {
  requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  await fetchImpl(`${storageBase(env)}/object/${STORAGE_BUCKET}/${encodePath(path)}`, { method: 'DELETE', headers: headers(env) });
}

/** PostgREST PATCH on a table (service role), filtered by simple equality. */
export async function restPatch(env: Partial<Env>, table: string, match: Record<string, string>, values: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<void> {
  requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('invalid table name');
  const qs = Object.entries(match).map(([k, v]) => `${encodeURIComponent(k)}=eq.${encodeURIComponent(v)}`).join('&');
  const res = await fetchImpl(`${(env.SUPABASE_URL as string).replace(/\/+$/, '')}/rest/v1/${table}?${qs}`, {
    method: 'PATCH',
    headers: { ...headers(env), Prefer: 'return=minimal' },
    body: JSON.stringify(values),
  });
  if (!res.ok) throw await toError(res);
}

/** PostgREST GET (service role). `query` is the part after "?", already encoded. */
export async function restSelect<T = unknown>(env: Partial<Env>, table: string, query: string, fetchImpl: FetchLike = fetch): Promise<T> {
  requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('invalid table name');
  const res = await fetchImpl(`${(env.SUPABASE_URL as string).replace(/\/+$/, '')}/rest/v1/${table}?${query}`, { headers: headers(env) });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** Calls an rpc as the end user (their JWT decides the role/tenant); PostgREST verifies the signature. */
export async function rpcAs<T = unknown>(env: Partial<Env>, jwt: string, fn: string, args: Record<string, unknown> = {}, fetchImpl: FetchLike = fetch): Promise<T> {
  requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!/^[a-z_][a-z0-9_]*$/.test(fn)) throw new Error('invalid rpc name');
  const res = await fetchImpl(`${(env.SUPABASE_URL as string).replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { ...headers(env), Authorization: `Bearer ${jwt}` },
    body: JSON.stringify(args),
  });
  if (!res.ok) throw await toError(res);
  return (await res.json()) as T;
}

/** PostgREST INSERT (service role). */
export async function restInsert(env: Partial<Env>, table: string, row: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<void> {
  requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error('invalid table name');
  const res = await fetchImpl(`${(env.SUPABASE_URL as string).replace(/\/+$/, '')}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...headers(env), Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  });
  if (!res.ok) throw await toError(res);
}

/** Short-lived signed download URL for one private object. */
export async function createSignedDownload(env: Partial<Env>, path: string, expiresIn = 60, fetchImpl: FetchLike = fetch): Promise<string> {
  requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']);
  const res = await fetchImpl(`${storageBase(env)}/object/sign/${STORAGE_BUCKET}/${encodePath(path)}`, {
    method: 'POST',
    headers: headers(env),
    body: JSON.stringify({ expiresIn }),
  });
  if (!res.ok) throw await toError(res);
  const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
  const rel = data.signedURL ?? data.signedUrl;
  if (!rel) throw new SupabaseError(502, 'storage', 'no_signed_url');
  return rel.startsWith('http') ? rel : `${storageBase(env)}${rel.startsWith('/') ? '' : '/'}${rel}`;
}
