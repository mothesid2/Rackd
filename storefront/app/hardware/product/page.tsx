'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { btnGhost, btnPrimary, Card, Notice } from '@/components/onboarding/fields';
import { CatalogError, Gallery, PlaceholderBanner, QtyStepper, StockBadge } from '@/components/hardware/shared';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';
import { cartActions, useCart } from '@/lib/hardware/cart';
import { skuOf, useCatalog } from '@/lib/hardware/catalog';
import { maxQty, money } from '@/lib/hardware/pricing';

const humanize = (k: string) => k.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

function Product() {
  const sku = skuOf(useSearchParams().get('sku') ?? '');
  const s = useCatalog();
  const cart = useCart();
  const [qty, setQty] = useState(1);
  const [added, setAdded] = useState(false);

  if (s.status === 'loading') return <div aria-busy="true" className="grid md:grid-cols-2 gap-6"><div className="skel aspect-square" /><SkeletonOrderCard /></div>;
  if (s.status === 'error') return <CatalogError />;
  const p = s.catalog.products.find((x) => x.sku === sku);
  if (!p) {
    return <Card><h2 className="font-display font-bold text-xl mb-2">Product not found</h2><p className="text-sm text-smoke mb-3">It may no longer be available.</p><Link href="/hardware/" className={btnGhost}>Back to the catalog</Link></Card>;
  }
  const inCart = cart.items.find((i) => i.sku === p.sku)?.qty ?? 0;
  const limit = maxQty(p);
  const room = Math.max(0, limit - inCart);
  const specs = Object.entries(p.specs);

  return (
    <div className="grid md:grid-cols-2 gap-6 items-start">
      <div className="md:col-span-2"><PlaceholderBanner show={p.is_placeholder} /></div>
      <Gallery images={p.images} name={p.name} />
      <div className="grid gap-4">
        <div>
          <h2 className="font-display font-extrabold text-3xl tracking-tight">{p.name}</h2>
          <div className="mt-1 flex items-center gap-3"><span className="price text-2xl">{money(p.price_cents)}</span><StockBadge product={p} /></div>
          {p.description && <p className="mt-3 text-[15px] leading-relaxed">{p.description}</p>}
        </div>

        {limit > 0 ? (
          <Card className="grid gap-3">
            <div className="flex flex-wrap items-center gap-4">
              <QtyStepper label={`Quantity of ${p.name}`} value={Math.min(qty, Math.max(room, 1))} max={Math.max(room, 1)} onChange={(n) => setQty(Math.max(1, n))} />
              <span className="text-xs text-smoke">Limit {p.max_per_order} per order{inCart ? ` · ${inCart} already in your cart` : ''}</span>
            </div>
            <button type="button" className={btnPrimary} disabled={room <= 0}
              onClick={() => { cartActions.add(p.sku, Math.min(qty, room), limit); setAdded(true); }}>
              {room <= 0 ? 'Limit reached' : 'Add to cart'}
            </button>
            {added && <p role="status" className="text-sm text-green-400">Added. <Link href="/hardware/cart/" className="underline">View cart</Link></p>}
          </Card>
        ) : <Notice tone="warn">This item is out of stock.</Notice>}

        <Card>
          <h3 className="font-display font-bold text-lg mb-2">Specifications</h3>
          {specs.length === 0 ? <p className="text-sm text-smoke">Specifications to be announced.</p> : (
            <table className="w-full text-sm">
              <caption className="sr-only">{p.name} specifications</caption>
              <tbody>
                {specs.map(([k, v]) => (
                  <tr key={k} className="border-t border-line first:border-0">
                    <th scope="row" className="py-2 pr-3 text-left font-normal text-smoke align-top w-2/5">{humanize(k)}</th>
                    <td className="py-2">{String(v)}{/tbd/i.test(String(v)) && <span className="ml-2 text-xs text-amber-300">to be confirmed</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <Link href="/hardware/" className="text-sm underline text-smoke">← All hardware</Link>
      </div>
    </div>
  );
}

export default function ProductPage() {
  return <Suspense fallback={<div className="skel h-64" aria-busy="true" />}><Product /></Suspense>;
}
