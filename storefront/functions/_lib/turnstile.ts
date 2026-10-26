// Cloudflare Turnstile server-side verification.
// Dev uses Cloudflare's always-pass test secret (see .env.example); production uses a real widget.

import type { FetchLike } from './supabase';

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const MAX_TOKEN_LENGTH = 2048;

export interface TurnstileResult {
  ok: boolean;
  errors: string[];
}

export async function verifyTurnstile(opts: {
  token: unknown;
  secret: string | undefined;
  ip?: string;
  /** If given, the widget's action must match (set data-action on the client widget). */
  action?: string;
  fetchImpl?: FetchLike;
}): Promise<TurnstileResult> {
  const { token, secret, ip, action, fetchImpl = fetch } = opts;
  if (!secret) return { ok: false, errors: ['missing-secret'] };
  if (typeof token !== 'string' || token === '' || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, errors: ['missing-input-response'] };
  }
  const form = new FormData();
  form.set('secret', secret);
  form.set('response', token);
  if (ip && ip !== 'unknown') form.set('remoteip', ip);
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body: form });
    if (!res.ok) return { ok: false, errors: [`http-${res.status}`] };
    const data = (await res.json()) as { success?: boolean; action?: string; 'error-codes'?: string[] };
    if (data.success !== true) return { ok: false, errors: data['error-codes'] ?? ['verification-failed'] };
    if (action && data.action && data.action !== action) return { ok: false, errors: ['action-mismatch'] };
    return { ok: true, errors: [] };
  } catch {
    return { ok: false, errors: ['network-error'] };
  }
}
