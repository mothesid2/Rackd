// Upload policy: PDF / JPG / PNG, 10 MB, content sniffed server-side (never trust the browser's MIME).

import type { Env } from './env';
import { safeLog } from './redact';
import { restPatch, type FetchLike } from './supabase';

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const ALLOWED_MIME = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export type AllowedMime = (typeof ALLOWED_MIME)[number];

export const EXT_FOR_MIME: Record<AllowedMime, string> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export function isAllowedMime(m: unknown): m is AllowedMime {
  return typeof m === 'string' && (ALLOWED_MIME as readonly string[]).includes(m);
}

/** Identifies the real type from the file's first bytes. */
export function sniffMime(head: Uint8Array): AllowedMime | null {
  const starts = (sig: number[]) => sig.every((b, i) => head[i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'; // %PDF-
  if (starts([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  return null;
}

export type ScanResult = 'clean' | 'infected' | 'skipped';

/**
 * Virus-scan hook (STUB). With DOC_SCAN_HOOK_URL unset it returns 'skipped' and the document stays
 * flagged as unscanned in the admin console. When set, it POSTs { path } and expects { status }.
 * TODO before launch: wire a real scanner (e.g. ClamAV service) and block admin download until 'clean'.
 */
export async function scanUploadedFile(env: Partial<Env>, path: string, fetchImpl: FetchLike = fetch): Promise<ScanResult> {
  if (!env.DOC_SCAN_HOOK_URL) return 'skipped';
  try {
    const res = await fetchImpl(env.DOC_SCAN_HOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!res.ok) return 'skipped';
    const data = (await res.json()) as { status?: string };
    return data.status === 'clean' || data.status === 'infected' ? data.status : 'skipped';
  } catch {
    safeLog('warn', 'document scan hook unreachable');
    return 'skipped';
  }
}

export async function recordScan(env: Partial<Env>, documentId: string, status: ScanResult, fetchImpl?: FetchLike): Promise<void> {
  await restPatch(env, 'onboarding_documents', { id: documentId }, { scan_status: status }, fetchImpl);
}
