// Drains storefront_outbox: claims rows (row-locked, attempt-counted), emails them, records the result.
// Safe to run concurrently (rows are claimed with SKIP LOCKED) and repeatedly (a sent row is never re-sent).

import { sendEmail } from './email';
import type { Env } from './env';
import { safeLog } from './redact';
import { customerReservationEmail, shopNewReservationEmail, type CustomerKind, type OutboxPayload } from './storefrontEmails';
import { rpc, type FetchLike } from './supabase';

interface Claimed {
  id: number;
  kind: string;
  audience: 'shop' | 'customer';
  payload: OutboxPayload;
}

export interface OutboxSummary { claimed: number; sent: number; skipped: number; failed: number }

export async function processOutbox(env: Partial<Env>, limit = 20, fetchImpl?: FetchLike): Promise<OutboxSummary> {
  const rows = await rpc<Claimed[]>(env, 'sf_outbox_claim', { p_limit: limit }, fetchImpl);
  const s: OutboxSummary = { claimed: rows.length, sent: 0, skipped: 0, failed: 0 };
  for (const row of rows) {
    const p = row.payload;
    let to: string | null;
    let mail: ReturnType<typeof shopNewReservationEmail>;
    if (row.audience === 'shop') {
      // a shop that switched email notifications off still sees the order on its board
      if (!p.notify_email) { await rpc(env, 'sf_outbox_done', { p_id: row.id, p_ok: true }, fetchImpl); s.skipped++; continue; }
      to = p.shop_email;
      mail = shopNewReservationEmail(env, p);
    } else {
      to = p.customer_email;
      mail = customerReservationEmail(row.kind as CustomerKind, p);
    }
    if (!to) {
      // nobody to tell: close the row instead of retrying forever
      await rpc(env, 'sf_outbox_done', { p_id: row.id, p_ok: true }, fetchImpl);
      s.skipped++;
      continue;
    }
    const r = await sendEmail(env, { to, ...mail }, fetchImpl);
    if (r.sent) {
      await rpc(env, 'sf_outbox_done', { p_id: row.id, p_ok: true }, fetchImpl);
      s.sent++;
    } else {
      await rpc(env, 'sf_outbox_done', { p_id: row.id, p_ok: false, p_error: r.reason ?? 'send failed' }, fetchImpl);
      s.failed++;
    }
  }
  if (rows.length) safeLog('info', 'storefront outbox run', s);
  return s;
}
