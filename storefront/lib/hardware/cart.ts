'use client';
// Persisted hardware cart (localStorage, shared across tabs). Separate from the shop-pickup cart.
// Holds only SKUs and quantities; prices are looked up from the catalog and re-checked on the server.

import { useSyncExternalStore } from 'react';
import type { Bundle, Cart, Catalog } from './pricing';

const KEY = 'rackd_hw_cart_v1';

export interface HwCart extends Cart {
  shipping: string | null;
}

const EMPTY: HwCart = { items: [], bundle: null, shipping: null };
let cache: HwCart | null = null;
const listeners = new Set<() => void>();

function sanitize(raw: unknown): HwCart {
  const r = raw as Partial<HwCart> | null;
  if (!r || !Array.isArray(r.items)) return EMPTY;
  const items = r.items
    .filter((i) => i && typeof i.sku === 'string' && Number.isInteger(i.qty) && i.qty > 0 && i.qty < 1000)
    .slice(0, 40)
    .map((i) => ({ sku: i.sku, qty: i.qty }));
  return { items, bundle: typeof r.bundle === 'string' ? r.bundle : null, shipping: typeof r.shipping === 'string' ? r.shipping : null };
}

function read(): HwCart {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(localStorage.getItem(KEY) ?? 'null'));
  } catch {
    cache = EMPTY;
  }
  return cache;
}

function write(next: HwCart) {
  cache = next;
  try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode: cart lives for this tab */ }
  listeners.forEach((l) => l());
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) { cache = null; listeners.forEach((l) => l()); }
  });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useCart(): HwCart {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}

export const cartCount = (c: Cart) => c.items.reduce((n, i) => n + i.qty, 0);

export const cartActions = {
  add(sku: string, qty: number, limit: number) {
    const c = read();
    const have = c.items.find((i) => i.sku === sku)?.qty ?? 0;
    const next = Math.min(limit, have + qty);
    if (next <= 0) return;
    write({ ...c, items: have ? c.items.map((i) => (i.sku === sku ? { ...i, qty: next } : i)) : [...c.items, { sku, qty: next }] });
  },
  setQty(sku: string, qty: number) {
    const c = read();
    write({ ...c, items: qty < 1 ? c.items.filter((i) => i.sku !== sku) : c.items.map((i) => (i.sku === sku ? { ...i, qty } : i)) });
  },
  remove(sku: string) { const c = read(); write({ ...c, items: c.items.filter((i) => i.sku !== sku) }); },
  /** Replace the cart with a bundle's required items; optional items start unchecked. */
  loadBundle(b: Bundle) {
    write({ items: b.items.filter((i) => !i.is_optional).map((i) => ({ sku: i.sku, qty: i.quantity })), bundle: b.slug, shipping: read().shipping });
  },
  /** Swap one product for another (bundle builder), keeping the quantity. */
  swap(from: string, to: string) {
    const c = read();
    const qty = c.items.find((i) => i.sku === from)?.qty ?? 1;
    const rest = c.items.filter((i) => i.sku !== from && i.sku !== to);
    write({ ...c, items: [...rest, { sku: to, qty }] });
  },
  /** Replace everything (bundle builder). Quantities are re-validated against stock at the cart and on the server. */
  replace(items: { sku: string; qty: number }[], bundle: string | null) {
    write({ items: items.filter((i) => i.qty > 0).slice(0, 40), bundle, shipping: read().shipping });
  },
  setShipping(id: string) { write({ ...read(), shipping: id }); },
  clear() { write({ ...EMPTY, shipping: read().shipping }); },
};

/** Defaults the shipping choice to the first configured method. */
export function effectiveShipping(c: HwCart, cat: Catalog | null): string | null {
  const ms = cat?.config.shipping.methods ?? [];
  return ms.find((m) => m.id === c.shipping)?.id ?? ms[0]?.id ?? null;
}
