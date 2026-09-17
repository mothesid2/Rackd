


import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'https://esm.sh/stripe@14?target=deno';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

const TRIAL_DAYS = 14;
const PLANS = ['core', 'standard', 'pro'] as const;

function priceId(plan: string, cycle: string): string | null {
  const key = `STRIPE_PRICE_${plan.toUpperCase()}_${cycle === 'annual' ? 'ANNUAL' : 'MONTHLY'}`;
  return Deno.env.get(key) || null;
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }

  if (String(body.admin_secret || '') !== (Deno.env.get('ADMIN_SECRET') || '\0')) {
    return json({ error: 'unauthorized' }, 401);
  }
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!stripeKey) return json({ error: 'billing not configured (STRIPE_SECRET_KEY missing)' }, 500);

  const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20', httpClient: Stripe.createFetchHttpClient() });
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const action = String(body.action || '');
  const licenseKey = String(body.license_key || '');

  try {
    const { data: lic } = await admin
      .from('licenses')
      .select('license_key, tenant_id, name, stripe_customer_id, plan, billing_cycle, subscription_status, trial_ends_at, current_period_end, grace_until, active')
      .eq('license_key', licenseKey)
      .maybeSingle();
    if (!lic && action !== 'status') return json({ error: 'license not found' }, 404);

    switch (action) {
      case 'status':
        return json({ billing: lic || null });

      case 'checkout': {
        const plan = String(body.plan || 'standard').toLowerCase();
        const cycle = String(body.cycle || 'monthly').toLowerCase();
        if (!PLANS.includes(plan as typeof PLANS[number])) return json({ error: `unknown plan '${plan}'` }, 400);
        const price = priceId(plan, cycle);
        if (!price) return json({ error: `no Stripe price configured for ${plan}/${cycle}` }, 400);

        
        let customerId = lic!.stripe_customer_id as string | null;
        if (!customerId) {
          const cust = await stripe.customers.create({
            name: (lic!.name as string) || licenseKey,
            metadata: { license_key: licenseKey, tenant_id: String(lic!.tenant_id || '') },
          });
          customerId = cust.id;
          await admin.from('licenses').update({ stripe_customer_id: customerId }).eq('license_key', licenseKey);
        }

        const session = await stripe.checkout.sessions.create({
          mode: 'subscription',
          customer: customerId,
          line_items: [{ price, quantity: 1 }],
          
          subscription_data: { trial_period_days: TRIAL_DAYS, metadata: { license_key: licenseKey, plan, billing_cycle: cycle } },
          payment_method_collection: 'always',
          success_url: Deno.env.get('BILLING_SUCCESS_URL') || 'https://rackd.io/billing/success',
          cancel_url: Deno.env.get('BILLING_CANCEL_URL') || 'https://rackd.io/billing/cancel',
          metadata: { license_key: licenseKey, plan, billing_cycle: cycle },
        });
        return json({ url: session.url });
      }

      case 'portal': {
        const customerId = lic!.stripe_customer_id as string | null;
        if (!customerId) return json({ error: 'no billing account yet — start a subscription first' }, 400);
        const portal = await stripe.billingPortal.sessions.create({
          customer: customerId,
          return_url: (body.return_url as string) || Deno.env.get('BILLING_SUCCESS_URL') || 'https://rackd.io/billing',
        });
        return json({ url: portal.url });
      }

      default:
        return json({ error: `unknown action '${action}'` }, 400);
    }
  } catch (err) {
    return json({ error: String((err as Error)?.message || err) }, 500);
  }
});
