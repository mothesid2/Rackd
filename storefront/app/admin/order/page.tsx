'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { adminMessage, adminPost, fmtDateTime, fmtMoney } from '@/lib/admin/api';
import { Dl, Modal, Section, StatusBadge } from '@/components/admin/ui';
import { btnGhost, btnPrimary, Card, ErrorText, Notice, TextField } from '@/components/onboarding/fields';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';

type J = Record<string, any>;

function OrderDetail() {
  const id = useSearchParams().get('id') ?? '';
  const [o, setO] = useState<J | null | undefined>(undefined);
  const [items, setItems] = useState<J[]>([]);
  const [addr, setAddr] = useState<J | null>(null);
  const [modal, setModal] = useState<null | 'ship' | 'cancel'>(null);
  const [carrier, setCarrier] = useState('UPS');
  const [tracking, setTracking] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const load = useCallback(async () => {
    const sb = supabase();
    const { data } = await sb.from('hardware_orders').select('*').eq('id', id).maybeSingle();
    if (!data) return setO(null);
    const [it, ad] = await Promise.all([
      sb.from('hardware_order_items').select('*').eq('order_id', id).order('name_snapshot'),
      data.shipping_address_id ? sb.from('shipping_addresses').select('*').eq('id', data.shipping_address_id).maybeSingle() : Promise.resolve({ data: null }),
    ]);
    setItems(it.data ?? []); setAddr(ad.data); setO(data);
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (o === undefined) return <div aria-busy="true" className="grid gap-3"><SkeletonOrderCard /><SkeletonOrderCard /></div>;
  if (o === null) return <Card><p className="mb-3">Order not found.</p><Link href="/admin/orders/" className={btnGhost}>Back to orders</Link></Card>;

  const close = () => { setModal(null); setErr(null); };
  async function act(action: string, extra: Record<string, unknown> = {}, okMsg = 'Saved.') {
    setBusy(true); setErr(null);
    try {
      const r = await adminPost<{ emailed?: boolean }>('order-action', { order_id: id, action, ...extra });
      setFlash(action === 'shipped' ? (r.emailed ? 'Marked shipped. The customer was emailed the tracking number.' : 'Marked shipped, but the email could not be sent.') : okMsg);
      close(); setNote(''); await load();
    } catch (e) { setErr(adminMessage(e)); } finally { setBusy(false); }
  }

  const canFulfil = o.status === 'paid';
  const canShip = ['paid', 'fulfilled'].includes(o.status);
  const canCancel = ['pending', 'paid', 'fulfilled'].includes(o.status);
  const stripeBase = `https://dashboard.stripe.com/${o.is_test ? 'test/' : ''}payments/`;

  return (
    <div className="grid gap-4">
      <div><Link href="/admin/orders/" className="text-sm underline text-smoke">← Orders</Link></div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display font-extrabold text-3xl tracking-tight">{o.order_number}</h1>
          <p className="text-sm text-smoke">{fmtDateTime(o.created_at)} · {o.email}</p>
        </div>
        <div className="flex items-center gap-2">{o.is_test && <span className="text-xs rounded bg-accent/20 px-2 py-1 text-red-400 font-bold">TEST</span>}<StatusBadge status={o.status} /></div>
      </div>
      {flash && <div role="status"><Notice>{flash}</Notice></div>}
      {o.is_test && <Notice tone="dev">Stripe test-mode order. No real payment; do not ship.</Notice>}

      <Card className="flex flex-wrap gap-3 items-center">
        {canFulfil && <button className={btnGhost} onClick={() => act('fulfilled', {}, 'Marked fulfilled.')} disabled={busy}>Mark fulfilled</button>}
        {canShip && <button className={btnPrimary} onClick={() => { setTracking(''); setModal('ship'); }}>Mark shipped…</button>}
        {canCancel && <button className={btnGhost} onClick={() => { setNote(''); setModal('cancel'); }}>Cancel order…</button>}
        {!canFulfil && !canShip && !canCancel && <span className="text-sm text-smoke">No status actions for {o.status} orders. You can still add a note.</span>}
      </Card>

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Section title="Items">
          <ul className="grid gap-1 text-sm">
            {items.map((i) => <li key={i.id} className="flex justify-between gap-3"><span>{i.quantity} × {i.name_snapshot} <span className="text-smoke text-xs">{i.sku_snapshot}</span></span><span className="tabular-nums">{fmtMoney(i.unit_price_cents * i.quantity)}</span></li>)}
          </ul>
          <dl className="grid gap-1 text-sm border-t border-line pt-2 mt-3">
            {o.discount_cents > 0 && <div className="flex justify-between text-green-400"><dt>Bundle discount</dt><dd className="tabular-nums">−{fmtMoney(o.discount_cents)}</dd></div>}
            <div className="flex justify-between"><dt>Shipping</dt><dd className="tabular-nums">{fmtMoney(o.shipping_cents)}</dd></div>
            <div className="flex justify-between"><dt>Tax</dt><dd className="tabular-nums">{fmtMoney(o.tax_cents)}</dd></div>
            <div className="flex justify-between font-bold text-base border-t border-line pt-2 mt-1"><dt>Total</dt><dd className="tabular-nums">{fmtMoney(o.total_cents)}</dd></div>
          </dl>
        </Section>
        <Section title="Ship to">
          {addr && <address className="not-italic text-sm leading-relaxed">{addr.full_name}{addr.company ? <><br />{addr.company}</> : null}<br />{addr.line1}{addr.line2 ? <><br />{addr.line2}</> : null}<br />{addr.city}, {addr.state} {addr.zip}{addr.phone ? <><br />{addr.phone}</> : null}</address>}
          {o.notes && <p className="mt-3 text-sm"><span className="text-smoke">Customer note:</span> <span className="whitespace-pre-wrap">{o.notes}</span></p>}
        </Section>
      </div>

      <Section title="Payment and fulfilment">
        <Dl rows={[['Paid', fmtDateTime(o.paid_at)], ['Stripe payment', o.stripe_payment_intent ? <a key="s" className="underline text-red-400 break-all" href={`${stripeBase}${o.stripe_payment_intent}`} target="_blank" rel="noopener noreferrer">{o.stripe_payment_intent}</a> : null],
          ['Shipping method', o.shipping_method], ['Carrier', o.carrier], ['Tracking', o.tracking_number], ['Shipped', fmtDateTime(o.shipped_at)], ['Refund and cancel notes', o.refund_note ? <span key="n" className="whitespace-pre-wrap">{o.refund_note}</span> : null]]} />
        <div className="mt-4 grid gap-2">
          <label htmlFor="rnote" className="text-sm font-semibold">Add a manual refund / handling note</label>
          <textarea id="rnote" rows={2} value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-lg bg-steel border border-line px-3 py-2 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ember" placeholder="Example: Refunded $50 in the Stripe dashboard on 10/24 for a damaged scanner." />
          <div><button className={btnGhost} onClick={() => act('note', { note }, 'Note added.')} disabled={busy || !note.trim()}>Add note</button></div>
          <p className="text-xs text-smoke">Refunds are issued in the Stripe dashboard. A full refund there flips this order to “refunded” automatically.</p>
        </div>
      </Section>

      <Modal open={modal === 'ship'} title="Mark as shipped" onClose={close}>
        <p className="text-sm text-smoke">The customer is emailed the tracking number.</p>
        <TextField label="Carrier" value={carrier} onChange={setCarrier} />
        <TextField label="Tracking number" required value={tracking} onChange={setTracking} />
        <ErrorText>{err}</ErrorText>
        <div className="flex gap-3 justify-end"><button className={btnGhost} onClick={close}>Cancel</button><button className={btnPrimary} onClick={() => act('shipped', { carrier, tracking })} disabled={busy || !tracking.trim()}>{busy ? 'Saving…' : 'Mark shipped'}</button></div>
      </Modal>
      <Modal open={modal === 'cancel'} title="Cancel order" onClose={close}>
        {o.status === 'pending'
          ? <p className="text-sm">This order is unpaid. Cancelling just closes it.</p>
          : <Notice tone="warn">This order is paid. Cancelling puts the items back in stock but does <strong>not</strong> refund the customer. Refund it in Stripe, and say so in the note.</Notice>}
        {o.status !== 'pending' && <TextField label="Note (required)" required value={note} onChange={setNote} />}
        <ErrorText>{err}</ErrorText>
        <div className="flex gap-3 justify-end"><button className={btnGhost} onClick={close}>Keep order</button><button className={btnPrimary} onClick={() => act('cancelled', { note }, 'Order cancelled.')} disabled={busy || (o.status !== 'pending' && !note.trim())}>{busy ? 'Cancelling…' : 'Cancel order'}</button></div>
      </Modal>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="skel h-64" aria-busy="true" />}><OrderDetail /></Suspense>;
}
