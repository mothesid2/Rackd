

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import Stripe from 'npm:stripe@14';
import { CORS, json } from '../_shared/notify.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anon = Deno.env.get('SUPABASE_ANON_KEY')!;
  const svc = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const stripeKey = Deno.env.get('STRIPE_SECRET_KEY');
  if (!stripeKey) return json({ error: 'payments not configured' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  let body: { action?: string; location_id?: string; return_url?: string; refresh_url?: string };
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON' }, 400); }
  const { action, location_id } = body;
  if (!action || !location_id) return json({ error: 'action and location_id are required' }, 400);

  
  
  const asCaller = createClient(url, anon, { global: { headers: { Authorization: authHeader } } });
  const { data: loc, error: lErr } = await asCaller
    .from('locations')
    .select('id, name, tenant_id, stripe_account_id, stripe_onboarding_complete')
    .eq('id', location_id)
    .maybeSingle();
  if (lErr) return json({ error: lErr.message }, 500);
  if (!loc) return json({ error: 'not authorized for this location' }, 403);

  const admin = createClient(url, svc, { auth: { persistSession: false } });
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-06-20' });

  
  const base = (body.return_url || Deno.env.get('STRIPE_CONNECT_RETURN_URL') || 'https://rackd.io/connect').replace(/\/$/, '');
  const returnUrl = `${base}/return?loc=${location_id}`;
  const refreshUrl = body.refresh_url || `${base}/refresh?loc=${location_id}`;

  try {
    if (action === 'onboard') {
      let accountId = loc.stripe_account_id as string | null;
      if (!accountId) {
        const account = await stripe.accounts.create({
          type: 'express',
          metadata: { location_id, tenant_id: loc.tenant_id as string, location_name: (loc.name as string) || '' },
          capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
          business_profile: { name: (loc.name as string) || undefined },
        });
        accountId = account.id;
        await admin.from('locations').update({ stripe_account_id: accountId }).eq('id', location_id);
      }
      const link = await stripe.accountLinks.create({
        account: accountId, refresh_url: refreshUrl, return_url: returnUrl, type: 'account_onboarding',
      });
      return json({ url: link.url, account_id: accountId });
    }

    if (action === 'status') {
      if (!loc.stripe_account_id) return json({ onboarded: false, has_account: false });
      const acct = await stripe.accounts.retrieve(loc.stripe_account_id as string);
      const done = !!acct.details_submitted && !!acct.charges_enabled;
      if (done !== loc.stripe_onboarding_complete) {
        await admin.from('locations').update({ stripe_onboarding_complete: done }).eq('id', location_id);
      }
      return json({
        onboarded: done, has_account: true,
        charges_enabled: !!acct.charges_enabled, details_submitted: !!acct.details_submitted,
        payouts_enabled: !!acct.payouts_enabled,
      });
    }

    if (action === 'login') {
      if (!loc.stripe_account_id) return json({ error: 'no account yet — onboard first' }, 400);
      const link = await stripe.accounts.createLoginLink(loc.stripe_account_id as string);
      return json({ url: link.url });
    }

    return json({ error: `unknown action '${action}'` }, 400);
  } catch (e) {
    return json({ error: (e as Error).message || String(e) }, 500);
  }
});
