'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Card, btnPrimary, btnGhost, Notice } from '@/components/onboarding/fields';
import { CatalogError, PlaceholderBanner, ProductImage, StockBadge } from '@/components/hardware/shared';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';
import { getToken, api } from '@/lib/onboarding/api';
import { cartActions, useCart } from '@/lib/hardware/cart';
import { slugOf, useCatalog } from '@/lib/hardware/catalog';
import { maxQty, money, type Bundle, type Catalog, type Product } from '@/lib/hardware/pricing';

function bundlePrice(cat: Catalog, b: Bundle): number {
  const gross = b.items.filter((i) => !i.is_optional).reduce((s, i) => s + (cat.products.find((p) => p.sku === i.sku)?.price_cents ?? 0) * i.quantity, 0);
  return Math.max(0, gross - b.discount_cents);
}

function ProductCard({ p }: { p: Product }) {
  const cart = useCart();
  const inCart = cart.items.find((i) => i.sku === p.sku)?.qty ?? 0;
  const limit = maxQty(p);
  // the accessible name starts with the visible text (WCAG 2.5.3) and adds which product it is for
  const label = limit <= 0 ? 'Out of stock' : inCart >= limit ? 'Limit reached' : inCart ? `Add another (${inCart} in cart)` : 'Add to cart';
  return (
    <Card className="flex flex-col gap-3 !p-3">
      <Link href={`/hardware/product/?sku=${slugOf(p.sku)}`} className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-ember rounded-xl">
        <ProductImage src={p.images[0]} alt={p.name} className="w-full aspect-[4/3] rounded-xl" />
        <h3 className="mt-3 font-display font-bold text-lg leading-tight">{p.name}</h3>
      </Link>
      <div className="flex items-center justify-between">
        <span className="price text-xl">{money(p.price_cents)}</span>
        <StockBadge product={p} />
      </div>
      <button type="button" className={btnPrimary} disabled={limit <= 0 || inCart >= limit}
        onClick={() => cartActions.add(p.sku, 1, limit)} aria-label={`${label}: ${p.name}`}>
        {label}
      </button>
    </Card>
  );
}

function ApplicationSelection({ cat }: { cat: Catalog }) {
  const cart = useCart();
  const [slug, setSlug] = useState<string | null>(null);
  useEffect(() => {
    if (!getToken()) return;
    api.get().then((d) => { const s = d.application.hardware_selection; if (s?.mode === 'bundle' && s.bundle_slug) setSlug(s.bundle_slug); }).catch(() => undefined);
  }, []);
  const b = slug ? cat.bundles.find((x) => x.slug === slug) : null;
  if (!b || cart.items.length > 0) return null;
  return (
    <div className="mb-4">
      <Notice>
        You chose <strong>{b.name}</strong> in your application.{' '}
        <button type="button" className="underline font-semibold min-h-[44px]" onClick={() => cartActions.loadBundle(b)}>Add it to your cart</button>
      </Notice>
    </div>
  );
}

export default function HardwareCatalog() {
  const s = useCatalog();
  if (s.status === 'loading') return <div className="grid sm:grid-cols-2 gap-4" aria-busy="true"><SkeletonOrderCard /><SkeletonOrderCard /><SkeletonOrderCard /><SkeletonOrderCard /></div>;
  if (s.status === 'error') return <CatalogError />;
  const { catalog: cat } = s;
  const placeholder = cat.products.some((p) => p.is_placeholder) || cat.bundles.some((b) => b.is_placeholder);
  const stations = cat.products.filter((p) => p.category === 'station' || p.category === 'kit');
  const extras = cat.products.filter((p) => p.category === 'accessory' || p.category === 'consumable');

  return (
    <div className="grid gap-8">
      <PlaceholderBanner show={placeholder} />
      <ApplicationSelection cat={cat} />

      <section aria-labelledby="bundles-h">
        <h2 id="bundles-h" className="font-display font-bold text-2xl mb-3">Bundles</h2>
        <div className="grid md:grid-cols-2 gap-4">
          {cat.bundles.map((b) => (
            <Card key={b.slug}>
              <h3 className="font-display font-bold text-xl">{b.name}</h3>
              {b.description && <p className="text-sm text-smoke mt-1">{b.description}</p>}
              <ul className="mt-3 text-sm grid gap-0.5">
                {b.items.filter((i) => !i.is_optional).map((i) => <li key={i.sku}>{i.quantity} × {cat.products.find((p) => p.sku === i.sku)?.name}</li>)}
              </ul>
              <div className="mt-3 flex items-end justify-between gap-3">
                <div>
                  <div className="price text-2xl">{money(bundlePrice(cat, b))}</div>
                  {b.discount_cents > 0 && <div className="text-xs text-green-400">Includes {money(b.discount_cents)} bundle discount</div>}
                </div>
                <Link href={`/hardware/build/?bundle=${b.slug}`} className={btnGhost}>Customize</Link>
              </div>
              <button type="button" className={`${btnPrimary} w-full mt-3`} onClick={() => cartActions.loadBundle(b)} aria-label={`Add bundle to cart: ${b.name}`}>Add bundle to cart</button>
            </Card>
          ))}
        </div>
      </section>

      <section aria-labelledby="stations-h">
        <h2 id="stations-h" className="font-display font-bold text-2xl mb-3">Stations and kits</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{stations.map((p) => <ProductCard key={p.sku} p={p} />)}</div>
      </section>

      <section aria-labelledby="acc-h">
        <h2 id="acc-h" className="font-display font-bold text-2xl mb-3">Accessories</h2>
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">{extras.map((p) => <ProductCard key={p.sku} p={p} />)}</div>
      </section>

      <Card className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display font-bold text-lg">Bringing your own hardware?</h2>
          <p className="text-sm text-smoke">Check that your equipment works with Rackd before you apply.</p>
        </div>
        <Link href="/hardware/compatibility/" className={btnGhost}>Compatibility checklist</Link>
      </Card>
    </div>
  );
}
