import { describe, expect, it } from 'vitest';
import { bundleSatisfied, maxQty, priceCart, stockStatus, swapOptions, type Catalog } from '../../lib/hardware/pricing';

const P = (sku: string, price: number, extra: object = {}) => ({
  id: sku, sku, name: sku, category: 'accessory' as const, description: null, price_cents: price, specs: {}, images: [],
  stock_qty: 10, max_per_order: 5, is_placeholder: true, ...extra,
});

const cat: Catalog = {
  products: [P('FULL', 100000), P('LITE', 60000), P('TERM', 20000), P('SCAN', 5000), P('PAPER', 1000, { stock_qty: 2, max_per_order: 20 }), P('GONE', 100, { stock_qty: 0 })],
  bundles: [
    { slug: 'full', name: 'Full bundle', description: null, model_fit: 'model_a', discount_cents: 10000, is_placeholder: true, items: [
      { sku: 'FULL', quantity: 1, swap_group: 'station', is_optional: false }, { sku: 'TERM', quantity: 1, swap_group: null, is_optional: false },
      { sku: 'PAPER', quantity: 1, swap_group: null, is_optional: true } ] },
    { slug: 'lite', name: 'Lite bundle', description: null, model_fit: 'model_a', discount_cents: 5000, is_placeholder: true, items: [
      { sku: 'LITE', quantity: 1, swap_group: 'station', is_optional: false }, { sku: 'TERM', quantity: 1, swap_group: null, is_optional: false } ] },
  ],
  config: { tax: { mode: 'flat', rate_pct: 8.25 }, shipping: { methods: [{ id: 'ground', name: 'Ground', cents: 1500 }, { id: 'free', name: 'Pickup', cents: 0 }] } },
};
const cart = (items: [string, number][], bundle?: string) => ({ items: items.map(([sku, qty]) => ({ sku, qty })), bundle });

describe('priceCart', () => {
  it('prices lines, tax on goods, flat shipping, and totals add up', () => {
    const r = priceCart(cat, cart([['TERM', 2], ['SCAN', 1]]), 'ground');
    expect(r.ok).toBe(true);
    expect(r.subtotal_cents).toBe(45000);
    expect(r.tax_cents).toBe(3713); // 45000 * 8.25% = 3712.5 -> half up
    expect(r.shipping_cents).toBe(1500);
    expect(r.total_cents).toBe(45000 + 3713 + 1500);
  });
  it('merges duplicate lines', () => {
    const r = priceCart(cat, cart([['SCAN', 1], ['SCAN', 2]]), 'free');
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].qty).toBe(3);
  });
  it('rejects empty carts, bad quantities, unknown and out-of-stock products', () => {
    expect(priceCart(cat, cart([]), 'ground').errors[0].code).toBe('cart_empty');
    for (const q of [0, -1, 1.5, NaN]) expect(priceCart(cat, cart([['SCAN', q]]), 'ground').errors[0].code).toBe('qty_invalid');
    expect(priceCart(cat, cart([['NOPE', 1]]), 'ground').errors[0].code).toBe('product_unavailable');
    expect(priceCart(cat, cart([['GONE', 1]]), 'ground').errors.map((e) => e.code)).toContain('out_of_stock');
  });
  it('enforces stock and per-order limits', () => {
    expect(priceCart(cat, cart([['PAPER', 3]]), 'ground').errors.map((e) => e.code)).toEqual(['insufficient_stock']);
    expect(priceCart(cat, cart([['SCAN', 6]]), 'ground').errors.map((e) => e.code)).toEqual(['over_limit']);
    expect(priceCart(cat, cart([['SCAN', 5]]), 'ground').ok).toBe(true);
  });
  it('requires a valid shipping method and ignores client-supplied prices entirely', () => {
    expect(priceCart(cat, cart([['SCAN', 1]]), 'teleport').errors[0].code).toBe('shipping_invalid');
    expect(priceCart(cat, cart([['SCAN', 1]]), null).errors[0].code).toBe('shipping_invalid');
    const sneaky = { items: [{ sku: 'SCAN', qty: 1, price_cents: 1, unit_cents: 1 }] } as any;
    expect(priceCart(cat, sneaky, 'free').subtotal_cents).toBe(5000);
  });
  it('Stripe Tax mode defers tax instead of guessing', () => {
    const r = priceCart({ ...cat, config: { ...cat.config, tax: { mode: 'stripe_tax', rate_pct: 0 } } }, cart([['SCAN', 1]]), 'free');
    expect(r.tax_pending).toBe(true);
    expect(r.tax_cents).toBe(0);
  });
});

describe('bundles', () => {
  it('applies the discount when required items are present; tax applies after the discount', () => {
    const r = priceCart(cat, cart([['FULL', 1], ['TERM', 1]], 'full'), 'free');
    expect(r.bundle_applied).toBe(true);
    expect(r.discount_cents).toBe(10000);
    expect(r.tax_cents).toBe(Math.round((120000 - 10000) * 0.0825));
    expect(r.total_cents).toBe(120000 - 10000 + r.tax_cents);
  });
  it('allows swapping within a swap group (Full POS -> Counter Lite) and keeps the discount', () => {
    expect(swapOptions(cat, cat.bundles[0].items[0]).sort()).toEqual(['FULL', 'LITE']);
    const r = priceCart(cat, cart([['LITE', 1], ['TERM', 1]], 'full'), 'free');
    expect(r.bundle_applied).toBe(true);
  });
  it('drops the discount (with an explanation) when a required item is removed', () => {
    const r = priceCart(cat, cart([['FULL', 1]], 'full'), 'free');
    expect(r.bundle_applied).toBe(false);
    expect(r.discount_cents).toBe(0);
    expect(r.bundle_note).toContain('no longer applies');
  });
  it('optional items are not required, and an unknown bundle gives no discount', () => {
    const q = new Map([['FULL', 1], ['TERM', 1]]);
    expect(bundleSatisfied(cat, cat.bundles[0], q)).toBe(true);
    const r = priceCart(cat, cart([['FULL', 1], ['TERM', 1]], 'ghost'), 'free');
    expect(r.discount_cents).toBe(0);
    expect(r.bundle_note).toBeTruthy();
  });
  it('the discount can never exceed the subtotal', () => {
    const tiny: Catalog = { ...cat, bundles: [{ ...cat.bundles[0], discount_cents: 999999, items: [{ sku: 'SCAN', quantity: 1, swap_group: null, is_optional: false }] }] };
    const r = priceCart(tiny, cart([['SCAN', 1]], 'full'), 'free');
    expect(r.discount_cents).toBe(5000);
    expect(r.total_cents).toBe(0);
  });
});

describe('helpers', () => {
  it('stock status and max quantity', () => {
    expect(stockStatus({ stock_qty: 0 }).tone).toBe('out');
    expect(stockStatus({ stock_qty: 3 }).label).toBe('Only 3 left');
    expect(stockStatus({ stock_qty: 50 }).tone).toBe('ok');
    expect(maxQty(cat.products[4])).toBe(2);
    expect(maxQty(cat.products[0])).toBe(5);
    expect(maxQty(cat.products[5])).toBe(0);
  });
});
