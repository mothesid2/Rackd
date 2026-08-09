'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import { supabase, callFn } from '@/lib/supabase';
import { useCart } from '@/lib/cart';
import { fmt, STRIPE_PUBLISHABLE_KEY, ONLINE_FEE_RATE } from '@/lib/config';

const stripePromise = STRIPE_PUBLISHABLE_KEY ? loadStripe(STRIPE_PUBLISHABLE_KEY) : null;

// Round-half-up to the cent, matching Postgres numeric round() (reserve_online_order).
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export default function Checkout() {
  const cart = useCart();
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [verified, setVerified] = useState(false);
  const [clientSecret, setClientSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [taxRate, setTaxRate] = useState(0);

  useEffect(() => { (async () => {
    const { data: { session } } = await supabase().auth.getSession();
    setSignedIn(!!session);
    if (session) {
      const { data } = await supabase().from('storefront_customers').select('age_verified').eq('id', session.user.id).maybeSingle();
      setVerified(!!data?.age_verified);
    }
  })(); }, []);

  useEffect(() => { (async () => {
    if (!cart.locationId) return;
    const { data } = await supabase().from('locations').select('tax_rate').eq('id', cart.locationId).maybeSingle();
    setTaxRate(Number(data?.tax_rate) || 0);
  })(); }, [cart.locationId]);

  // Four line items, each rounded against its own base — mirrors reserve_online_order
  // exactly (item 4 reversal: tax applies to the subtotal AND to the surcharge).
  const tax = round2(cart.subtotal * taxRate);
  const fee = round2(cart.subtotal * ONLINE_FEE_RATE);
  const feeTax = round2(fee * taxRate);
  const total = round2(cart.subtotal + tax + fee + feeTax);

  async function startPayment() {
    setBusy(true); setError(null);
    try {
      const r = await callFn<{ client_secret: string }>('storefront-checkout', {
        tenant_id: cart.tenantId, location_id: cart.locationId,
        items: cart.lines.map((l) => ({ barcode: l.barcode, qty: l.qty })),
      });
      setClientSecret(r.client_secret);
    } catch (e) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = (e as any).data || {};
      if (d.error === 'age_verification_required') setError('Your age isn’t verified. Verify it on your Account page, then retry.');
      else if (d.error === 'insufficient_stock' || d.error === 'item_unavailable') setError(`An item just went out of stock (${d.barcode}). Remove it and try again.`);
      else setError((e as Error).message);
    }
    setBusy(false);
  }

  if (cart.count === 0) return <div><h1 className="text-2xl font-extrabold mb-2">Checkout</h1><p className="text-neutral-500">Your cart is empty.</p></div>;
  if (signedIn === null) return <p className="text-neutral-400">Loading…</p>;
  if (!signedIn) return <Gate msg="Please sign in to check out." />;
  if (!verified) return <Gate msg="You must verify your age (21+) before checking out." />;

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-extrabold">Checkout</h1>
      <div className="bg-white rounded-xl border p-4">
        {cart.lines.map((l) => (
          <div key={l.barcode} className="flex justify-between py-1 text-sm">
            <span>{l.qty} × {l.name}</span><span>{fmt(l.price * l.qty)}</span>
          </div>
        ))}
        <div className="flex justify-between border-t mt-2 pt-2 text-sm"><span>Subtotal</span><span>{fmt(cart.subtotal)}</span></div>
        <div className="flex justify-between py-0.5 text-sm text-smoke">
          <span>Sales tax{taxRate ? ` (${(taxRate * 100).toFixed(2)}%)` : ''}</span><span>{fmt(tax)}</span>
        </div>
        <div className="flex justify-between py-0.5 text-sm text-smoke">
          <span>Online Order Fee ({Math.round(ONLINE_FEE_RATE * 100)}%)</span><span>{fmt(fee)}</span>
        </div>
        <div className="flex justify-between py-0.5 text-sm text-smoke">
          <span>Tax on Online Order Fee{taxRate ? ` (${(taxRate * 100).toFixed(2)}%)` : ''}</span><span>{fmt(feeTax)}</span>
        </div>
        <div className="flex justify-between border-t mt-1.5 pt-2 font-bold"><span>Total</span><span>{fmt(total)}</span></div>
        <div className="text-xs text-neutral-600 mt-1">Pickup only — bring your ID.</div>
      </div>

      {error && <div role="alert" className="bg-red-50 text-red-700 rounded-lg p-3 text-sm">{error}</div>}

      {!clientSecret ? (
        <button className="rounded-lg bg-accent text-white py-3 font-semibold disabled:opacity-40" disabled={busy} onClick={startPayment}>
          {busy ? 'Reserving…' : 'Continue to payment'}
        </button>
      ) : stripePromise ? (
        <Elements stripe={stripePromise} options={{ clientSecret }}>
          <PayForm />
        </Elements>
      ) : (
        <div className="text-red-600 text-sm">Payments are not configured (missing Stripe key).</div>
      )}
    </div>
  );
}

function Gate({ msg }: { msg: string }) {
  return (
    <div>
      <h1 className="text-2xl font-extrabold mb-2">Checkout</h1>
      <div className="bg-white rounded-xl border p-4">
        <p className="mb-3">{msg}</p>
        <Link href="/account" className="rounded-lg bg-ink text-white px-4 py-2 font-semibold">Go to Account</Link>
      </div>
    </div>
  );
}

function PayForm() {
  const stripe = useStripe();
  const elements = useElements();
  const router = useRouter();
  const cart = useCart();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function pay() {
    if (!stripe || !elements) return;
    setBusy(true); setErr(null);
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: window.location.origin + '/orders?ok=1' },
      redirect: 'if_required',
    });
    if (error) { setErr(error.message || 'Payment failed'); setBusy(false); return; }
    cart.clear();
    router.push('/orders?ok=1');
  }

  return (
    <div className="bg-white rounded-xl border p-4 grid gap-3">
      <PaymentElement />
      {err && <div role="alert" className="text-red-600 text-sm">{err}</div>}
      <button className="rounded-lg bg-accent text-white py-3 font-semibold disabled:opacity-40" disabled={busy} onClick={pay}>
        {busy ? 'Processing…' : 'Pay now'}
      </button>
    </div>
  );
}
