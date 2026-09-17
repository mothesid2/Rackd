

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@14';
import { CORS, json, sendSms, sendEmail, emailShell } from '../_shared/notify.ts';

const PAID = ['new', 'preparing', 'ready'];

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const authHeader = req.headers.get('Authorization') ?? '';

  let body: { order_id?: string; status?: string; cancel_reason?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const orderId = body.order_id;
  const status = body.status || 'ready';
  if (!orderId || !['preparing', 'ready', 'cancelled'].includes(status)) return json({ error: 'order_id + valid status required' }, 400);

  const admin = createClient(url, svc, { auth: { persistSession: false } });

  
  
  const { data: pre } = await admin.from('online_orders')
    .select('status, stripe_payment_intent_id, tenant_id, location_id').eq('id', orderId).maybeSingle();

  
  const staff = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const patch: Record<string, unknown> = { status };
  if (status === 'ready') patch.ready_at = new Date().toISOString();
  if (status === 'cancelled') patch.cancel_reason = body.cancel_reason || 'store_cancelled';
  const { data: updated, error } = await staff.from('online_orders').update(patch).eq('id', orderId).select('id, order_number, customer_id').maybeSingle();
  if (error) return json({ error: error.message }, 400);
  if (!updated) return json({ error: 'not found or not authorized' }, 403);

  
  let refunded = false;
  if (status === 'cancelled' && pre && PAID.includes(pre.status)) {
    if (pre.stripe_payment_intent_id) {
      const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
      if (stripeKey) {
        try {
          const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });
          await stripe.refunds.create({ payment_intent: pre.stripe_payment_intent_id });
          refunded = true;
        } catch (e) { console.error('refund failed', String(e)); }
      }
    }
    
    const { data: items } = await admin.from('online_order_items').select('barcode, qty').eq('order_id', orderId);
    for (const it of items ?? []) {
      if (!it.barcode) continue;
      await admin.from('stock_movements_cloud').insert({
        movement_uid: crypto.randomUUID(), tenant_id: pre.tenant_id, location_id: pre.location_id,
        register_id: 'online', barcode: it.barcode, delta: Math.abs(it.qty || 1),
        reason: 'online_order_cancel', created_at: new Date().toISOString(),
      });
    }
  }

  const { data: cust } = await admin.from('storefront_customers').select('phone, email, first_name').eq('id', updated.customer_id).single();
  const hi = cust?.first_name ? `Hi ${cust.first_name}, ` : '';
  if (status === 'ready') {
    await sendSms(cust?.phone, `Your order #${updated.order_number} is ready for pickup! Bring a valid ID (21+).`);
    await sendEmail(cust?.email, `Order #${updated.order_number} is ready for pickup`,
      emailShell('Your order is ready 🎉', `<p>${hi}your order <strong>#${updated.order_number}</strong> is ready to pick up in store.</p>`));
  } else if (status === 'cancelled') {
    await sendSms(cust?.phone, `Your order #${updated.order_number} was cancelled${refunded ? ' and refunded' : ''}.`);
    await sendEmail(cust?.email, `Order #${updated.order_number} was cancelled`,
      emailShell('Order cancelled', `<p>${hi}your order <strong>#${updated.order_number}</strong> was cancelled${refunded ? ' and your payment has been refunded' : ''}.</p>`));
  }

  return json({ success: true, status, refunded });
});
