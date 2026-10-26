'use client';
// Browser client for /api/onboarding/*. The resume token lives in localStorage (it is the only
// credential the draft has) and is sent in POST bodies, never in URLs. The wizard never stores
// form data or the EIN locally.

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config';
import type { Draft, StatusDto } from './types';

const TOKEN_KEY = 'rackd_onboarding_token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}
export function setToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* private mode: the draft still works until the tab closes, resume link covers the rest */
  }
  memoryToken = t;
}
export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  memoryToken = null;
}
let memoryToken: string | null = null;
export const currentToken = (): string | null => memoryToken ?? getToken();

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export async function post<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/onboarding/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network_error');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? 'request_failed');
  return data as T;
}

const authed = (extra: Record<string, unknown> = {}) => {
  const token = currentToken();
  if (!token) throw new ApiError(401, 'invalid_token');
  return { token, ...extra };
};

export const api = {
  create: (b: { full_name: string; email: string; phone: string; role: string; turnstileToken: string; fax_number?: string }) =>
    post<{ resume_token: string; email_sent: boolean; dev_email_code?: string }>('create', b),
  sendCode: () => post<{ email_sent: boolean; dev_email_code?: string }>('send-code', authed()),
  verifyEmail: (code: string) => post<{ verified: boolean }>('verify-email', authed({ code })),
  resumeRequest: (email: string, turnstileToken: string) => post<{ ok: boolean }>('resume-request', { email, turnstileToken }),
  resume: (magic: string) => post<{ resume_token: string }>('resume', { magic }),
  get: () => post<Draft>('get', authed()),
  status: () => post<StatusDto>('status', authed()),
  save: (parts: { patch?: Record<string, unknown>; ein?: string; locations?: unknown[]; owners?: unknown[] }) =>
    post<{ ok: boolean; saved_at: string }>('save', authed(parts)),
  agreements: (b: { typed_name: string; agree: boolean; compliance_ack: boolean; sms_consent: boolean }) =>
    post<{ ok: boolean }>('agreements', authed(b)),
  submit: (turnstileToken: string) => post<{ ok: boolean; errors?: string[] }>('submit', authed({ turnstileToken })),
};

export const FILE_LIMIT = 10 * 1024 * 1024;
export const FILE_TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

/** Upload flow: signed token from our server, direct-to-storage upload, server verifies the bytes, then records it. */
export async function uploadDocument(file: File, meta: { kind: string; location_id?: string; owner_id?: string }): Promise<string> {
  if (!FILE_TYPES.includes(file.type)) throw new ApiError(400, 'file_type_not_allowed');
  if (file.size > FILE_LIMIT) throw new ApiError(413, 'file_too_large');
  if (file.size === 0) throw new ApiError(400, 'file_empty');
  const { path, upload_token } = await post<{ path: string; upload_token: string }>(
    'upload-url', authed({ mime: file.type, size: file.size }));
  const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  const { error } = await sb.storage.from('onboarding-docs').uploadToSignedUrl(path, upload_token, file, { contentType: file.type });
  if (error) throw new ApiError(502, 'upload_failed');
  const r = await post<{ document_id: string }>('register-document', authed({ ...meta, path, original_name: file.name }));
  return r.document_id;
}

const MESSAGES: Record<string, string> = {
  network_error: 'We could not reach the server. Check your connection and try again.',
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
  bot_check_failed: 'We could not verify you are human. Please try the check again.',
  invalid_token: 'Your session expired. Use the link we emailed you to continue.',
  email_invalid: 'Enter a valid email address.',
  too_soon: 'Please wait a minute before requesting another code.',
  invalid_ein: 'Enter the EIN as 9 digits, like 12-3456789.',
  file_type_not_allowed: 'Only PDF, JPG or PNG files are allowed.',
  file_too_large: 'That file is larger than 10 MB.',
  file_empty: 'That file is empty.',
  file_rejected: 'That file could not be accepted. Upload a real PDF, JPG or PNG.',
  upload_failed: 'The upload failed. Please try again.',
  upload_missing: 'The upload did not finish. Please try again.',
  server_not_configured: 'This feature is not available yet. Please try again later.',
};
export const messageFor = (e: unknown): string =>
  (e instanceof ApiError && MESSAGES[e.code]) || 'Something went wrong. Please try again.';
