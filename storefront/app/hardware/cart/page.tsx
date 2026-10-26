'use client';
import Link from 'next/link';
import { btnGhost, btnPrimary, Card, Notice, SelectField } from '@/components/onboarding/fields';
import { CatalogError, PlaceholderBanner, ProductImage, QtyStepper } from '@/components/hardware/shared';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';
import { useCatalog, slugOf } from '@/lib/hardware/catalog';
import { cartActions, effectiveShipping, useCart } from '@/lib/hardware/cart';
import { maxQty, money, priceCart } from '@/lib/hardware/pricing';

export default function CartPage() {
  const cart = useCart();
  const s = useCatalog();

  if (cart.items.length === 0) {
    return (
      <Card>
        <h2 className="font-display font-bold text-xl mb-1">Your cart is empty</h2>
        <p className="text-sm text-smoke mb-4">Pick a bundle or add individual items.</p>
        <Link href="/hardware/" className={btnPrimary}>Browse hardware</Link>
      </Card>
    );
  }
  if (s.status === 'loading') return <div aria-busy="true" className="grid gap-3"><SkeletonOrderCard /><SkeletonOrderCard /></div>;
  if (s.status === 'error') return <CatalogError />;

  const cat = s.catalog;
  const ship = effectiveShipping(cart, cat);
  const price = priceCart(cat, cart, ship);
  const lineProblems = new Map(price.errors.filter((e) => e.sku).map((e) => [e.sku as string, e.message]));
  const blocking = price.errors.filter((e) => e.code !== 'shipping_invalid');
  const placeholder = cat.products.some((p) => p.is_placeholder);
  const bundle = cart.bundle ? cat.bundles.find((b) => b.slug === cart.bundle) : null;

  return (
    <div className="grid lg:grid-cols-[1fr_20rem] gap-6 items-start">
      <div className="grid gap-4">
        <PlaceholderBanner show={placeholder} />
        {bundle && price.bundle_applied && <Notice><strong>{bundle.name}</strong> discount applied.</Notice>}
        {price.bundle_note && <Notice tone="warn">{price.bundle_note}</Notice>}

        <ul className="grid gap-3" aria-label="Cart items">
          {price.lines.map((l) => {
            const p = cat.products.find((x) => x.sku === l.sku)!;
            const limit = maxQty(p);
            const problem = lineProblems.get(l.sku);
            return (
              <li key={l.sku}>
                <Card className="!p-3 flex gap-3">
                  <ProductImage src={p.images[0]} alt={p.name} className="w-20 h-20 rounded-lg shrink-0" />
                  <div className="flex-1 min-w-0 grid gap-2">
                    <div className="flex justify-between gap-3">
                      <Link href={`/hardware/product/?sku=${slugOf(p.sku)}`} className="font-semibold hover:underline">{p.name}</Link>
                      <span className="tabular-nums font-semibold">{money(l.line_cents)}</span>
                    </div>
                    <div className="text-sm text-smoke">{money(l.unit_cents)} each</div>
                    <div className="flex items-center justify-between gap-3">
                      <QtyStepper label={`Quantity of ${p.name}`} value={l.qty} max={Math.max(limit, l.qty)} onChange={(n) => cartActions.setQty(l.sku, Math.min(n, limit || n))} />
                      <button type="button" className="text-sm underline text-smoke hover:text-ink min-h-[44px] px-2" onClick={() => cartActions.remove(l.sku)} aria-label={`Remove ${p.name}`}>Remove</button>
                    </div>
                    {problem && <p role="alert" className="text-sm text-red-400">{problem}</p>}
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
        <div><button type="button" className="text-sm underline text-smoke min-h-[44px]" onClick={() => cartActions.clear()}>Clear cart</button></div>
      </div>

      <Card className="lg:sticky lg:top-24 grid gap-3">
        <h2 className="font-display font-bold text-lg">Order summary</h2>
        <SelectField label="Shipping" value={ship ?? ''} onChange={(v) => cartActions.setShipping(v)}
          options={cat.config.shipping.methods.map((m) => ({ value: m.id, label: `${m.name} — ${money(m.cents)}` }))} />
        <dl className="grid gap-1 text-sm">
          <div className="flex justify-between"><dt>Items</dt><dd className="tabular-nums">{money(price.subtotal_cents)}</dd></div>
          {price.discount_cents > 0 && <div className="flex justify-between text-green-400"><dt>Bundle discount</dt><dd className="tabular-nums">−{money(price.discount_cents)}</dd></div>}
          <div className="flex justify-between"><dt>Shipping</dt><dd className="tabular-nums">{money(price.shipping_cents)}</dd></div>
          <div className="flex justify-between"><dt>Sales tax</dt><dd className="tabular-nums">{price.tax_pending ? 'At payment' : money(price.tax_cents)}</dd></div>
          <div className="flex justify-between font-bold text-base border-t border-line pt-2 mt-1"><dt>Total</dt><dd className="tabular-nums">{money(price.total_cents)}{price.tax_pending && '+'}</dd></div>
        </dl>
        {blocking.length > 0 && <p role="alert" className="text-sm text-red-400">Fix the items above to continue.</p>}
        {blocking.length === 0
          ? <Link href="/hardware/checkout/" className={btnPrimary}>Checkout</Link>
          : <button className={btnPrimary} disabled>Checkout</button>}
        <Link href="/hardware/" className={btnGhost}>Keep shopping</Link>
      </Card>
    </div>
  );
}
