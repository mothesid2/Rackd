'use client';
// Browser helpers for the /admin console. All reads go straight to Supabase with the admin's own session
// (row level security decides what they can see); privileged actions go through /api/admin/* Pages
// Functions, which re-verify the bearer token against platform_admins in the database.

import { supabase } from '../supabase';

export class AdminApiError extends Error {
  constructor(public readonly status: number, public readonly code: string) { super(code); }
}

export async function adminPost<T = unknown>(path: string, body: Record<string, unknown>): Promise<T> {
  const { data } = await supabase().auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new AdminApiError(401, 'unauthorized');
  let res: Response;
  try {
    res = await fetch(`/api/admin/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AdminApiError(0, 'network_error');
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new AdminApiError(res.status, json.error ?? 'request_failed');
  return json as T;
}

const MESSAGES: Record<string, string> = {
  network_error: 'Could not reach the server.',
  unauthorized: 'Your session expired. Sign in again.',
  forbidden: 'You do not have permission for that.',
  rate_limited: 'Too many requests. Wait a moment.',
  invalid_transition: 'That change is not allowed from the current status.',
  message_required: 'A message is required (at least 10 characters).',
  tracking_required: 'Enter a tracking number to mark it shipped.',
  note_required: 'A note is required.',
  business_name_exists: 'A business with that legal name already exists. Resolve the duplicate before approving.',
  invalid_status: 'This application is not in a state that can be approved.',
  application_incomplete: 'The application is missing required details.',
  already_activated: 'The owner has already activated their account.',
  not_provisioned: 'This application has not been approved yet.',
  file_infected: 'That file failed its virus scan and cannot be opened.',
  ein_not_set: 'No EIN is on file.',
  server_not_configured: 'The server is missing configuration.',
  not_found: 'Not found.',
};
export const adminMessage = (e: unknown): string => {
  if (e instanceof AdminApiError) return MESSAGES[e.code] ?? 'Something went wrong. Please try again.';
  const m = (e as { message?: string })?.message ?? '';
  if (m.startsWith('config_invalid')) return `That value is not allowed (${m.replace('config_invalid: ', '')}).`;
  return m ? 'Something went wrong. Please try again.' : 'Something went wrong. Please try again.';
};

export const toCents = (dollars: string): number | null => {
  const n = Number(dollars.replace(/[$,\s]/g, ''));
  return dollars.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};
export const toDollars = (cents: number | null | undefined): string => (cents == null ? '' : (cents / 100).toFixed(2));
export const fmtMoney = (cents: number) => (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
export const fmtDate = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—');

/** Red when expired or within 30 days; amber within 60. */
export function permitFlag(expiry: string | null, today = new Date()): 'expired' | 'soon' | 'ok' | null {
  if (!expiry) return null;
  const d = new Date(`${expiry}T00:00:00`);
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = Math.round((d.getTime() - t.getTime()) / 86400000);
  if (days < 0) return 'expired';
  if (days <= 30) return 'soon';
  return 'ok';
}

/** Only the keys that changed, so a price edit shows one line instead of a whole row dump. */
export function diffKeys(before: Record<string, any> | null, after: Record<string, any> | null): { key: string; from: unknown; to: unknown }[] {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const out: { key: string; from: unknown; to: unknown }[] = [];
  for (const k of keys) {
    if (['updated_at', 'updated_by'].includes(k)) continue;
    const a = before?.[k], b = after?.[k];
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ key: k, from: a, to: b });
  }
  return out;
}
