'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useCart } from '@/lib/cart';
import { fmt } from '@/lib/config';
import { feeExplanation, previewFee } from '@/lib/storefront/fee';
import { useInvalidateReservations, type ReserveInfo } from '@/lib/queries';
import { Tooltip } from '@/components/ui/Tooltip';

const MESSAGES: Record<string, string> = {
  age_verification_required: 'Your age is not verified. Verify it on your Account page, then try again.',
  not_accepting_orders: 'This shop is not taking online orders right now.',
  location_not_available: 'This shop is not available for online orders.',
  rate_limited: 'You have made several reservations recently. Please wait a little and try again.',
  too_many_open_reservations: 'You already have the maximum number of open reservations at this shop.',
  cart_empty: 'Your cart is empty.',
  too_many_items: 'That is more items than this shop allows in one reservation.',
  prepay_not_available: 'Card payment is not available. Reserve now and pay at the shop.',
};

function describe(err: unknown): string {
  const m = String((err as { message?: string })?.message ?? '');
  const slug = m.split(':')[0].trim();
  if (slug === 'item_unavailable') return 'An item is no longer available. Remove it from your cart and try again.';
  if (slug === 'insufficient_stock') return 'There is not enough stock of an item. Lower the quantity or remove it, then try again.';
  if (slug === 'qty_over_limit') return 'You can only reserve a few of each item. Lower the quantity and try again.';
  return MESSAGES[slug] ?? 'We could not place your reservation. Please try again.';
}

/** Pay-at-pickup reservation. No card is collected here, and no payment provider is involved. */
export function ReservationCheckout({ info }: { info: ReserveInfo }) {
  const cart = useCart();
  const router = useRouter();
  const invalidate = useInvalidateReservations();
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fee = previewFee(info.fee, cart.subtotal);
  const total = Math.round((cart.subtotal + fee.amount + Number.EPSILON) * 100) / 100;

  async function reserve() {
    if (!cart.locationId) return;
    setBusy(true);
    setError(null);
    const { error: e } = await supabase().rpc('create_reservation', {
      p_location: cart.locationId,
      p_items: cart.lines.map((l) => ({ item_id: l.barcode, qty: l.qty })),
      p_notes: notes.trim() || null,
    });
    setBusy(false);
    if (e) return setError(describe(e));
    cart.clear();
    invalidate();
    // nudge the notification worker so the shop hears about it within seconds (best effort)
    fetch('/api/storefront/kick', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => undefined);
    router.push('/orders');
  }

  return (
    <div className="grid gap-4">
      <h1 className="text-2xl font-extrabold">Reserve for pickup</h1>
      <div className="bg-white rounded-xl border p-4">
        {cart.lines.map((l) => (
          <div key={l.barcode} className="flex justify-between py-1 text-sm"><span>{l.qty} × {l.name}</span><span>{fmt(l.price * l.qty)}</span></div>
        ))}
        <div className="flex justify-between border-t mt-2 pt-2 text-sm"><span>Subtotal</span><span>{fmt(cart.subtotal)}</span></div>
        <div className="flex justify-between py-0.5 text-sm text-smoke">
          <span className="inline-flex items-center gap-1.5">
            {info.fee.label}
            <Tooltip label={feeExplanation(info.fee)}>
              <span tabIndex={0} aria-label={feeExplanation(info.fee)} className="inline-flex w-4 h-4 items-center justify-center rounded-full border border-smoke text-[10px] cursor-help">?</span>
            </Tooltip>
          </span>
          <span>{fee.waived ? 'Waived' : fmt(fee.amount)}{fee.maybeWaived && !fee.waived ? ' *' : ''}</span>
        </div>
        {fee.maybeWaived && <div className="text-xs text-smoke">* Waived on your first order with this shop.</div>}
        <div className="flex justify-between border-t mt-1.5 pt-2 font-bold"><span>Total at pickup</span><span>{fmt(total)}</span></div>
        <div className="text-xs text-smoke mt-1">Sales tax is added at the register. Nothing is charged online.</div>
      </div>

      <div className="rounded-xl border p-4 text-sm grid gap-1">
        <div><strong>Pay at pickup.</strong> You pay the shop when you collect your order.</div>
        <div><strong>Bring a valid photo ID.</strong> You must be 21 or older. The shop checks ID again at pickup.</div>
        <div>Your items are held for {info.hold_minutes >= 60 ? `${Math.round(info.hold_minutes / 60 * 10) / 10} hour${info.hold_minutes === 60 ? '' : 's'}` : `${info.hold_minutes} minutes`}.</div>
        {info.pickup_instructions && <div>Pickup: {info.pickup_instructions}</div>}
      </div>

      <label className="grid gap-1 text-sm">
        <span className="font-semibold">Note for the shop (optional)</span>
        <textarea rows={2} maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} className="rounded-lg border px-3 py-2" />
      </label>

      {error && <div role="alert" className="bg-red-50 text-red-700 rounded-lg p-3 text-sm">{error}</div>}
      {!info.accepting && <div role="status" className="bg-amber-50 text-amber-800 rounded-lg p-3 text-sm">This shop is not taking online orders right now.</div>}

      <Tooltip label="Card payment is not available yet. You pay at the shop.">
        <button type="button" disabled aria-disabled="true" className="rounded-lg border px-4 py-2.5 text-sm text-smoke opacity-60 text-left w-full">Pay by card now (not available yet)</button>
      </Tooltip>
      <button className="rounded-lg bg-accent text-white py-3 font-semibold disabled:opacity-40" disabled={busy || !info.accepting} onClick={reserve}>
        {busy ? 'Reserving…' : 'Reserve for pickup'}
      </button>
    </div>
  );
}
