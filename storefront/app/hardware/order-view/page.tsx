'use client';
// Served for /hardware/order/<id> via a Cloudflare Pages rewrite (public/_redirects) because a static
// export cannot have runtime dynamic routes. The secret access token lives in the URL fragment (#t=...).
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { btnGhost, btnPrimary, Card, ErrorText, Notice } from '@/components/onboarding/fields';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';
import { HwApiError, hw, hwMessage, type OrderDto } from '@/lib/hardware/api';
import { money } from '@/lib/hardware/pricing';

const STATUS: Record<OrderDto['status'], { title: string; body: string }> = {
  pending: { title: 'Awaiting payment', body: 'We have your order but have not received payment yet. Items are not reserved until payment completes.' },
  paid: { title: 'Payment received', body: 'Thank you. We are preparing your order.' },
  fulfilled: { title: 'Packed and ready to ship', body: 'Your order is packed. You will get an email with tracking when it ships.' },
  shipped: { title: 'Shipped', body: 'Your order is on its way.' },
  cancelled: { title: 'Cancelled', body: 'This order was cancelled.' },
  refunded: { title: 'Refunded', body: 'This order was refunded. Refunds can take several business days to appear.' },
};

const POLL_MS = 3000;
const POLL_TRIES = 10;

export default function OrderPage() {
  const [state, setState] = useState<'loading' | 'missing' | 'error' | 'ready'>('loading');
  const [o, setO] = useState<OrderDto | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [payBusy, setPayBusy] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);
  const ids = useRef<{ id: string; token: string; returnedFromPay: boolean } | null>(null);

  const fetchOrder = useCallback(async () => {
    const c = ids.current;
    if (!c) return null;
    const d = await hw.order(c.id, c.token);
    setO(d);
    setState('ready');
    return d;
  }, []);

  useEffect(() => {
    const id = window.location.pathname.split('/').filter(Boolean).pop() ?? '';
    const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('t') ?? '';
    const returnedFromPay = new URLSearchParams(window.location.search).get('paid') === '1';
    if (!id || !token) { setState('missing'); return; }
    ids.current = { id, token, returnedFromPay };
    let off = false;
    (async () => {
      try {
        let d = await fetchOrder();
        // Back from Stripe: the webhook may land a moment after the redirect, so wait for it briefly.
        if (returnedFromPay && d && d.status === 'pending') {
          setConfirming(true);
          for (let i = 0; i < POLL_TRIES && !off && d?.status === 'pending'; i++) {
            await new Promise((r) => setTimeout(r, POLL_MS));
            d = await fetchOrder();
          }
          if (!off) setConfirming(false);
        }
      } catch (e) {
        if (!off) setState(e instanceof HwApiError && (e.status === 401 || e.status === 400) ? 'missing' : 'error');
      }
    })();
    return () => { off = true; };
  }, [fetchOrder]);

  async function payNow() {
    const c = ids.current;
    if (!c) return;
    setPayBusy(true);
    setPayErr(null);
    try {
      const r = await hw.pay(c.id, c.token);
      window.location.href = r.redirect_url;
    } catch (e) {
      setPayErr(hwMessage(e));
      setPayBusy(false);
    }
  }

  if (state === 'loading') return <div aria-busy="true" className="grid gap-3"><SkeletonOrderCard /><SkeletonOrderCard /></div>;
  if (state === 'missing') {
    return <Card><h2 className="font-display font-bold text-xl mb-2">We could not find that order</h2><p className="text-sm text-smoke mb-3">Use the link from your confirmation email. It includes a private code that must stay in the address.</p><Link href="/hardware/" className={btnGhost}>Back to hardware</Link></Card>;
  }
  if (state === 'error' || !o) return <Notice tone="warn">We could not load your order right now. Please refresh in a moment.</Notice>;

  const st = confirming
    ? { title: 'Confirming your payment…', body: 'Your payment went through. We are waiting for confirmation, which usually takes a few seconds.' }
    : STATUS[o.status];
  return (
    <div className="grid gap-4">
      {o.is_test && <Notice tone="dev"><strong>Test order.</strong> This order was created in test mode. No real payment is taken and nothing will ship.</Notice>}
      <div>
        <p className="eyebrow text-accent">Order {o.order_number}</p>
        <h2 className="font-display font-extrabold text-3xl tracking-tight" tabIndex={-1}>{st.title}</h2>
        <p className="text-[15px] mt-1" role="status">{st.body}</p>
      </div>

      {o.status === 'pending' && !confirming && (
        <Card className="grid gap-3">
          <h3 className="font-display font-bold text-lg">Pay for this order</h3>
          <p className="text-sm text-smoke">You will complete payment on Stripe’s secure page. We never see your card number.</p>
          {o.is_test && <Notice tone="dev">Test mode: use card <strong>4242 4242 4242 4242</strong>, any future expiry, any CVC, any ZIP.</Notice>}
          <ErrorText>{payErr}</ErrorText>
          <div><button type="button" className={btnPrimary} onClick={payNow} disabled={payBusy}>{payBusy ? 'Opening payment page…' : `Pay ${money(o.total_cents)}`}</button></div>
        </Card>
      )}

      {o.status === 'shipped' && o.tracking_number && (
        <Card><div className="text-sm text-smoke">Tracking</div><div className="font-semibold break-all">{o.carrier ? `${o.carrier} · ` : ''}{o.tracking_number}</div></Card>
      )}

      <Card>
        <h3 className="font-display font-bold text-lg mb-2">Items</h3>
        <ul className="grid gap-1 text-sm">
          {o.items.map((i) => <li key={i.sku} className="flex justify-between gap-3"><span>{i.quantity} × {i.name}</span><span className="tabular-nums">{money(i.unit_price_cents * i.quantity)}</span></li>)}
        </ul>
        <dl className="grid gap-1 text-sm border-t border-line pt-2 mt-3">
          {o.discount_cents > 0 && <div className="flex justify-between text-green-400"><dt>Bundle discount</dt><dd className="tabular-nums">−{money(o.discount_cents)}</dd></div>}
          <div className="flex justify-between"><dt>Shipping</dt><dd className="tabular-nums">{money(o.shipping_cents)}</dd></div>
          <div className="flex justify-between"><dt>Sales tax</dt><dd className="tabular-nums">{money(o.tax_cents)}</dd></div>
          <div className="flex justify-between font-bold text-base border-t border-line pt-2 mt-1"><dt>Total</dt><dd className="tabular-nums">{money(o.total_cents)}</dd></div>
        </dl>
      </Card>

      <Card>
        <h3 className="font-display font-bold text-lg mb-2">Shipping to</h3>
        <address className="not-italic text-sm leading-relaxed">
          {o.address.full_name}{o.address.company ? <><br />{o.address.company}</> : null}<br />
          {o.address.line1}{o.address.line2 ? <><br />{o.address.line2}</> : null}<br />
          {o.address.city}, {o.address.state} {o.address.zip}
        </address>
        <p className="text-xs text-smoke mt-2">Confirmation sent to {o.email}</p>
      </Card>
      <div><Link href="/hardware/" className={btnGhost}>Continue shopping</Link></div>
    </div>
  );
}
