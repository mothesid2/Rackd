import { priceCart, type Cart } from '../../../lib/hardware/pricing';
import { loadCatalog } from '../../_lib/catalog';
import { flags } from '../../_lib/env';
import { guardPublic } from '../../_lib/guard';
import { HttpError, json } from '../../_lib/http';
import { LIMITS } from '../../_lib/rateLimit';
import { safeLog } from '../../_lib/redact';
import { postJson, str } from '../../_lib/route';
import { rpc, rpcAs } from '../../_lib/supabase';
import { looksLikeToken, randomToken, sha256Hex } from '../../_lib/token';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function parseCart(raw: unknown): Cart {
  const c = raw as { items?: unknown; bundle?: unknown } | null;
  if (!c || !Array.isArray(c.items) || c.items.length > 40) throw new HttpError(400, 'cart_invalid');
  const items = c.items.map((i: any) => {
    if (!i || typeof i.sku !== 'string' || i.sku.length > 40) throw new HttpError(400, 'cart_invalid');
    return { sku: i.sku, qty: Number(i.qty) };
  });
  return { items, bundle: typeof c.bundle === 'string' && c.bundle.length <= 60 ? c.bundle : null };
}

/**
 * Creates a PENDING hardware order. Prices, stock limits, bundle discount, shipping and tax are all
 * recomputed here from the database catalog. Nothing is charged here; payment is a separate step
 * (Stripe Checkout, test mode unless STRIPE_LIVE_ENABLED=true).
 *
 * COMPLIANCE: Stripe is used only for Rackd's own hardware and software charges, never for vape or
 * tobacco product payments. Confirm Stripe's restricted-business policy before STRIPE_LIVE_ENABLED=true.
 */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  await guardPublic(request, env, body, { bucket: 'hw-checkout', limit: LIMITS.checkout, turnstile: { action: 'checkout' } });

  const cart = parseCart(body.cart);
  const method = str(body, 'shipping_method', { max: 40 });
  const email = str(body, 'email', { max: 254 }).toLowerCase();
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'email_invalid');
  const a = (body.address ?? {}) as Record<string, unknown>;
  const address = {
    full_name: str(a, 'full_name', { max: 120 }), company: str(a, 'company', { optional: true, max: 120 }),
    line1: str(a, 'line1', { max: 160 }), line2: str(a, 'line2', { optional: true, max: 160 }),
    city: str(a, 'city', { max: 80 }), state: str(a, 'state', { min: 2, max: 2 }),
    zip: str(a, 'zip', { max: 10 }), phone: str(a, 'phone', { optional: true, max: 30 }),
  };
  if (!/^\d{5}(-\d{4})?$/.test(address.zip)) throw new HttpError(400, 'zip_invalid');
  const notes = str(body, 'notes', { optional: true, max: 1000 });

  const catalog = await loadCatalog(env);
  const price = priceCart(catalog, cart, method);
  if (!price.ok) return json({ error: 'cart_invalid', problems: price.errors }, 409);

  // Optional links: an in-progress application (resume token) and/or a logged-in owner's tenant.
  let applicationId: string | null = null;
  if (looksLikeToken(body.application_token)) {
    try {
      applicationId = (await rpc<{ application: { id: string } }>(env, 'app_get', { p_token: body.application_token })).application.id;
    } catch { /* stale token: treat as a plain guest order */ }
  }
  let tenantId: string | null = null;
  const auth = request.headers.get('Authorization') ?? '';
  if (auth.startsWith('Bearer ') && auth.length < 4000) {
    try { tenantId = (await rpcAs<string | null>(env, auth.slice(7), 'hw_order_tenant')) ?? null; } catch { /* invalid JWT: guest */ }
  }

  const accessToken = randomToken();
  const items = price.lines.map((l) => ({
    product_id: catalog.products.find((p) => p.sku === l.sku)?.id ?? null,
    sku: l.sku, name: l.name, unit_price_cents: l.unit_cents, quantity: l.qty,
  }));
  const rows = await rpc<{ order_id: string; order_number: string }[]>(env, 'hw_create_order', {
    p_email: email, p_application_id: applicationId, p_tenant_id: tenantId, p_address: address, p_method: method,
    p_subtotal: price.subtotal_cents, p_discount: price.discount_cents, p_shipping: price.shipping_cents,
    p_tax: price.tax_cents, p_total: price.total_cents, p_notes: notes,
    p_is_test: !flags(env).stripeLive, p_token_hash: await sha256Hex(accessToken), p_items: items,
  });
  safeLog('info', 'hardware order created', { order: rows[0].order_number, total_cents: price.total_cents });

  return {
    order_id: rows[0].order_id,
    order_number: rows[0].order_number,
    access_token: accessToken,
    total_cents: price.total_cents,
    tax_pending: price.tax_pending,
    test_mode: !flags(env).stripeLive,
  };
});
