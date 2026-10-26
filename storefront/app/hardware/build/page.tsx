'use client';
import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { btnGhost, btnPrimary, Card, CheckboxField } from '@/components/onboarding/fields';
import { CatalogError, PlaceholderBanner, StockBadge } from '@/components/hardware/shared';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';
import { useCatalog } from '@/lib/hardware/catalog';
import { cartActions } from '@/lib/hardware/cart';
import { money, priceCart, swapOptions, type Bundle, type Catalog } from '@/lib/hardware/pricing';

/** Local working copy: sku -> qty for the bundle's slots. Nothing touches the cart until "Add to cart". */
function Builder({ cat, bundle }: { cat: Catalog; bundle: Bundle }) {
  const router = useRouter();
  const pick = (sku: string) => cat.products.find((p) => p.sku === sku);

  // each slot: the chosen sku (swappable within its group) and whether an optional slot is on
  const [slots, setSlots] = useState(() => bundle.items.map((i) => ({ item: i, sku: i.sku, on: !i.is_optional })));
  useEffect(() => setSlots(bundle.items.map((i) => ({ item: i, sku: i.sku, on: !i.is_optional }))), [bundle]);

  const items = useMemo(() => slots.filter((s) => s.on).map((s) => ({ sku: s.sku, qty: s.item.quantity })), [slots]);
  const shipping = cat.config.shipping.methods[0]?.id ?? null;
  const price = priceCart(cat, { items, bundle: bundle.slug }, shipping);
  const goodsOnly = price.subtotal_cents - price.discount_cents;

  return (
    <div className="grid gap-4">
      <PlaceholderBanner show={bundle.is_placeholder} />
      <div>
        <h2 className="font-display font-extrabold text-3xl tracking-tight">Customize: {bundle.name}</h2>
        {bundle.description && <p className="text-smoke mt-1">{bundle.description}</p>}
      </div>

      <ul className="grid gap-3">
        {slots.map((s, idx) => {
          const options = swapOptions(cat, s.item).map(pick).filter(Boolean) as NonNullable<ReturnType<typeof pick>>[];
          const cur = pick(s.sku);
          const id = `slot-${idx}`;
          return (
            <li key={s.item.sku + idx}>
              <Card className="!p-3 grid gap-2">
                {s.item.is_optional && (
                  <CheckboxField label={<span>Include <strong>{cur?.name}</strong> <span className="text-smoke">(optional)</span></span>}
                    checked={s.on} onChange={(on) => setSlots((p) => p.map((x, i) => (i === idx ? { ...x, on } : x)))} />
                )}
                {(!s.item.is_optional || s.on) && (
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      {!s.item.is_optional && <div className="font-semibold">{s.item.quantity} × {cur?.name}</div>}
                      {cur && <div className="text-sm text-smoke">{money(cur.price_cents)} each · <StockBadge product={cur} /></div>}
                    </div>
                    {options.length > 1 && (
                      <div>
                        <label htmlFor={id} className="sr-only">Swap {cur?.name}</label>
                        <select id={id} value={s.sku} onChange={(e) => setSlots((p) => p.map((x, i) => (i === idx ? { ...x, sku: e.target.value } : x)))}
                          className="min-h-[44px] rounded-lg bg-steel border border-line px-3 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ember">
                          {options.map((o) => <option key={o.sku} value={o.sku}>{o.name} — {money(o.price_cents)}</option>)}
                        </select>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            </li>
          );
        })}
      </ul>

      <Card className="grid gap-1 text-sm">
        <div className="flex justify-between"><span>Items</span><span className="tabular-nums">{money(price.subtotal_cents)}</span></div>
        {price.discount_cents > 0 && <div className="flex justify-between text-green-400"><span>Bundle discount</span><span className="tabular-nums">−{money(price.discount_cents)}</span></div>}
        {price.bundle_note && <p className="text-amber-300">{price.bundle_note}</p>}
        <div className="flex justify-between font-bold text-base border-t border-line pt-2 mt-1"><span>Subtotal</span><span className="tabular-nums">{money(goodsOnly)}</span></div>
        <p className="text-xs text-smoke">Shipping and tax are added in your cart.</p>
      </Card>

      {!price.ok && price.errors.filter((e) => e.code !== 'shipping_invalid').map((e) => <p key={e.code + e.sku} role="alert" className="text-sm text-red-400">{e.message}</p>)}

      <div className="flex flex-wrap gap-3">
        <button type="button" className={btnPrimary} disabled={price.lines.length === 0}
          onClick={() => {
            cartActions.replace(price.lines.map((l) => ({ sku: l.sku, qty: l.qty })), bundle.slug);
            router.push('/hardware/cart/');
          }}>
          Add to cart
        </button>
        <Link href="/hardware/" className={btnGhost}>Back</Link>
      </div>
    </div>
  );
}

function Build() {
  const slug = useSearchParams().get('bundle') ?? '';
  const s = useCatalog();
  if (s.status === 'loading') return <div aria-busy="true" className="grid gap-3"><SkeletonOrderCard /><SkeletonOrderCard /></div>;
  if (s.status === 'error') return <CatalogError />;
  const b = s.catalog.bundles.find((x) => x.slug === slug);
  if (!b) return <Card><p className="mb-3">That bundle was not found.</p><Link href="/hardware/" className={btnGhost}>Back to the catalog</Link></Card>;
  return <Builder cat={s.catalog} bundle={b} />;
}

export default function BuildPage() {
  return <Suspense fallback={<div className="skel h-64" aria-busy="true" />}><Build /></Suspense>;
}
