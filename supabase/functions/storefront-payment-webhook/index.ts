// storefront-payment-webhook — Stripe PaymentIntent events for online orders.
//
// On success: mark the order 'new' (enters the store queue), emit a negative
// stock_movement per item so the POS pull path decrements register stock, and SMS
// the customer. On failure/cancel: cancel the order, which releases the reserved
// stock (storefront_available ignores cancelled orders).
//
// Separate from the billing stripe-webhook so subscription + storefront concerns
// stay isolated (own endpoint + signing secret STRIPE_STOREFRONT_WEBHOOK_SECRET).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@14';
import { sendSms, sendEmail, emailShell } from '../_shared/notify.ts';

Deno.serve(async (req: Request) => {
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  const whSecret = Deno.env.get('STRIPE_STOREFRONT_WEBHOOK_SECRET');
  if (!stripeKey || !whSecret) return new Response('not configured', { status: 500 });

  const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
  const sig = req.headers.get('stripe-signature') ?? '';
  const raw = await req.text();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, whSecret);
  } catch (e) {
    return new Response(`bad signature: ${String(e)}`, { status: 400 });
  }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object as Stripe.PaymentIntent;
    const orderId = pi.metadata?.order_id;
    if (!orderId) return new Response('ok', { status: 200 });

    const { data: order } = await admin.from('online_orders')
      .select('id, tenant_id, location_id, customer_id, status, order_number').eq('id', orderId).single();
    if (!order || order.status !== 'pending_payment') return new Response('ok', { status: 200 }); // idempotent

    await admin.from('online_orders').update({ status: 'new' }).eq('id', orderId);

    // Decrement register stock via the existing movement pull path.
    const { data: itemRows } = await admin.from('online_order_items').select('barcode, qty, name').eq('order_id', orderId);
    for (const it of itemRows ?? []) {
      if (!it.barcode) continue;
      await admin.from('stock_movements_cloud').insert({
        movement_uid: crypto.randomUUID(), tenant_id: order.tenant_id, location_id: order.location_id,
        register_id: 'online', barcode: it.barcode, delta: -Math.abs(it.qty || 1),
        reason: 'online_order', created_at: new Date().toISOString(),
      });
    }

    const { data: cust } = await admin.from('storefront_customers').select('phone, email, first_name').eq('id', order.customer_id).single();
    await sendSms(cust?.phone, `Your order #${order.order_number} is confirmed. We'll text you when it's ready for pickup.`);
    const itemsHtml = (itemRows ?? []).map((it) => `<li>${it.qty || 1} × ${it.name || it.barcode}</li>`).join('');
    const hi = cust?.first_name ? `Hi ${cust.first_name}, ` : '';
    await sendEmail(cust?.email, `Order #${order.order_number} confirmed`,
      emailShell('Order confirmed ✅', `<p>${hi}thanks for your order <strong>#${order.order_number}</strong>. We'll email and text you when it's ready for pickup.</p>${itemsHtml ? `<ul style="padding-left:18px">${itemsHtml}</ul>` : ''}`));
  }

  if (event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') {
    const pi = event.data.object as Stripe.PaymentIntent;
    const orderId = pi.metadata?.order_id;
    if (orderId) {
      await admin.from('online_orders').update({ status: 'cancelled', cancel_reason: 'payment_failed' })
        .eq('id', orderId).eq('status', 'pending_payment');
    }
  }

  return new Response('ok', { status: 200 });
});
