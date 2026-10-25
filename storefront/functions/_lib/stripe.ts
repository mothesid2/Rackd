// Minimal Stripe client for Workers (no SDK): Checkout Sessions, coupons, and webhook verification.
//
// COMPLIANCE: Stripe is used ONLY for Rackd's own charges (hardware orders and software fees).
// It is never used to take payment for vape or tobacco products. Before setting
// STRIPE_LIVE_ENABLED=true, confirm Stripe's restricted-business policy for Rackd's business model.

import type { Env } from './env';
import { appBaseUrl, flags } from './env';
import { HttpError } from './http';
import type { FetchLike } from './supabase';
import { timingSafeEqual, toHex } from './token';

const API = 'https://api.stripe.com/v1';

/** Stripe's form encoding: nested objects and arrays become a[b][0][c]=value. */
export function formEncode(obj: Record<string, unknown>): string {
  const parts: string[] = [];
  const walk = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${key}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${key}[${k}]`, x);
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(obj)) walk(k, v);
  return parts.join('&');
}

/**
 * Fail closed on a mode/key mismatch: with STRIPE_LIVE_ENABLED=false only a TEST key may be used, and
 * with it true only a LIVE key. This makes it impossible to charge real cards by accident.
 */
export function stripeKeyFor(env: Partial<Env>): string {
  const key = env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new HttpError(503, 'payments_not_configured');
  const live = flags(env).stripeLive;
  const ok = live ? /^(sk|rk)_live_/.test(key) : /^(sk|rk)_test_/.test(key);
  if (!ok) throw new HttpError(503, 'stripe_mode_mismatch');
  return key;
}

export const stripeConfigured = (env: Partial<Env>): boolean => !!env.STRIPE_SECRET_KEY?.trim();

async function stripe<T>(env: Partial<Env>, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>, opts: { idempotencyKey?: string; fetchImpl?: FetchLike } = {}): Promise<T> {
  const key = stripeKeyFor(env);
  const res = await (opts.fetchImpl ?? fetch)(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      ...(opts.idempotencyKey ? { 'Idempotency-Key': opts.idempotencyKey } : {}),
    },
    body: body ? formEncode(body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: string } } & T;
  if (!res.ok) throw new HttpError(502, 'payment_provider_error', `stripe ${res.status} ${data.error?.code ?? ''}`);
  return data as T;
}

export interface OrderForPayment {
  id: string;
  order_number: string;
  email: string;
  currency: string;
  items: { name: string; sku: string; unit_price_cents: number; quantity: number }[];
  discount_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
}

export interface CheckoutSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired';
  payment_status: 'paid' | 'unpaid' | 'no_payment_required';
  livemode: boolean;
}

/**
 * Builds the Checkout Session for an order. `taxMode` flat: tax is a line item equal to the amount
 * the customer already saw. `stripe_tax`: Stripe calculates tax and the webhook records what it charged.
 */
export function buildSessionParams(env: Partial<Env>, o: OrderForPayment, token: string, taxMode: 'flat' | 'stripe_tax', couponId: string | null): Record<string, unknown> {
  const base = appBaseUrl(env);
  const back = `${base}/hardware/order/${o.id}#t=${token}`;
  const success = `${base}/hardware/order/${o.id}?paid=1#t=${token}`;
  const cur = o.currency || 'usd';
  const lines: Record<string, unknown>[] = o.items.map((i) => ({
    quantity: i.quantity,
    price_data: {
      currency: cur, unit_amount: i.unit_price_cents,
      product_data: { name: i.name, ...(taxMode === 'stripe_tax' ? { tax_code: 'txcd_99999999' } : {}) },
      ...(taxMode === 'stripe_tax' ? { tax_behavior: 'exclusive' } : {}),
    },
  }));
  if (taxMode === 'flat' && o.tax_cents > 0) {
    lines.push({ quantity: 1, price_data: { currency: cur, unit_amount: o.tax_cents, product_data: { name: 'Sales tax' } } });
  }
  return {
    mode: 'payment',
    client_reference_id: o.id,
    customer_email: o.email,
    line_items: lines,
    ...(o.shipping_cents > 0 ? {
      shipping_options: [{ shipping_rate_data: { type: 'fixed_amount', display_name: 'Shipping', fixed_amount: { amount: o.shipping_cents, currency: cur },
        ...(taxMode === 'stripe_tax' ? { tax_behavior: 'exclusive' } : {}) } }],
    } : {}),
    ...(couponId ? { discounts: [{ coupon: couponId }] } : {}),
    ...(taxMode === 'stripe_tax' ? { automatic_tax: { enabled: true }, shipping_address_collection: { allowed_countries: ['US'] } } : {}),
    metadata: { order_id: o.id, order_number: o.order_number },
    payment_intent_data: { metadata: { order_id: o.id, order_number: o.order_number }, description: `Rackd hardware order ${o.order_number}` },
    success_url: success,
    cancel_url: back,
  };
}

/**
 * Returns a payable session URL for the order: reuses an open session, otherwise creates one.
 * Idempotency keys are derived from the order (and the previous session), so a double click or a
 * retry can never create two payable sessions for the same order.
 */
export async function startPayment(env: Partial<Env>, o: OrderForPayment, token: string, taxMode: 'flat' | 'stripe_tax', previousSessionId: string | null, fetchImpl?: FetchLike): Promise<{ url: string; sessionId: string }> {
  if (previousSessionId) {
    const prev = await stripe<CheckoutSession>(env, 'GET', `/checkout/sessions/${encodeURIComponent(previousSessionId)}`, undefined, { fetchImpl });
    if (prev.status === 'open' && prev.url) return { url: prev.url, sessionId: prev.id };
    if (prev.status === 'complete') throw new HttpError(409, 'already_paid');
  }
  const idemBase = `hw-${o.id}-${previousSessionId ?? 'first'}`;
  let couponId: string | null = null;
  if (o.discount_cents > 0) {
    const c = await stripe<{ id: string }>(env, 'POST', '/coupons', {
      amount_off: o.discount_cents, currency: o.currency || 'usd', duration: 'once', max_redemptions: 1, name: 'Bundle discount',
      metadata: { order_id: o.id },
    }, { idempotencyKey: `${idemBase}-coupon`, fetchImpl });
    couponId = c.id;
  }
  const s = await stripe<CheckoutSession>(env, 'POST', '/checkout/sessions', buildSessionParams(env, o, token, taxMode, couponId), { idempotencyKey: `${idemBase}-session`, fetchImpl });
  if (!s.url) throw new HttpError(502, 'payment_provider_error');
  return { url: s.url, sessionId: s.id };
}

// ---------------------------------------------------------------- webhook verification
const TOLERANCE_SECONDS = 300;

/** Verifies a Stripe-Signature header against the raw request body. */
export async function verifyStripeSignature(rawBody: string, header: string | null, secret: string | undefined, nowSeconds = Math.floor(Date.now() / 1000)): Promise<boolean> {
  if (!header || !secret) return false;
  let t = '';
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = v;
    else if (k === 'v1') sigs.push(v);
  }
  if (!/^\d+$/.test(t) || sigs.length === 0) return false;
  if (Math.abs(nowSeconds - Number(t)) > TOLERANCE_SECONDS) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`))));
  return sigs.some((s) => timingSafeEqual(s, mac));
}

/** Test helper and local replay tool: builds a valid header for a body. */
export async function signStripePayload(rawBody: string, secret: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = toHex(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${rawBody}`))));
  return `t=${t},v1=${mac}`;
}
