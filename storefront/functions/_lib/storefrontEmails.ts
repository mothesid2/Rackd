// Reservation emails. All wording lives in STOREFRONT_EMAIL_TEXT so a shop's copy can be changed in one place
// (these are editable constants; a per-shop override UI can read the same keys later).
// SMS is intentionally not implemented here: it stays behind SMS_ENABLED=false.

import { button, escapeHtml, shell, type EmailMessage } from './email';
import type { Env } from './env';

type Tpl = Pick<EmailMessage, 'subject' | 'html'>;

export const STOREFRONT_EMAIL_TEXT = {
  shopNewSubject: (code: string) => `New online reservation ${code}`,
  shopNewIntro: 'A customer reserved items for pickup. Open the Storefront Manager to confirm it.',
  confirmedSubject: (code: string) => `Your reservation ${code} is confirmed`,
  confirmedIntro: 'The shop confirmed your reservation and is getting it ready.',
  readySubject: (code: string) => `Your reservation ${code} is ready for pickup`,
  readyIntro: 'Your items are ready. Come in any time before your hold expires.',
  cancelledSubject: (code: string) => `Your reservation ${code} was cancelled`,
  cancelledIntro: 'Your reservation was cancelled. You were not charged.',
  noShowSubject: (code: string) => `Your reservation ${code} expired`,
  noShowIntro: 'Your reservation was not picked up before the hold expired, so it was released.',
  changedSubject: (code: string) => `Update to your reservation ${code}`,
  changedIntro: 'An item on your reservation was not available. The shop updated your order.',
  idReminder: 'Bring a valid government photo ID. You must be 21 or older, and the shop will check your ID at pickup.',
  payAtPickup: 'You pay at the shop when you pick up. The reservation fee is added to your total.',
} as const;

const usd = (n: number | string) => Number(n).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export interface ReservationPayload {
  code: string;
  customer_name: string | null;
  subtotal: number | string;
  fee_amount: number | string;
  total: number | string;
  fee_waived?: boolean;
  hold_expires_at: string;
  cancel_reason?: string | null;
  notes?: string | null;
  items: { name: string; qty: number; unit_price: number | string; line_total: number | string; is_removed?: boolean }[];
}

export interface OutboxPayload {
  reservation: ReservationPayload;
  location_name: string;
  pickup_instructions: string | null;
  notify_email: boolean;
  customer_email: string | null;
  shop_email: string | null;
}

function itemsTable(r: ReservationPayload): string {
  const rows = r.items.filter((i) => !i.is_removed).map((i) =>
    `<tr><td style="padding:4px 0">${i.qty} × ${escapeHtml(i.name)}</td><td align="right" style="padding:4px 0">${usd(i.line_total)}</td></tr>`).join('');
  const fee = r.fee_waived ? 'waived' : usd(r.fee_amount);
  return `<table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse">${rows}
<tr><td style="padding:4px 0;border-top:1px solid #333">Subtotal</td><td align="right" style="border-top:1px solid #333">${usd(r.subtotal)}</td></tr>
<tr><td style="padding:4px 0">Reservation fee</td><td align="right">${fee}</td></tr>
<tr><td style="padding:4px 0;font-weight:700;border-top:1px solid #333">Total (pay at pickup)</td><td align="right" style="font-weight:700;border-top:1px solid #333">${usd(r.total)}</td></tr></table>`;
}

const holdText = (iso: string) => new Date(iso).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });

export function shopNewReservationEmail(env: Partial<Env>, p: OutboxPayload): Tpl {
  const r = p.reservation;
  const T = STOREFRONT_EMAIL_TEXT;
  const url = env.MANAGE_BASE_URL?.trim() || 'https://manage.r4ckd.net';
  return {
    subject: T.shopNewSubject(r.code),
    html: shell(`New reservation ${r.code}`, `<p>${escapeHtml(T.shopNewIntro)}</p>
<p><strong>${escapeHtml(r.customer_name ?? 'Customer')}</strong> · hold until ${escapeHtml(holdText(r.hold_expires_at))}</p>${itemsTable(r)}
${r.notes ? `<p style="font-size:13px;color:#9a9da3">Customer note: ${escapeHtml(r.notes)}</p>` : ''}${button(url, 'Open Storefront Manager')}`),
  };
}

export type CustomerKind = 'confirmed' | 'ready' | 'cancelled' | 'no_show' | 'items_changed';

export function customerReservationEmail(kind: CustomerKind, p: OutboxPayload): Tpl {
  const r = p.reservation;
  const T = STOREFRONT_EMAIL_TEXT;
  const pick = {
    confirmed: [T.confirmedSubject(r.code), T.confirmedIntro],
    ready: [T.readySubject(r.code), T.readyIntro],
    cancelled: [T.cancelledSubject(r.code), T.cancelledIntro],
    no_show: [T.noShowSubject(r.code), T.noShowIntro],
    items_changed: [T.changedSubject(r.code), T.changedIntro],
  }[kind];
  const open = kind === 'confirmed' || kind === 'ready' || kind === 'items_changed';
  const reason = kind === 'cancelled' && r.cancel_reason ? `<p style="background:#0c0d0f;padding:10px 14px;border-radius:8px">Reason: ${escapeHtml(r.cancel_reason)}</p>` : '';
  return {
    subject: pick[0],
    html: shell(`${escapeHtml(p.location_name)}`, `<p>${escapeHtml(pick[1])}</p>${reason}${itemsTable(r)}
${open ? `<p style="margin-top:14px">${escapeHtml(T.payAtPickup)}</p><p>${escapeHtml(T.idReminder)}</p>` : ''}
${kind === 'ready' && p.pickup_instructions ? `<p style="background:#0c0d0f;padding:10px 14px;border-radius:8px"><strong>Pickup:</strong> ${escapeHtml(p.pickup_instructions)}</p>` : ''}
${open ? `<p style="font-size:13px;color:#9a9da3">Held until ${escapeHtml(holdText(r.hold_expires_at))}. Order ${escapeHtml(r.code)}.</p>` : ''}`),
  };
}
