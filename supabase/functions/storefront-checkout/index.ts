// storefront-checkout — the guarded entry to payment.
//
// Runs the atomic reserve (age-gate + oversell, as the CUSTOMER so auth.uid()
// resolves), then creates a Stripe PaymentIntent for the reserved order total.
// Age verification and stock are enforced in the DB (reserve_online_order); this
// function only orchestrates + talks to Stripe. Returns the PaymentIntent client
// secret for the storefront to confirm.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@14';
import { CORS, json } from '../_shared/notify.ts';
import { rateLimited, clientIp } from '../_shared/rateLimit.ts';

// Repeated reservation attempts create real Stripe API calls and briefly
// hold stock (reserve_online_order deducts availability for the order's
// lifetime) — a scripted loop could both rack up Stripe API usage and deny
// stock to real customers (audit batch 8, item 9).
const IP_LIMIT = 12, IP_WINDOW_MS = 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  if (rateLimited(clientIp(req), IP_LIMIT, IP_WINDOW_MS)) return json({ error: 'Too many requests. Try again shortly.' }, 429);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!stripeKey) return json({ error: 'payments not configured' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  const userClient = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: { user } } = await userClient.auth.getUser();
  if (!user) return json({ error: 'not authenticated' }, 401);

  let body: { tenant_id?: string; location_id?: string; items?: { barcode: string; qty: number }[] };
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const { tenant_id, location_id, items } = body;
  if (!tenant_id || !location_id || !Array.isArray(items) || items.length === 0) {
    return json({ error: 'tenant_id, location_id and items are required' }, 400);
  }

  // Atomic age-gate + oversell reservation (as the customer).
  const { data: orderId, error: rErr } = await userClient.rpc('reserve_online_order', {
    p_tenant: tenant_id, p_location: location_id, p_items: items,
  });
  if (rErr) {
    const m = rErr.message || '';
    if (m.includes('age_verification_required')) return json({ error: 'age_verification_required' }, 403);
    if (m.includes('insufficient_stock:')) return json({ error: 'insufficient_stock', barcode: m.split('insufficient_stock:')[1] }, 409);
    if (m.includes('item_unavailable:')) return json({ error: 'item_unavailable', barcode: m.split('item_unavailable:')[1] }, 409);
    if (m.includes('location_not_available')) return json({ error: 'location_not_available' }, 409);
    return json({ error: m }, 400);
  }

  const admin = createClient(url, svc, { auth: { persistSession: false } });
  const { data: order } = await admin.from('online_orders').select('total, online_fee').eq('id', orderId).single();
  const { data: prof } = await admin.from('storefront_customers').select('stripe_customer_id, email').eq('id', user.id).single();

  // Connect: the location's Express account must exist + be onboarded to accept
  // funds. The 5% online fee routes to the platform; the rest settles to the store.
  const { data: locRow } = await admin
    .from('locations').select('stripe_account_id, stripe_onboarding_complete').eq('id', location_id).single();
  if (!locRow?.stripe_account_id || !locRow.stripe_onboarding_complete) {
    await admin.from('online_orders').update({ status: 'cancelled', cancel_reason: 'store_not_ready' }).eq('id', orderId);
    return json({ error: 'store_not_accepting_online' }, 409);
  }

  const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
  let stripeCustomer = prof?.stripe_customer_id as string | null;
  if (!stripeCustomer) {
    const c = await stripe.customers.create({ email: prof?.email || user.email, metadata: { sf_customer: user.id } });
    stripeCustomer = c.id;
    await admin.from('storefront_customers').update({ stripe_customer_id: stripeCustomer }).eq('id', user.id);
  }

  const amount = Math.round(Number(order?.total || 0) * 100);
  const feeAmount = Math.round(Number(order?.online_fee || 0) * 100);
  if (amount <= 0) { await admin.from('online_orders').update({ status: 'cancelled', cancel_reason: 'empty' }).eq('id', orderId); return json({ error: 'empty order' }, 400); }

  // Destination charge: platform keeps the 5% (application_fee_amount); the rest
  // settles to the location's connected account, which bears Stripe's processing
  // fee (on_behalf_of makes it the merchant of record).
  const pi = await stripe.paymentIntents.create({
    amount, currency: 'usd', customer: stripeCustomer,
    automatic_payment_methods: { enabled: true },
    application_fee_amount: feeAmount,
    on_behalf_of: locRow.stripe_account_id as string,
    transfer_data: { destination: locRow.stripe_account_id as string },
    metadata: { order_id: orderId as string, tenant_id, location_id },
  });
  await admin.from('online_orders').update({ stripe_payment_intent_id: pi.id }).eq('id', orderId);

  return json({ order_id: orderId, client_secret: pi.client_secret, amount });
});
