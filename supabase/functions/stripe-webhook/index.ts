


import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14?target=deno';

const stripe = new Stripe(Deno.env.get('STRIPE_SECRET_KEY')!, {
  apiVersion: '2024-06-20',
  httpClient: Stripe.createFetchHttpClient(),
});
const cryptoProvider = Stripe.createSubtleCryptoProvider();
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false },
});

const DAY = 86400000;
const iso = (ms: number) => new Date(ms).toISOString();


function projectStatus(s: string, graceUntil: string | null): { subscription_status: string; active: boolean } {
  switch (s) {
    case 'trialing': return { subscription_status: 'trialing', active: true };
    case 'active':   return { subscription_status: 'active', active: true };
    case 'past_due': {
      
      const inGrace = graceUntil ? Date.now() < new Date(graceUntil).getTime() : true;
      return { subscription_status: 'past_due', active: inGrace };
    }
    case 'unpaid':   return { subscription_status: 'suspended', active: false };
    case 'canceled': return { subscription_status: 'canceled', active: false };
    default:         return { subscription_status: s || 'incomplete', active: false };
  }
}

async function updateByCustomer(customerId: string, patch: Record<string, unknown>, type: string, data: unknown) {
  const { data: lic } = await admin.from('licenses')
    .update(patch).eq('stripe_customer_id', customerId)
    .select('license_key, tenant_id').maybeSingle();
  await admin.from('billing_events').insert({
    license_key: lic?.license_key ?? null, tenant_id: lic?.tenant_id ?? null, type, data,
  });
}

Deno.serve(async (req: Request) => {
  const sig = req.headers.get('stripe-signature');
  const secret = Deno.env.get('STRIPE_WEBHOOK_SECRET');
  const raw = await req.text();
  if (!sig || !secret) return new Response('missing signature/secret', { status: 400 });

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig, secret, undefined, cryptoProvider);
  } catch (err) {
    return new Response(`signature verification failed: ${String(err)}`, { status: 400 });
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const s = event.data.object as Stripe.Checkout.Session;
        const customerId = String(s.customer);
        const subId = String(s.subscription);
        const sub = await stripe.subscriptions.retrieve(subId);
        const proj = projectStatus(sub.status, null);
        await updateByCustomer(customerId, {
          stripe_subscription_id: subId,
          plan: (s.metadata?.plan as string) || (sub.metadata?.plan as string) || null,
          billing_cycle: (s.metadata?.billing_cycle as string) || null,
          trial_ends_at: sub.trial_end ? iso(sub.trial_end * 1000) : null,
          current_period_end: sub.current_period_end ? iso(sub.current_period_end * 1000) : null,
          canceled_at: null, purge_after: null, grace_until: null,
          ...proj,
        }, event.type, { subscription_id: subId, status: sub.status });
        break;
      }

      case 'customer.subscription.updated': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = String(sub.customer);
        
        const { data: cur } = await admin.from('licenses')
          .select('grace_until').eq('stripe_customer_id', customerId).maybeSingle();
        const proj = projectStatus(sub.status, cur?.grace_until ?? null);
        await updateByCustomer(customerId, {
          stripe_subscription_id: sub.id,
          plan: (sub.metadata?.plan as string) || undefined,
          current_period_end: sub.current_period_end ? iso(sub.current_period_end * 1000) : null,
          cancel_at: sub.cancel_at ? iso(sub.cancel_at * 1000) : null,
          trial_ends_at: sub.trial_end ? iso(sub.trial_end * 1000) : null,
          ...proj,
        }, event.type, { status: sub.status });
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = String(inv.customer);
        
        await updateByCustomer(customerId, {
          subscription_status: 'past_due',
          grace_until: iso(Date.now() + 7 * DAY),
          active: true,
        }, event.type, { invoice: inv.id, attempt: inv.attempt_count });
        break;
      }

      case 'invoice.paid': {
        const inv = event.data.object as Stripe.Invoice;
        const customerId = String(inv.customer);
        await updateByCustomer(customerId, {
          subscription_status: 'active', active: true, grace_until: null,
        }, event.type, { invoice: inv.id });
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object as Stripe.Subscription;
        const customerId = String(sub.customer);
        
        await updateByCustomer(customerId, {
          subscription_status: 'canceled', active: false,
          canceled_at: iso(Date.now()), purge_after: iso(Date.now() + 90 * DAY),
        }, event.type, { subscription_id: sub.id });
        break;
      }
    }
    return new Response(JSON.stringify({ received: true }), { status: 200 });
  } catch (err) {
    return new Response(`handler error: ${String((err as Error)?.message || err)}`, { status: 500 });
  }
});
