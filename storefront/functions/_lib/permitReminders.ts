// Daily permit-expiry reminders: one email per owner per bucket (30 days, 7 days), email only.
// The database decides who is due (permits_due_for_notice) and remembers what was sent
// (permit_notices, unique per permit + bucket + expiry date), so running this twice in a day, or
// after a partial failure, never double-sends a reminder that was already recorded.

import { permitReminderEmail, type ReminderItem } from './emailTemplates';
import { sendEmail } from './email';
import type { Env } from './env';
import { safeLog } from './redact';
import { rpc, type FetchLike } from './supabase';

export interface DueRow {
  permit_id: string;
  tenant_id: string;
  location_name: string;
  kind: string;
  number: string | null;
  expiry: string;
  days_before: 30 | 7;
  owner_email: string;
  owner_name: string;
}

export interface RunSummary {
  due: number;
  emails_sent: number;
  emails_failed: number;
  permits_marked: number;
}

const MAX_ROWS = 2000; // safety valve; the next run picks up the remainder

export async function runPermitReminders(env: Partial<Env>, fetchImpl?: FetchLike, today = new Date()): Promise<RunSummary> {
  const rows = (await rpc<DueRow[]>(env, 'permits_due_for_notice', {}, fetchImpl)).slice(0, MAX_ROWS);
  const groups = new Map<string, DueRow[]>();
  for (const r of rows) {
    const k = `${r.owner_email.toLowerCase()}|${r.days_before}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }

  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const summary: RunSummary = { due: rows.length, emails_sent: 0, emails_failed: 0, permits_marked: 0 };

  for (const group of groups.values()) {
    const first = group[0];
    const items: ReminderItem[] = group
      .map((r) => ({
        location: r.location_name, kind: r.kind, number: r.number, expiry: r.expiry,
        daysLeft: Math.round((Date.parse(`${r.expiry}T00:00:00Z`) - startOfToday) / 86400000),
      }))
      .sort((a, b) => a.daysLeft - b.daysLeft);

    const mail = await sendEmail(env, { to: first.owner_email, ...permitReminderEmail(env, first.owner_name, first.days_before, items) }, fetchImpl);
    if (!mail.sent) {
      // Not recorded, so tomorrow's run tries again.
      summary.emails_failed++;
      continue;
    }
    summary.emails_sent++;
    for (const r of group) {
      try {
        await rpc(env, 'permit_notice_mark', { p_permit: r.permit_id, p_days: r.days_before, p_expiry: r.expiry }, fetchImpl);
        summary.permits_marked++;
      } catch (e) {
        safeLog('error', 'could not record a sent permit reminder (it may be re-sent)', e);
      }
    }
  }

  try {
    await rpc(env, 'write_audit', {
      p_action: 'permit_reminders.run', p_entity: 'business_permits', p_entity_id: null, p_before: null, p_after: summary, p_actor: null,
    }, fetchImpl);
  } catch { /* the run itself succeeded; the audit row is best effort */ }
  safeLog('info', 'permit reminder run finished', summary);
  return summary;
}
