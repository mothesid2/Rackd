'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { btnGhost, btnPrimary, Card, ErrorText, Notice, TextField } from '@/components/onboarding/fields';
import { CatalogError } from '@/components/hardware/shared';
import { Turnstile } from '@/components/onboarding/Turnstile';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';
import { HwApiError, hw, hwMessage } from '@/lib/hardware/api';
import { cartActions, effectiveShipping, useCart } from '@/lib/hardware/cart';
import { useCatalog } from '@/lib/hardware/catalog';
import { money, priceCart } from '@/lib/hardware/pricing';
import { getToken } from '@/lib/onboarding/api';
import { isEmail, isPhone, isState, isZip } from '@/lib/onboarding/validate';

const EMPTY = { email: '', full_name: '', company: '', line1: '', line2: '', city: '', state: 'TX', zip: '', phone: '', notes: '' };

export default function CheckoutPage() {
  const router = useRouter();
  const cart = useCart();
  const s = useCatalog();
  const [f, setF] = useState(EMPTY);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [ts, setTs] = useState('');
  const [tsKey, setTsKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  if (cart.items.length === 0) {
    return <Card><p className="mb-3">Your cart is empty.</p><Link href="/hardware/" className={btnGhost}>Browse hardware</Link></Card>;
  }
  if (s.status === 'loading') return <div aria-busy="true" className="grid gap-3"><SkeletonOrderCard /><SkeletonOrderCard /></div>;
  if (s.status === 'error') return <CatalogError />;

  const cat = s.catalog;
  const ship = effectiveShipping(cart, cat);
  const price = priceCart(cat, cart, ship);

  const errs: Record<string, string> = {};
  if (!isEmail(f.email)) errs.email = 'Enter a valid email address.';
  if (f.full_name.trim().length < 2) errs.full_name = 'Enter the recipient’s name.';
  if (!f.line1.trim()) errs.line1 = 'Enter the street address.';
  if (!f.city.trim()) errs.city = 'Enter the city.';
  if (!isState(f.state)) errs.state = 'Use the 2-letter state.';
  if (!isZip(f.zip)) errs.zip = 'Enter a 5-digit ZIP.';
  if (f.phone.trim() && !isPhone(f.phone)) errs.phone = 'Enter a 10-digit phone number.';
  const show = (k: string) => (touched[k] ? errs[k] : undefined);
  const set = (k: keyof typeof EMPTY) => (v: string) => setF((p) => ({ ...p, [k]: k === 'state' ? v.toUpperCase().slice(0, 2) : v }));
  const blur = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setTouched(Object.fromEntries(Object.keys(EMPTY).map((k) => [k, true])));
    setErr(null);
    setProblems([]);
    if (Object.keys(errs).length || !ship || !price.ok || !ts) {
      setTimeout(() => (document.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus(), 0);
      return;
    }
    setBusy(true);
    try {
      const r = await hw.checkout({
        cart: { items: cart.items, bundle: cart.bundle }, shipping_method: ship, email: f.email.trim(),
        address: { full_name: f.full_name.trim(), company: f.company.trim(), line1: f.line1.trim(), line2: f.line2.trim(), city: f.city.trim(), state: f.state, zip: f.zip.trim(), phone: f.phone.trim() },
        notes: f.notes.trim(), application_token: getToken(), turnstileToken: ts,
      });
      cartActions.clear();
      // The access token goes in the URL fragment: it is never sent to a server or logged in a referrer.
      const dest = `/hardware/order/${r.order_id}#t=${r.access_token}`;
      if (r.redirect_url) { window.location.href = r.redirect_url; return; } // Stripe Checkout (test mode unless live is enabled)
      router.push(dest);
    } catch (e2) {
      setErr(hwMessage(e2));
      if (e2 instanceof HwApiError && e2.problems) setProblems(e2.problems.map((p) => p.message));
      setTsKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate className="grid lg:grid-cols-[1fr_20rem] gap-6 items-start">
      <div className="grid gap-4">
        <Card className="grid gap-4">
          <h2 className="font-display font-bold text-lg">Contact</h2>
          <TextField label="Email" type="email" inputMode="email" autoComplete="email" required value={f.email} onChange={set('email')} onBlur={blur('email')} error={show('email')} hint="We send your order confirmation and tracking here." />
        </Card>
        <Card>
          <h2 className="font-display font-bold text-lg mb-3">Ship to</h2>
          <div className="grid sm:grid-cols-2 gap-4">
            <TextField label="Full name" autoComplete="name" required value={f.full_name} onChange={set('full_name')} onBlur={blur('full_name')} error={show('full_name')} />
            <TextField label="Company" autoComplete="organization" value={f.company} onChange={set('company')} />
            <div className="sm:col-span-2"><TextField label="Street address" autoComplete="address-line1" required value={f.line1} onChange={set('line1')} onBlur={blur('line1')} error={show('line1')} /></div>
            <div className="sm:col-span-2"><TextField label="Apartment, suite, etc." autoComplete="address-line2" value={f.line2} onChange={set('line2')} /></div>
            <TextField label="City" autoComplete="address-level2" required value={f.city} onChange={set('city')} onBlur={blur('city')} error={show('city')} />
            <div className="grid grid-cols-2 gap-4">
              <TextField label="State" autoComplete="address-level1" maxLength={2} required value={f.state} onChange={set('state')} onBlur={blur('state')} error={show('state')} />
              <TextField label="ZIP" inputMode="numeric" autoComplete="postal-code" maxLength={10} required value={f.zip} onChange={set('zip')} onBlur={blur('zip')} error={show('zip')} />
            </div>
            <TextField label="Phone (optional)" type="tel" inputMode="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} onBlur={blur('phone')} error={show('phone')} hint="For delivery questions only." />
          </div>
        </Card>
        <Card>
          <label htmlFor="notes" className="block text-sm font-semibold mb-1">Order notes (optional)</label>
          <textarea id="notes" rows={3} maxLength={1000} value={f.notes} onChange={(e) => set('notes')(e.target.value)}
            className="w-full rounded-lg bg-steel border border-line px-3 py-2 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ember" />
        </Card>
        <Notice>Card details are entered on Stripe’s secure payment page. We never see or store your card number.</Notice>
      </div>

      <Card className="lg:sticky lg:top-24 grid gap-3">
        <h2 className="font-display font-bold text-lg">Order summary</h2>
        <ul className="grid gap-1 text-sm">
          {price.lines.map((l) => <li key={l.sku} className="flex justify-between gap-3"><span>{l.qty} × {l.name}</span><span className="tabular-nums">{money(l.line_cents)}</span></li>)}
        </ul>
        <dl className="grid gap-1 text-sm border-t border-line pt-2">
          {price.discount_cents > 0 && <div className="flex justify-between text-green-400"><dt>Bundle discount</dt><dd className="tabular-nums">−{money(price.discount_cents)}</dd></div>}
          <div className="flex justify-between"><dt>Shipping</dt><dd className="tabular-nums">{money(price.shipping_cents)}</dd></div>
          <div className="flex justify-between"><dt>Sales tax</dt><dd className="tabular-nums">{price.tax_pending ? 'At payment' : money(price.tax_cents)}</dd></div>
          <div className="flex justify-between font-bold text-base border-t border-line pt-2 mt-1"><dt>Total</dt><dd className="tabular-nums">{money(price.total_cents)}</dd></div>
        </dl>
        <Turnstile action="checkout" onToken={setTs} resetKey={tsKey} />
        {problems.length > 0 && <ul role="alert" className="text-sm text-red-400 list-disc pl-5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>}
        <ErrorText>{err}</ErrorText>
        <button className={btnPrimary} disabled={busy || !ts || !price.ok}>{busy ? 'Placing order…' : 'Continue to payment'}</button>
        <Link href="/hardware/cart/" className="text-sm underline text-smoke text-center">Back to cart</Link>
      </Card>
    </form>
  );
}
