import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost as checkout } from '../../functions/api/hardware/checkout';
import { onRequestPost as order } from '../../functions/api/hardware/order';
import { onRequestPost as mode } from '../../functions/api/hardware/mode';
import { sha256Hex } from '../../functions/_lib/token';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', TURNSTILE_SECRET_KEY: 's' };
const TOKEN = 'ab'.repeat(32);
const ORDER_ID = '5b7e2f0a-1111-4222-8333-444455556666';

const products = [
  { id: 'p-full', sku: 'POS-FULL', name: 'Full POS Station', category: 'station', description: null, price_cents: 100000, specs: {}, images: [], stock_qty: 10, max_per_order: 5, is_placeholder: true },
  { id: 'p-term', sku: 'ACC-VP100', name: 'Terminal', category: 'accessory', description: null, price_cents: 20000, specs: {}, images: [], stock_qty: 10, max_per_order: 5, is_placeholder: true },
];
const bundles = [{ slug: 'full', name: 'Full bundle', description: null, model_fit: 'model_a', discount_cents: 10000, is_placeholder: true,
  hardware_bundle_items: [{ quantity: 1, swap_group: 'station', is_optional: false, hardware_products: { sku: 'POS-FULL' } }, { quantity: 1, swap_group: null, is_optional: false, hardware_products: { sku: 'ACC-VP100' } }] }];
const config = [{ key: 'hardware_tax', value: { mode: 'flat', rate_pct: 10 } }, { key: 'hardware_shipping', value: { methods: [{ id: 'ground', name: 'Ground', cents: 1500 }] } }];

let calls: { url: string; init?: any }[];
let turnstileOk: boolean;
let tenantFromJwt: string | null;
let created: any;

beforeEach(() => {
  calls = []; turnstileOk = true; tenantFromJwt = null; created = null;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    calls.push({ url, init });
    const ok = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (url.includes('turnstile')) return ok({ success: turnstileOk });
    if (url.includes('/rpc/rate_limit_hit')) return ok(true);
    if (url.includes('/rest/v1/hardware_products')) return ok(products);
    if (url.includes('/rest/v1/hardware_bundles')) return ok(bundles);
    if (url.includes('/rest/v1/app_config')) return ok(config);
    if (url.includes('/rpc/app_get')) return ok({ application: { id: 'app-1' } });
    if (url.includes('/rpc/hw_order_tenant')) return tenantFromJwt ? ok(tenantFromJwt) : ok({ code: 'PGRST301', message: 'JWT invalid' }, 401);
    if (url.includes('/rpc/hw_create_order')) { created = JSON.parse(init.body); return ok([{ order_id: ORDER_ID, order_number: 'HW-1001' }]); }
    if (url.includes('/rpc/hw_get_order')) {
      const a = JSON.parse(init.body);
      return a.p_token_hash === (globalThis as any).__goodHash ? ok({ id: ORDER_ID, order_number: 'HW-1001' }) : ok({ code: '28000', message: 'invalid_token' }, 400);
    }
    throw new Error('unexpected ' + url);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const good = (over: object = {}) => ({
  turnstileToken: 't', cart: { items: [{ sku: 'POS-FULL', qty: 1 }, { sku: 'ACC-VP100', qty: 1 }], bundle: 'full' },
  shipping_method: 'ground', email: 'Buyer@Test.dev',
  address: { full_name: 'Pat', line1: '1 Main', city: 'Austin', state: 'TX', zip: '78701' }, ...over,
});
const run = async (h: any, body: object, headers: Record<string, string> = {}, e: object = env) => {
  const res = await h({ request: new Request('https://r4ckd.net/api/hardware/x', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4', ...headers } }), env: e });
  return { status: res.status, body: await res.json() as any };
};

describe('hardware checkout', () => {
  it('re-prices from the database and persists server-computed totals', async () => {
    const r = await run(checkout, good());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ order_id: ORDER_ID, order_number: 'HW-1001', total_cents: 120000 - 10000 + 1500 + 11000, test_mode: true });
    expect(r.body.access_token).toMatch(/^[0-9a-f]{64}$/);
    expect(created).toMatchObject({ p_subtotal: 120000, p_discount: 10000, p_shipping: 1500, p_tax: 11000, p_total: 122500, p_is_test: true, p_email: 'buyer@test.dev', p_tenant_id: null, p_application_id: null });
    // only the hash of the access token reaches the database
    expect(created.p_token_hash).toBe(await sha256Hex(r.body.access_token));
    expect(JSON.stringify(created)).not.toContain(r.body.access_token);
    expect(created.p_items).toEqual([
      { product_id: 'p-full', sku: 'POS-FULL', name: 'Full POS Station', unit_price_cents: 100000, quantity: 1 },
      { product_id: 'p-term', sku: 'ACC-VP100', name: 'Terminal', unit_price_cents: 20000, quantity: 1 },
    ]);
  });

  it('ignores any prices, totals or discounts the client sends', async () => {
    const body = good({ total_cents: 1, subtotal_cents: 1, discount_cents: 999999, cart: { items: [{ sku: 'POS-FULL', qty: 1, price_cents: 1, unit_cents: 1 }], bundle: null } });
    const r = await run(checkout, body);
    expect(r.status).toBe(200);
    expect(created.p_subtotal).toBe(100000);
    expect(created.p_discount).toBe(0);
  });

  it('refuses a stale or invalid cart with the problems listed, and creates nothing', async () => {
    const r = await run(checkout, good({ cart: { items: [{ sku: 'POS-FULL', qty: 99 }, { sku: 'GHOST', qty: 1 }], bundle: null } }));
    expect(r.status).toBe(409);
    expect(r.body.error).toBe('cart_invalid');
    expect(r.body.problems.map((p: any) => p.code).sort()).toEqual(['insufficient_stock', 'over_limit', 'product_unavailable'].sort());
    expect(created).toBeNull();
    expect((await run(checkout, good({ shipping_method: 'teleport' }))).status).toBe(409);
  });

  it('validates contact and address', async () => {
    expect((await run(checkout, good({ email: 'nope' }))).body.error).toBe('email_invalid');
    expect((await run(checkout, good({ address: { full_name: 'Pat', line1: '1 Main', city: 'Austin', state: 'TX', zip: '787' } }))).body.error).toBe('zip_invalid');
    expect((await run(checkout, good({ address: { full_name: 'Pat', line1: '1 Main', city: 'Austin', state: 'Texas', zip: '78701' } }))).status).toBe(400);
    expect((await run(checkout, good({ cart: { items: 'x' } }))).body.error).toBe('cart_invalid');
    expect((await run(checkout, good({ cart: { items: Array.from({ length: 41 }, () => ({ sku: 'A', qty: 1 })) } }))).body.error).toBe('cart_invalid');
  });

  it('requires Turnstile', async () => {
    turnstileOk = false;
    expect((await run(checkout, good())).body).toEqual({ error: 'bot_check_failed' });
    expect(created).toBeNull();
  });

  it('links a valid application token and a logged-in owner tenant; bad ones fall back to a guest order', async () => {
    tenantFromJwt = '11111111-1111-1111-1111-111111111111';
    await run(checkout, good({ application_token: TOKEN }), { Authorization: 'Bearer owner-jwt' });
    expect(created).toMatchObject({ p_application_id: 'app-1', p_tenant_id: tenantFromJwt });
    expect(calls.find((c) => c.url.includes('hw_order_tenant'))!.init.headers.Authorization).toBe('Bearer owner-jwt');
    tenantFromJwt = null;
    const r = await run(checkout, good({ application_token: 'short' }), { Authorization: 'Bearer forged' });
    expect(r.status).toBe(200);
    expect(created).toMatchObject({ p_application_id: null, p_tenant_id: null });
  });

  it('flags the order as live only when STRIPE_LIVE_ENABLED is exactly true', async () => {
    expect((await run(checkout, good())).body.test_mode).toBe(true);
    expect((await run(checkout, good(), {}, { ...env, STRIPE_LIVE_ENABLED: 'yes' })).body.test_mode).toBe(true);
    const live = await run(checkout, good(), {}, { ...env, STRIPE_LIVE_ENABLED: 'true' });
    expect(live.body.test_mode).toBe(false);
    expect(created.p_is_test).toBe(false);
  });

  it('never logs the access token or the customer email', async () => {
    const spy = vi.spyOn(console, 'info');
    const r = await run(checkout, good());
    const printed = spy.mock.calls.flat().join(' ');
    expect(printed).not.toContain(r.body.access_token);
    expect(printed).not.toContain('buyer@test.dev');
  });
});

describe('hardware order lookup and mode', () => {
  it('returns the order only for the right id and token; the token is hashed before it reaches the database', async () => {
    (globalThis as any).__goodHash = await sha256Hex(TOKEN);
    expect((await run(order, { id: ORDER_ID, token: TOKEN })).body).toMatchObject({ order_number: 'HW-1001' });
    expect((await run(order, { id: ORDER_ID, token: 'cd'.repeat(32) })).status).toBe(401);
    expect((await run(order, { id: 'not-a-uuid', token: TOKEN })).status).toBe(401);
    expect((await run(order, { id: ORDER_ID })).status).toBe(401);
    const sent = calls.filter((c) => c.url.includes('hw_get_order')).map((c) => c.init.body).join('');
    expect(sent).not.toContain(TOKEN);
  });

  it('mode reports test mode unless live is explicitly enabled', async () => {
    expect((await run(mode, {})).body).toEqual({ test_mode: true });
    expect((await run(mode, {}, {}, { ...env, STRIPE_LIVE_ENABLED: 'true' })).body).toEqual({ test_mode: false });
  });
});
