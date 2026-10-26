import { flags, requireEnv, type Env } from '../../_lib/env';
import { errorResponse, HttpError, json } from '../../_lib/http';
import { safeLog } from '../../_lib/redact';
import { processStripeEvent, type StripeEvent } from '../../_lib/stripeEvents';
import { verifyStripeSignature } from '../../_lib/stripe';
import { rpc } from '../../_lib/supabase';

const MAX_BYTES = 1024 * 1024;

/**
 * Stripe webhook. Order of operations matters:
 *  1. verify the signature over the RAW body (anything else is rejected before parsing),
 *  2. refuse events from the wrong mode (a live event while STRIPE_LIVE_ENABLED=false, or vice versa),
 *  3. record the event id; duplicates return 200 without reprocessing,
 *  4. process, then mark done. A failure returns 500 so Stripe retries; the event stays "unfinished".
 */
export const onRequestPost = async ({ request, env }: { request: Request; env: Env }): Promise<Response> => {
  try {
    requireEnv(env, ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_WEBHOOK_SECRET']);
    const declared = Number(request.headers.get('Content-Length') ?? 0);
    if (declared > MAX_BYTES) throw new HttpError(413, 'payload_too_large');
    const raw = await request.text();
    if (raw.length > MAX_BYTES) throw new HttpError(413, 'payload_too_large');

    if (!(await verifyStripeSignature(raw, request.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET))) {
      throw new HttpError(400, 'invalid_signature');
    }
    let ev: StripeEvent;
    try { ev = JSON.parse(raw) as StripeEvent; } catch { throw new HttpError(400, 'invalid_json'); }
    if (typeof ev.id !== 'string' || typeof ev.type !== 'string' || !ev.data?.object) throw new HttpError(400, 'invalid_event');

    if (ev.livemode !== flags(env).stripeLive) {
      safeLog('error', 'stripe event mode does not match STRIPE_LIVE_ENABLED; ignored', { event: ev.id, livemode: ev.livemode });
      throw new HttpError(400, 'mode_mismatch');
    }

    const state = await rpc<'new' | 'retry' | 'done'>(env, 'hw_event_begin', { p_id: ev.id, p_type: ev.type });
    if (state === 'done') return json({ received: true, duplicate: true });

    const outcome = await processStripeEvent(env, ev);
    await rpc(env, 'hw_event_done', { p_id: ev.id });
    return json({ received: true, outcome });
  } catch (e) {
    return errorResponse(e);
  }
};
