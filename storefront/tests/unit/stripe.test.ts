import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost as webhook } from '../../functions/api/stripe/webhook';
import { onRequestPost as pay } from '../../functions/api/hardware/pay';
import { onRequestPost as checkout } from '../../functions/api/hardware/checkout';
import { buildSessionParams, formEncode, signStripePayload, startPayment, stripeKeyFor, verifyStripeSignature, type OrderForPayment } from '../../functions/_lib/stripe';
import { sha256Hex } from '../../functions/_lib/token';

const SECRET = 'whsec_test_secret';
const baseEnv = {
  SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', TURNSTILE_SECRET_KEY: 's',
  STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: SECRET, ORDER_LINK_SECRET: 'link-secret', RESEND_API_KEY: 're_x', ADMIN_NOTIFY_EMAIL: 'ops@r4ckd.net', APP_BASE_URL: 'https://r4ckd.net',
};
const ORDER_ID = '5b7e2f0a-1111-4222-8333-444455556666';
const TOKEN = 'ab'.repeat(32);

const order = (over: Partial<OrderForPayment> = {}): OrderForPayment => ({
  id: ORDER_ID, order_number: 'HW-1001', email: 'buyer@test.dev', currency: 'usd',
  items: [{ name: 'Full POS Station', sku: 'POS-FULL', unit_price_cents: 100000, quantity: 1 }, { name: 'Terminal', sku: 'ACC-VP100', unit_price_cents: 20000, quantity: 2 }],
  discount_cents: 10000, shipping_cents: 1500, tax_cents: 12000, total_cents: 143500, ...over,
});

describe('formEncode', () => {
  it('encodes nested objects and arrays the way Stripe expects', () => {
    expect(decodeURIComponent(formEncode({ mode: 'payment', line_items: [{ quantity: 1, price_data: { currency: 'usd' } }], metadata: { a: 'b c' }, skip: undefined, n: null })))
      .toBe('mode=payment&line_items[0][quantity]=1&line_items[0][price_data][currency]=usd&metadata[a]=b c');
  });
});

describe('stripeKeyFor (test/live guard)', () => {
  it('allows only a test key while STRIPE_LIVE_ENABLED is off', () => {
    expect(stripeKeyFor({ STRIPE_SECRET_KEY: 'sk_test_x' })).toBe('sk_test_x');
    expect(stripeKeyFor({ STRIPE_SECRET_KEY: 'rk_test_x' })).toBe('rk_test_x');
    expect(() => stripeKeyFor({ STRIPE_SECRET_KEY: 'sk_live_x' })).toThrow(/stripe_mode_mismatch/);
    expect(() => stripeKeyFor({ STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_LIVE_ENABLED: 'yes' })).toThrow(/stripe_mode_mismatch/);
  });
  it('allows only a live key once live is explicitly enabled, and nothing when unset', () => {
    expect(stripeKeyFor({ STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_LIVE_ENABLED: 'true' })).toBe('sk_live_x');
    expect(() => stripeKeyFor({ STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_LIVE_ENABLED: 'true' })).toThrow(/stripe_mode_mismatch/);
    expect(() => stripeKeyFor({})).toThrow(/payments_not_configured/);
  });
});

describe('verifyStripeSignature', () => {
  const body = '{"id":"evt_1"}';
  it('accepts a correctly signed body', async () => {
    expect(await verifyStripeSignature(body, await signStripePayload(body, SECRET), SECRET)).toBe(true);
  });
  it('rejects wrong secret, tampered body, missing header, malformed header', async () => {
    const h = await signStripePayload(body, SECRET);
    expect(await verifyStripeSignature(body, await signStripePayload(body, 'other'), SECRET)).toBe(false);
    expect(await verifyStripeSignature(body + ' ', h, SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, null, SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, 't=abc,v1=00', SECRET)).toBe(false);
    expect(await verifyStripeSignature(body, h, undefined)).toBe(false);
    expect(await verifyStripeSignature(body, `t=${Math.floor(Date.now() / 1000)}`, SECRET)).toBe(false);
  });
  it('rejects replays outside the 5-minute window and accepts any matching v1 among several', async () => {
    const old = Math.floor(Date.now() / 1000) - 600;
    expect(await verifyStripeSignature(body, await signStripePayload(body, SECRET, old), SECRET)).toBe(false);
    const h = await signStripePayload(body, SECRET);
    expect(await verifyStripeSignature(body, h.replace('v1=', 'v1=deadbeef,v1='), SECRET)).toBe(true);
  });
});

describe('buildSessionParams', () => {
  it('flat tax: tax is a line item, shipping is a shipping option, discount via coupon, success returns to the order', () => {
    const p: any = buildSessionParams(baseEnv, order(), TOKEN, 'flat', 'co_1');
    expect(p.line_items.map((l: any) => l.price_data.unit_amount)).toEqual([100000, 20000, 12000]);
    expect(p.line_items[2].price_data.product_data.name).toBe('Sales tax');
    expect(p.shipping_options[0].shipping_rate_data.fixed_amount.amount).toBe(1500);
    expect(p.discounts).toEqual([{ coupon: 'co_1' }]);
    expect(p.automatic_tax).toBeUndefined();
    expect(p.client_reference_id).toBe(ORDER_ID);
    expect(p.metadata.order_id).toBe(ORDER_ID);
    expect(p.success_url).toBe(`https://r4ckd.net/hardware/order/${ORDER_ID}?paid=1#t=${TOKEN}`);
    expect(p.cancel_url).toBe(`https://r4ckd.net/hardware/order/${ORDER_ID}#t=${TOKEN}`);
    // the line items net of the coupon plus shipping equal the order total the customer saw
    const gross = p.line_items.reduce((s: number, l: any) => s + l.price_data.unit_amount * l.quantity, 0);
    expect(gross - 10000 + 1500).toBe(143500);
  });
  it('stripe_tax: automatic tax on, no tax line item, tax behavior exclusive', () => {
    const p: any = buildSessionParams(baseEnv, order({ tax_cents: 0 }), TOKEN, 'stripe_tax', null);
    expect(p.automatic_tax).toEqual({ enabled: true });
    expect(p.line_items).toHaveLength(2);
    expect(p.line_items[0].price_data.tax_behavior).toBe('exclusive');
    expect(p.discounts).toBeUndefined();
  });
  it('omits shipping when free', () => {
    expect((buildSessionParams(baseEnv, order({ shipping_cents: 0 }), TOKEN, 'flat', null) as any).shipping_options).toBeUndefined();
  });
});

describe('startPayment', () => {
  const res = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
  it('creates a coupon and a session with order-derived idempotency keys', async () => {
    const f = vi.fn(async (url: any) => (String(url).includes('/coupons') ? res({ id: 'co_1' }) : res({ id: 'cs_new', url: 'https://checkout.stripe.com/c/cs_new', status: 'open' })));
    const r = await startPayment(baseEnv, order(), TOKEN, 'flat', null, f as any);
    expect(r).toEqual({ url: 'https://checkout.stripe.com/c/cs_new', sessionId: 'cs_new' });
    const calls = f.mock.calls.map((c: any) => ({ url: String(c[0]), init: c[1] }));
    expect(calls[0].init.headers['Idempotency-Key']).toBe(`hw-${ORDER_ID}-first-coupon`);
    expect(calls[1].init.headers['Idempotency-Key']).toBe(`hw-${ORDER_ID}-first-session`);
    expect(calls[0].init.headers.Authorization).toBe('Bearer sk_test_abc');
    expect(decodeURIComponent(calls[0].init.body)).toContain('amount_off=10000');
  });
  it('reuses a still-open session instead of creating a second payable one', async () => {
    const f = vi.fn(async () => res({ id: 'cs_old', url: 'https://checkout.stripe.com/c/cs_old', status: 'open' }));
    expect((await startPayment(baseEnv, order(), TOKEN, 'flat', 'cs_old', f as any)).sessionId).toBe('cs_old');
    expect(f).toHaveBeenCalledTimes(1);
  });
  it('refuses when the previous session already completed, and replaces an expired one', async () => {
    await expect(startPayment(baseEnv, order(), TOKEN, 'flat', 'cs_done', (async () => res({ id: 'cs_done', status: 'complete' })) as any)).rejects.toMatchObject({ code: 'already_paid' });
    const f = vi.fn(async (url: any, init: any) => {
      if (init?.method === 'GET') return res({ id: 'cs_exp', status: 'expired', url: null });
      if (String(url).includes('/coupons')) return res({ id: 'co_2' });
      return res({ id: 'cs_fresh', url: 'https://checkout.stripe.com/c/cs_fresh', status: 'open' });
    });
    expect((await startPayment(baseEnv, order(), TOKEN, 'flat', 'cs_exp', f as any)).sessionId).toBe('cs_fresh');
    expect((f.mock.calls.find((c: any) => c[1]?.method === 'POST' && String(c[0]).includes('sessions')) as any)[1].headers['Idempotency-Key']).toBe(`hw-${ORDER_ID}-cs_exp-session`);
  });
  it('maps Stripe errors to a generic provider error without leaking details', async () => {
    await expect(startPayment(baseEnv, order({ discount_cents: 0 }), TOKEN, 'flat', null, (async () => res({ error: { message: 'secret detail', code: 'x' } }, 400)) as any)).rejects.toMatchObject({ status: 502, code: 'payment_provider_error' });
  });
  it('uses the live-vs-test guard before any network call', async () => {
    const f = vi.fn();
    await expect(startPayment({ ...baseEnv, STRIPE_SECRET_KEY: 'sk_live_x' }, order(), TOKEN, 'flat', null, f as any)).rejects.toMatchObject({ code: 'stripe_mode_mismatch' });
    expect(f).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------- endpoints
interface Up { rpcs: Record<string, (a: any) => unknown>; rpcCalls: { fn: string; args: any }[]; emails: any[]; stripeCalls: { url: string; init: any }[]; stripeOk: boolean; turnstileOk: boolean; failEmailTo?: string }
let up: Up;
const orderRow = (over: object = {}) => ({ ...order(), status: 'pending', is_test: true, stripe_session_id: null, ...over });

beforeEach(() => {
  up = { rpcs: {}, rpcCalls: [], emails: [], stripeCalls: [], stripeOk: true, turnstileOk: true };
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const ok = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (url.includes('turnstile')) return ok({ success: up.turnstileOk });
    if (url.includes('api.stripe.com')) {
      up.stripeCalls.push({ url, init });
      if (!up.stripeOk) return ok({ error: { message: 'boom' } }, 500);
      return url.includes('/coupons') ? ok({ id: 'co_1' }) : ok({ id: 'cs_new', url: 'https://checkout.stripe.com/c/cs_new', status: 'open' });
    }
    if (url.includes('resend.com')) { const b = JSON.parse(init.body); if (up.failEmailTo === b.to) return ok({}, 500); up.emails.push(b); return ok({ id: 'em' }); }
    if (url.includes('/rest/v1/app_config')) return ok([{ value: { mode: 'flat' } }]);
    if (url.includes('/rest/v1/hardware_products')) return ok([{ id: 'p1', sku: 'POS-FULL', name: 'Full POS Station', category: 'station', description: null, price_cents: 100000, specs: {}, images: [], stock_qty: 9, max_per_order: 5, is_placeholder: false }]);
    if (url.includes('/rest/v1/hardware_bundles')) return ok([]);
    if (url.includes('/rpc/')) {
      const fn = url.split('/rpc/')[1];
      const args = JSON.parse(init.body);
      up.rpcCalls.push({ fn, args });
      if (fn === 'rate_limit_hit') return ok(true);
      if (!up.rpcs[fn]) return ok({ code: 'P0001', message: 'unexpected_rpc_' + fn }, 400);
      try { return ok(up.rpcs[fn](args)); } catch (e: any) { return ok({ code: e.code ?? 'P0001', message: e.message }, 400); }
    }
    throw new Error('unexpected fetch ' + url);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const post = async (h: any, body: object, env: object = baseEnv) => {
  const res = await h({ request: new Request('https://r4ckd.net/api/x', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' } }), env });
  return { status: res.status, body: await res.json() as any };
};
const rpcsCalled = () => up.rpcCalls.map((c) => c.fn).filter((f) => f !== 'rate_limit_hit');

describe('pay endpoint', () => {
  beforeEach(() => { up.rpcs = { hw_get_order: () => orderRow(), hw_set_session: () => null }; });
  it('returns a Stripe URL for a pending order, remembers the session, and hashes the token', async () => {
    const r = await post(pay, { id: ORDER_ID, token: TOKEN });
    expect(r.body).toEqual({ redirect_url: 'https://checkout.stripe.com/c/cs_new' });
    expect(up.rpcCalls.find((c) => c.fn === 'hw_set_session')!.args).toEqual({ p_order: ORDER_ID, p_session: 'cs_new' });
    expect(up.rpcCalls.find((c) => c.fn === 'hw_get_order')!.args.p_token_hash).toBe(await sha256Hex(TOKEN));
  });
  it('refuses to pay an order that is not pending', async () => {
    up.rpcs.hw_get_order = () => orderRow({ status: 'paid' });
    expect((await post(pay, { id: ORDER_ID, token: TOKEN })).body.error).toBe('not_payable');
    expect(up.stripeCalls).toHaveLength(0);
  });
  it('rejects bad tokens and ids, and a live key in test mode', async () => {
    expect((await post(pay, { id: ORDER_ID, token: 'x' })).status).toBe(401);
    expect((await post(pay, { id: 'nope', token: TOKEN })).status).toBe(401);
    up.rpcs.hw_get_order = () => { throw Object.assign(new Error('invalid_token'), { code: '28000' }); };
    expect((await post(pay, { id: ORDER_ID, token: TOKEN })).status).toBe(401);
    up.rpcs.hw_get_order = () => orderRow();
    expect((await post(pay, { id: ORDER_ID, token: TOKEN }, { ...baseEnv, STRIPE_SECRET_KEY: 'sk_live_x' })).body.error).toBe('stripe_mode_mismatch');
  });
});

describe('checkout starts payment', () => {
  const good = { turnstileToken: 't', cart: { items: [{ sku: 'POS-FULL', qty: 1 }], bundle: null }, shipping_method: 'ground', email: 'buyer@test.dev', address: { full_name: 'Pat', line1: '1 Main', city: 'Austin', state: 'TX', zip: '78701' } };
  beforeEach(() => {
    up.rpcs = { hw_create_order: () => [{ order_id: ORDER_ID, order_number: 'HW-1001' }], hw_get_order: () => orderRow(), hw_set_session: () => null };
    const base = globalThis.fetch as any;
    vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
      if (String(input).includes('app_config') && String(input).includes('hardware_tax,hardware_shipping')) return new Response(JSON.stringify([{ key: 'hardware_tax', value: { mode: 'flat', rate_pct: 8.25 } }, { key: 'hardware_shipping', value: { methods: [{ id: 'ground', name: 'Ground', cents: 1500 }] } }]));
      return base(input, init);
    }));
  });
  it('returns the Stripe redirect when configured', async () => {
    const r = await post(checkout, good);
    expect(r.body.redirect_url).toBe('https://checkout.stripe.com/c/cs_new');
    expect(r.body.payment_error).toBeUndefined();
  });
  it('still returns the order (with payment_error) when Stripe fails, so the cart is never lost', async () => {
    up.stripeOk = false;
    const r = await post(checkout, good);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ order_id: ORDER_ID, payment_error: true });
    expect(r.body.redirect_url).toBeUndefined();
  });
  it('returns just the order when Stripe is not configured', async () => {
    const { STRIPE_SECRET_KEY: _k, ...noStripe } = baseEnv;
    const r = await post(checkout, good, noStripe);
    expect(r.body.redirect_url).toBeUndefined();
    expect(up.stripeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------- webhook
const signedReq = async (event: object, opts: { secret?: string; t?: number } = {}) => {
  const raw = JSON.stringify(event);
  return new Request('https://r4ckd.net/api/stripe/webhook', { method: 'POST', body: raw, headers: { 'Stripe-Signature': await signStripePayload(raw, opts.secret ?? SECRET, opts.t) } });
};
const send = async (event: object, env: object = baseEnv, opts: { secret?: string; t?: number } = {}) => {
  const res = await (webhook as any)({ request: await signedReq(event, opts), env });
  return { status: res.status, body: await res.json() as any };
};
const paidEvent = (over: object = {}, obj: object = {}) => ({
  id: 'evt_1', type: 'checkout.session.completed', livemode: false,
  data: { object: { id: 'cs_new', client_reference_id: ORDER_ID, payment_status: 'paid', payment_intent: 'pi_1', amount_total: 143500, total_details: { amount_tax: 12000 }, ...obj } }, ...over,
});

describe('stripe webhook', () => {
  beforeEach(() => {
    up.rpcs = {
      hw_event_begin: () => 'new', hw_event_done: () => null,
      hw_mark_paid: () => ({ changed: true, order_number: 'HW-1001', is_test: true, oversold: [], amount_changed: false }),
      hw_issue_email_token: () => null,
      hw_get_order: () => ({ ...orderRow(), id: ORDER_ID, address: { full_name: 'Pat', line1: '1 Main', city: 'Austin', state: 'TX', zip: '78701' } }),
      hw_mark_refunded: () => ({ found: true, changed: true, order_number: 'HW-1001' }),
    };
  });

  it('rejects unsigned, wrongly signed, stale and malformed requests before touching the database', async () => {
    expect((await send(paidEvent(), baseEnv, { secret: 'whsec_wrong' })).body.error).toBe('invalid_signature');
    expect((await send(paidEvent(), baseEnv, { t: Math.floor(Date.now() / 1000) - 3600 })).body.error).toBe('invalid_signature');
    const res = await (webhook as any)({ request: new Request('https://r4ckd.net/w', { method: 'POST', body: '{}' }), env: baseEnv });
    expect(res.status).toBe(400);
    expect(up.rpcCalls).toHaveLength(0);
  });

  it('refuses events from the wrong mode (live event while STRIPE_LIVE_ENABLED is off)', async () => {
    const r = await send(paidEvent({ livemode: true }));
    expect(r).toMatchObject({ status: 400, body: { error: 'mode_mismatch' } });
    expect(rpcsCalled()).toEqual([]);
    expect((await send(paidEvent({ livemode: false }), { ...baseEnv, STRIPE_LIVE_ENABLED: 'true' })).body.error).toBe('mode_mismatch');
  });

  it('marks a paid session paid, emails the customer a working link, and notifies the admin', async () => {
    const r = await send(paidEvent());
    expect(r).toMatchObject({ status: 200, body: { received: true, outcome: 'paid' } });
    expect(up.rpcCalls.find((c) => c.fn === 'hw_mark_paid')!.args).toEqual({
      p_order: ORDER_ID, p_session: 'cs_new', p_payment_intent: 'pi_1', p_amount_total: 143500, p_amount_tax: 12000, p_livemode: false });
    expect(rpcsCalled()).toEqual(['hw_event_begin', 'hw_mark_paid', 'hw_issue_email_token', 'hw_get_order', 'hw_event_done']);
    const issued = up.rpcCalls.find((c) => c.fn === 'hw_issue_email_token')!.args;
    const customer = up.emails.find((e) => e.to === 'buyer@test.dev');
    expect(customer.subject).toContain('[TEST]');
    const tokenInLink = /#t=([0-9a-f]{64})/.exec(customer.html)![1];
    expect(await sha256Hex(tokenInLink)).toBe(issued.p_hash);       // only the hash is stored
    expect(up.emails.some((e) => e.to === 'ops@r4ckd.net')).toBe(true);
  });

  it('is idempotent: a duplicate delivery is acknowledged without reprocessing or re-emailing', async () => {
    up.rpcs.hw_event_begin = () => 'done';
    const r = await send(paidEvent());
    expect(r.body).toEqual({ received: true, duplicate: true });
    expect(rpcsCalled()).toEqual(['hw_event_begin']);
    expect(up.emails).toHaveLength(0);
  });

  it('a retried event whose order is already paid sends no second email', async () => {
    up.rpcs.hw_event_begin = () => 'retry';
    up.rpcs.hw_mark_paid = () => ({ changed: false, status: 'paid' });
    const r = await send(paidEvent());
    expect(r.body.outcome).toBe('already_paid');
    expect(up.emails).toHaveLength(0);
    expect(rpcsCalled()).toContain('hw_event_done');
  });

  it('ignores unpaid sessions, unknown event types and sessions without a valid order id', async () => {
    expect((await send(paidEvent({}, { payment_status: 'unpaid' }))).body.outcome).toBe('ignored');
    expect((await send({ id: 'evt_2', type: 'customer.created', livemode: false, data: { object: {} } })).body.outcome).toBe('ignored');
    expect((await send(paidEvent({}, { client_reference_id: 'nope', metadata: {} }))).body.outcome).toBe('ignored');
    expect(rpcsCalled().filter((f) => f === 'hw_mark_paid')).toHaveLength(0);
  });

  it('returns 500 and leaves the event unfinished when processing fails, so Stripe retries', async () => {
    up.rpcs.hw_mark_paid = () => { throw Object.assign(new Error('db down'), { code: 'XX000' }); };
    const r = await send(paidEvent());
    expect(r.status).toBe(500);
    expect(rpcsCalled()).not.toContain('hw_event_done');
  });

  it('alerts the admin about oversold stock and about unexpected charged amounts (flat tax only)', async () => {
    up.rpcs.hw_mark_paid = () => ({ changed: true, order_number: 'HW-1001', is_test: true, oversold: ['POS-FULL'], amount_changed: true });
    await send(paidEvent());
    const admin = up.emails.find((e) => e.to === 'ops@r4ckd.net');
    expect(admin.html).toContain('Oversold');
    expect(admin.html).toContain('differs from the amount shown');
  });

  it('records refunds: full flips the order, partial only notes it', async () => {
    const refund = (c: object) => ({ id: 'evt_r', type: 'charge.refunded', livemode: false, data: { object: { payment_intent: 'pi_1', amount: 1000, ...c } } });
    expect((await send(refund({ refunded: true, amount_refunded: 1000 }))).body.outcome).toBe('refunded');
    expect(up.rpcCalls.find((c) => c.fn === 'hw_mark_refunded')!.args.p_full).toBe(true);
    up.rpcs.hw_mark_refunded = () => ({ found: true, changed: false, order_number: 'HW-1001' });
    up.rpcCalls = [];
    expect((await send(refund({ refunded: false, amount_refunded: 500 }))).body.outcome).toBe('refund_noted');
    expect(up.rpcCalls.find((c) => c.fn === 'hw_mark_refunded')!.args.p_full).toBe(false);
    up.rpcs.hw_mark_refunded = () => ({ found: false });
    expect((await send(refund({ refunded: true, amount_refunded: 1000 }))).body.outcome).toBe('ignored');
  });

  it('does not log customer emails, tokens or card data', async () => {
    const spies = [vi.spyOn(console, 'info'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
    await send(paidEvent());
    const printed = spies.flatMap((s) => s.mock.calls.flat()).join(' ');
    expect(printed).not.toContain('buyer@test.dev');
    expect(printed).not.toMatch(/[0-9a-f]{64}/);
  });

  it('fails the event BEFORE marking paid when the link secret is missing, so a retry can still send the email', async () => {
    const { ORDER_LINK_SECRET: _o, ...noLink } = baseEnv;
    const r = await send(paidEvent(), noLink);
    expect(r.status).toBe(503);
    expect(rpcsCalled()).not.toContain('hw_mark_paid');
    expect(rpcsCalled()).not.toContain('hw_event_done');
  });

  it('tells the admin when the customer confirmation email could not be sent', async () => {
    up.failEmailTo = 'buyer@test.dev';
    expect((await send(paidEvent())).body.outcome).toBe('paid');
    const admin = up.emails.find((e) => e.to === 'ops@r4ckd.net');
    expect(admin.html).toContain('confirmation email could not be sent');
  });

  it('needs the webhook secret configured', async () => {
    const { STRIPE_WEBHOOK_SECRET: _s, ...noSecret } = baseEnv;
    expect((await send(paidEvent(), noSecret)).status).toBe(503);
  });
});
