'use client';
import { useEffect, useState } from 'react';
import type { PriceError } from './pricing';

export class HwApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly problems?: PriceError[]) { super(code); }
}

async function post<T>(path: string, body: Record<string, unknown>): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/hardware/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new HwApiError(0, 'network_error');
  }
  const data = (await res.json().catch(() => ({}))) as { error?: string; problems?: PriceError[] };
  if (!res.ok) throw new HwApiError(res.status, data.error ?? 'request_failed', data.problems);
  return data as T;
}

export interface CheckoutInput {
  cart: { items: { sku: string; qty: number }[]; bundle?: string | null };
  shipping_method: string;
  email: string;
  address: { full_name: string; company?: string; line1: string; line2?: string; city: string; state: string; zip: string; phone?: string };
  notes?: string;
  application_token?: string | null;
  turnstileToken: string;
}
export interface CheckoutResult {
  order_id: string; order_number: string; access_token: string; total_cents: number; tax_pending: boolean; test_mode: boolean;
  /** present once Stripe Checkout is wired (milestone 7) */
  redirect_url?: string;
}

export interface OrderDto {
  id: string; order_number: string; status: 'pending' | 'paid' | 'fulfilled' | 'shipped' | 'cancelled' | 'refunded'; email: string;
  subtotal_cents: number; discount_cents: number; shipping_cents: number; tax_cents: number; total_cents: number;
  is_test: boolean; notes: string | null; shipping_method: string | null; carrier: string | null; tracking_number: string | null;
  created_at: string; paid_at: string | null; shipped_at: string | null;
  address: { full_name: string; company: string | null; line1: string; line2: string | null; city: string; state: string; zip: string };
  items: { name: string; sku: string; unit_price_cents: number; quantity: number }[];
}

export const hw = {
  checkout: (b: CheckoutInput) => post<CheckoutResult>('checkout', b as unknown as Record<string, unknown>),
  order: (id: string, token: string) => post<OrderDto>('order', { id, token }),
  mode: () => post<{ test_mode: boolean }>('mode', {}),
};

const MESSAGES: Record<string, string> = {
  network_error: 'We could not reach the server. Check your connection and try again.',
  rate_limited: 'Too many attempts. Please wait a few minutes and try again.',
  bot_check_failed: 'We could not verify you are human. Please try the check again.',
  cart_invalid: 'Something in your cart changed. Review the items below.',
  email_invalid: 'Enter a valid email address.',
  zip_invalid: 'Enter a 5-digit ZIP code.',
  invalid_token: 'We could not find that order. Use the link from your confirmation email.',
  server_not_configured: 'Checkout is not available yet. Please try again later.',
};
export const hwMessage = (e: unknown) => (e instanceof HwApiError && MESSAGES[e.code]) || 'Something went wrong. Please try again.';

/** true while the server says STRIPE_LIVE_ENABLED is off (shows the visible test-mode notice). */
export function useTestMode(): boolean | null {
  const [m, setM] = useState<boolean | null>(null);
  useEffect(() => {
    let off = false;
    hw.mode().then((r) => { if (!off) setM(r.test_mode); }).catch(() => { if (!off) setM(true); }); // unknown => assume test, the safe default
    return () => { off = true; };
  }, []);
  return m;
}
