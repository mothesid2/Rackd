// Processes verified Stripe events. Every branch is safe to run twice (the database functions are
// idempotent), because Stripe delivers at-least-once and a crashed attempt is retried.

import { adminOrderEmail, orderConfirmationEmail, sendEmail, type OrderEmailData } from './email';
import type { Env } from './env';
import { safeLog } from './redact';
import { taxModeOf } from './payments';
import { rpc, type FetchLike } from './supabase';
import { randomToken, sha256Hex } from './token';

export interface StripeEvent {
  id: string;
  type: string;
  livemode: boolean;
  data: { object: Record<string, any> };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const usd = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export type EventOutcome = 'paid' | 'already_paid' | 'refunded' | 'refund_noted' | 'ignored';

export async function processStripeEvent(env: Partial<Env>, ev: StripeEvent, fetchImpl?: FetchLike): Promise<EventOutcome> {
  switch (ev.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return onSessionPaid(env, ev, fetchImpl);
    case 'charge.refunded':
      return onRefund(env, ev, fetchImpl);
    default:
      return 'ignored';
  }
}

async function onSessionPaid(env: Partial<Env>, ev: StripeEvent, fetchImpl?: FetchLike): Promise<EventOutcome> {
  const s = ev.data.object;
  // "completed" can fire before funds clear for delayed methods; only paid sessions fulfil an order.
  if (s.payment_status !== 'paid') return 'ignored';
  const orderId: unknown = s.client_reference_id ?? s.metadata?.order_id;
  if (typeof orderId !== 'string' || !UUID.test(orderId)) {
    safeLog('warn', 'paid session without a valid order id', { event: ev.id });
    return 'ignored';
  }

  const res = await rpc<{ changed: boolean; order_number: string; is_test: boolean; oversold?: string[]; amount_changed?: boolean }>(env, 'hw_mark_paid', {
    p_order: orderId, p_session: s.id,
    p_payment_intent: typeof s.payment_intent === 'string' ? s.payment_intent : null,
    p_amount_total: Number.isInteger(s.amount_total) ? s.amount_total : null,
    p_amount_tax: Number.isInteger(s.total_details?.amount_tax) ? s.total_details.amount_tax : null,
    p_livemode: ev.livemode === true,
  }, fetchImpl);
  if (!res.changed) return 'already_paid';

  // A fresh emailed token, so the confirmation link works even if the browser token is long gone.
  const emailToken = randomToken();
  const hash = await sha256Hex(emailToken);
  await rpc(env, 'hw_issue_email_token', { p_order: orderId, p_hash: hash }, fetchImpl);
  const order = await rpc<OrderEmailData & { email: string }>(env, 'hw_get_order', { p_id: orderId, p_token_hash: hash }, fetchImpl);

  await sendEmail(env, { to: order.email, ...orderConfirmationEmail(env, order, emailToken) }, fetchImpl);

  const notes: string[] = [];
  if (res.oversold?.length) notes.push(`Oversold at payment, restock or contact the customer: ${res.oversold.join(', ')}`);
  if (res.amount_changed && (await taxModeOf(env, fetchImpl)) === 'flat') {
    notes.push(`Stripe charged ${usd(order.total_cents)}, which differs from the amount shown at checkout. Check this order.`);
  }
  if (env.ADMIN_NOTIFY_EMAIL) await sendEmail(env, { to: env.ADMIN_NOTIFY_EMAIL, ...adminOrderEmail(order, notes) }, fetchImpl);
  safeLog('info', 'hardware order paid', { order: res.order_number, test: res.is_test });
  return 'paid';
}

async function onRefund(env: Partial<Env>, ev: StripeEvent, fetchImpl?: FetchLike): Promise<EventOutcome> {
  const c = ev.data.object;
  if (typeof c.payment_intent !== 'string') return 'ignored';
  const full = c.refunded === true || (Number.isInteger(c.amount) && Number.isInteger(c.amount_refunded) && c.amount_refunded >= c.amount);
  const note = `${full ? 'Full' : 'Partial'} refund of ${usd(c.amount_refunded ?? 0)} recorded by Stripe (${new Date().toISOString().slice(0, 10)})`;
  const r = await rpc<{ found: boolean; changed: boolean; order_number?: string }>(env, 'hw_mark_refunded', { p_payment_intent: c.payment_intent, p_full: full, p_note: note }, fetchImpl);
  if (!r.found) return 'ignored';
  if (env.ADMIN_NOTIFY_EMAIL) {
    await sendEmail(env, { to: env.ADMIN_NOTIFY_EMAIL, subject: `Refund on hardware order ${r.order_number}`, html: `<p>${note}.</p><p>Stock is not restocked automatically.</p>` }, fetchImpl);
  }
  return r.changed ? 'refunded' : 'refund_noted';
}
