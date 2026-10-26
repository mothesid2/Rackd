// Catalog types and cart pricing. Pure functions, used by the browser (to display totals) AND by the
// checkout Pages Function (the authoritative calculation). The client's numbers are never trusted:
// the server re-prices the cart from the database catalog.

export interface Product {
  id: string;
  sku: string;
  name: string;
  category: 'station' | 'kit' | 'accessory' | 'consumable';
  description: string | null;
  price_cents: number;
  specs: Record<string, unknown>;
  images: string[];
  stock_qty: number;
  max_per_order: number;
  is_placeholder: boolean;
}

export interface BundleItem {
  sku: string;
  quantity: number;
  swap_group: string | null;
  is_optional: boolean;
}

export interface Bundle {
  slug: string;
  name: string;
  description: string | null;
  model_fit: 'model_a' | 'model_b' | 'any';
  discount_cents: number;
  is_placeholder: boolean;
  items: BundleItem[];
}

export interface ShippingMethod { id: string; name: string; cents: number }

export interface HardwareConfig {
  tax: { mode: 'flat' | 'stripe_tax'; rate_pct: number; is_placeholder?: boolean };
  shipping: { methods: ShippingMethod[]; is_placeholder?: boolean };
}

export interface Catalog {
  products: Product[];
  bundles: Bundle[];
  config: HardwareConfig;
}

export interface CartLine { sku: string; qty: number }
export interface Cart { items: CartLine[]; bundle?: string | null }

export interface PricedLine { sku: string; name: string; unit_cents: number; qty: number; line_cents: number }
export interface PriceError { code: string; sku?: string; message: string }

export interface PriceResult {
  ok: boolean;
  errors: PriceError[];
  lines: PricedLine[];
  subtotal_cents: number;
  discount_cents: number;
  bundle_applied: boolean;
  bundle_note: string | null;
  shipping_cents: number;
  tax_cents: number;
  /** true when tax is computed by Stripe Tax at payment instead of the flat rate */
  tax_pending: boolean;
  total_cents: number;
}

export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** Round half up to a whole cent. */
const roundCents = (x: number) => Math.round(x + Number.EPSILON);

export function stockStatus(p: Pick<Product, 'stock_qty'>): { label: string; tone: 'ok' | 'low' | 'out' } {
  if (p.stock_qty <= 0) return { label: 'Out of stock', tone: 'out' };
  if (p.stock_qty <= 5) return { label: `Only ${p.stock_qty} left`, tone: 'low' };
  return { label: 'In stock', tone: 'ok' };
}

export function maxQty(p: Product): number {
  return Math.max(0, Math.min(p.max_per_order, p.stock_qty));
}

/** Products that may replace a bundle item: anything sharing its swap_group in any bundle. */
export function swapOptions(cat: Catalog, item: BundleItem): string[] {
  if (!item.swap_group) return [item.sku];
  const skus = new Set<string>();
  for (const b of cat.bundles) for (const i of b.items) if (i.swap_group === item.swap_group) skus.add(i.sku);
  return [...skus];
}

/** Does the cart still contain every required bundle item (or an allowed swap for it)? */
export function bundleSatisfied(cat: Catalog, bundle: Bundle, qtyBySku: Map<string, number>): boolean {
  for (const item of bundle.items) {
    if (item.is_optional) continue;
    const have = swapOptions(cat, item).reduce((n, sku) => n + (qtyBySku.get(sku) ?? 0), 0);
    if (have < item.quantity) return false;
  }
  return true;
}

export function priceCart(cat: Catalog, cart: Cart, shippingId: string | null): PriceResult {
  const errors: PriceError[] = [];
  const bySku = new Map<string, number>();
  for (const l of cart.items) {
    if (!Number.isInteger(l.qty) || l.qty < 1) { errors.push({ code: 'qty_invalid', sku: l.sku, message: 'Quantity must be a whole number of at least 1.' }); continue; }
    bySku.set(l.sku, (bySku.get(l.sku) ?? 0) + l.qty);
  }
  if (bySku.size === 0 && errors.length === 0) errors.push({ code: 'cart_empty', message: 'Your cart is empty.' });

  const lines: PricedLine[] = [];
  for (const [sku, qty] of bySku) {
    const p = cat.products.find((x) => x.sku === sku);
    if (!p) { errors.push({ code: 'product_unavailable', sku, message: `${sku} is no longer available.` }); continue; }
    if (p.stock_qty <= 0) errors.push({ code: 'out_of_stock', sku, message: `${p.name} is out of stock.` });
    else if (qty > p.stock_qty) errors.push({ code: 'insufficient_stock', sku, message: `Only ${p.stock_qty} of ${p.name} in stock.` });
    if (qty > p.max_per_order) errors.push({ code: 'over_limit', sku, message: `Limit ${p.max_per_order} of ${p.name} per order.` });
    lines.push({ sku, name: p.name, unit_cents: p.price_cents, qty, line_cents: p.price_cents * qty });
  }

  const subtotal = lines.reduce((s, l) => s + l.line_cents, 0);

  let discount = 0;
  let applied = false;
  let note: string | null = null;
  if (cart.bundle) {
    const b = cat.bundles.find((x) => x.slug === cart.bundle);
    if (!b) note = 'That bundle is no longer available, so no bundle discount applies.';
    else if (bundleSatisfied(cat, b, bySku)) { discount = Math.min(b.discount_cents, subtotal); applied = discount > 0; }
    else note = `The ${b.name} discount no longer applies because a required item was removed.`;
  }

  let shipping = 0;
  if (lines.length) {
    const m = cat.config.shipping.methods.find((x) => x.id === shippingId);
    if (!m) errors.push({ code: 'shipping_invalid', message: 'Choose a shipping method.' });
    else shipping = m.cents;
  }

  const taxable = Math.max(0, subtotal - discount);
  const pending = cat.config.tax.mode === 'stripe_tax';
  const tax = pending ? 0 : roundCents((taxable * cat.config.tax.rate_pct) / 100);

  return {
    ok: errors.length === 0,
    errors, lines,
    subtotal_cents: subtotal,
    discount_cents: discount,
    bundle_applied: applied,
    bundle_note: note,
    shipping_cents: shipping,
    tax_cents: tax,
    tax_pending: pending,
    total_cents: subtotal - discount + shipping + tax,
  };
}

/** Maps PostgREST rows (products, bundles with embedded items, app_config rows) to a Catalog. */
export function buildCatalog(
  productRows: any[], bundleRows: any[], configRows: { key: string; value: any }[],
): Catalog {
  const cfg = Object.fromEntries(configRows.map((r) => [r.key, r.value]));
  return {
    products: productRows.map((r) => ({
      id: r.id, sku: r.sku, name: r.name, category: r.category, description: r.description, price_cents: r.price_cents,
      specs: r.specs ?? {}, images: r.images ?? [], stock_qty: r.stock_qty, max_per_order: r.max_per_order, is_placeholder: !!r.is_placeholder,
    })),
    bundles: bundleRows.map((b) => ({
      slug: b.slug, name: b.name, description: b.description, model_fit: b.model_fit, discount_cents: b.discount_cents,
      is_placeholder: !!b.is_placeholder,
      items: (b.hardware_bundle_items ?? []).map((i: any) => ({
        sku: i.hardware_products?.sku, quantity: i.quantity, swap_group: i.swap_group, is_optional: !!i.is_optional,
      })).filter((i: BundleItem) => !!i.sku),
    })),
    config: {
      tax: cfg.hardware_tax ?? { mode: 'flat', rate_pct: 0 },
      shipping: cfg.hardware_shipping ?? { methods: [] },
    },
  };
}

export const PRODUCT_SELECT = 'id,sku,name,category,description,price_cents,specs,images,stock_qty,max_per_order,is_placeholder,sort_order';
export const BUNDLE_SELECT = 'slug,name,description,model_fit,discount_cents,is_placeholder,sort_order,hardware_bundle_items(quantity,swap_group,is_optional,hardware_products(sku))';
