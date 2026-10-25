// Starts (or resumes) payment for a pending hardware order.

import { restSelect, rpc, type FetchLike } from './supabase';
import type { Env } from './env';
import { HttpError } from './http';
import { safeLog } from './redact';
import { startPayment, type OrderForPayment } from './stripe';

export interface OrderRow extends OrderForPayment {
  status: string;
  is_test: boolean;
  stripe_session_id: string | null;
}

export async function taxModeOf(env: Partial<Env>, fetchImpl?: FetchLike): Promise<'flat' | 'stripe_tax'> {
  const rows = await restSelect<{ value: { mode?: string } }[]>(env, 'app_config', 'select=value&key=eq.hardware_tax', fetchImpl);
  return rows[0]?.value?.mode === 'stripe_tax' ? 'stripe_tax' : 'flat';
}

/** Creates/reuses the Stripe Checkout Session for a PENDING order and remembers its id. */
export async function beginPayment(env: Partial<Env>, order: OrderRow, token: string, fetchImpl?: FetchLike): Promise<string> {
  if (order.status !== 'pending') throw new HttpError(409, 'not_payable');
  const mode = await taxModeOf(env, fetchImpl);
  const { url, sessionId } = await startPayment(env, order, token, mode, order.stripe_session_id, fetchImpl);
  if (sessionId !== order.stripe_session_id) await rpc(env, 'hw_set_session', { p_order: order.id, p_session: sessionId }, fetchImpl);
  safeLog('info', 'payment session ready', { order: order.order_number });
  return url;
}
