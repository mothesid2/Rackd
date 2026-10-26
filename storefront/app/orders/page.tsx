'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { fmt } from '@/lib/config';
import { useOrders, useReservations, useInvalidateReservations } from '@/lib/queries';
import { Tooltip } from '@/components/ui/Tooltip';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';

const STATUS: Record<string, { label: string; cls: string }> = {
  pending_payment: { label: 'Awaiting payment', cls: 'bg-neutral-100 text-neutral-600' },
  new: { label: 'Order received', cls: 'bg-blue-50 text-blue-700' },
  preparing: { label: 'Preparing', cls: 'bg-amber-50 text-amber-700' },
  ready: { label: 'Ready for pickup', cls: 'bg-green-50 text-green-700' },
  picked_up: { label: 'Picked up', cls: 'bg-neutral-100 text-neutral-600' },
  cancelled: { label: 'Cancelled', cls: 'bg-red-50 text-red-700' },
};

const RES_STATUS: Record<string, { label: string; cls: string }> = {
  new: { label: 'Reservation sent to the shop', cls: 'bg-blue-50 text-blue-700' },
  confirmed: { label: 'Confirmed', cls: 'bg-amber-50 text-amber-700' },
  ready: { label: 'Ready for pickup', cls: 'bg-green-50 text-green-700' },
  picked_up: { label: 'Picked up', cls: 'bg-neutral-100 text-neutral-600' },
  no_show: { label: 'Not picked up', cls: 'bg-red-50 text-red-700' },
  cancelled: { label: 'Cancelled', cls: 'bg-red-50 text-red-700' },
};

export default function Orders() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => { (async () => {
    const { data: { session } } = await supabase().auth.getSession();
    setSignedIn(!!session);
  })(); }, []);

  const { data: orders = [], isLoading } = useOrders(signedIn);
  const { data: reservations = [] } = useReservations(signedIn);
  const invalidateRes = useInvalidateReservations();
  async function cancel(id: string) {
    if (!confirm('Cancel this reservation?')) return;
    await supabase().rpc('cancel_my_reservation', { p_id: id });
    invalidateRes();
  }

  if (signedIn === null) return <div className="grid gap-3">{[0, 1].map((i) => <SkeletonOrderCard key={i} />)}</div>;
  if (!signedIn) return (
    <div><h1 className="text-2xl font-extrabold mb-2">Your orders</h1>

      <div className="bg-white rounded-xl border p-4"><Link href="/account" className="text-accent font-semibold">Sign in</Link> to see your orders.</div></div>

  );

  return (
    <div>
      <h1 className="text-2xl font-extrabold mb-4">Your orders</h1>

      {reservations.length > 0 && (
        <section aria-label="Reservations" className="grid gap-3 mb-6">
          {reservations.map((r) => {
            const st = RES_STATUS[r.status] || RES_STATUS.new;
            const open = ['new', 'confirmed', 'ready'].includes(r.status);
            return (
              <div key={r.id} className="bg-white rounded-xl border p-4">
                <div className="flex items-center justify-between">
                  <div className="font-bold">Reservation {r.code}</div>
                  <span className={`text-xs font-semibold rounded-full px-2.5 py-1 ${st.cls}`}>{st.label}</span>
                </div>
                <div className="text-sm text-neutral-500 mt-1">{r.reservation_items.filter((i) => !i.is_removed).map((i) => `${i.qty}× ${i.name}`).join(', ')}</div>
                <div className="text-sm mt-1">
                  <span className="font-semibold">{fmt(r.total)}</span> at pickup
                  <Tooltip label="Includes the reservation fee. Sales tax is added at the register."><span tabIndex={0} className="ml-1.5 inline-flex w-4 h-4 items-center justify-center rounded-full border text-[10px] cursor-help" aria-label="Includes the reservation fee. Sales tax is added at the register.">?</span></Tooltip>
                  {' · '}{new Date(r.created_at).toLocaleString()}
                </div>
                {open && <div className="text-xs text-neutral-500 mt-1">Held until {new Date(r.hold_expires_at).toLocaleString()}. Bring a valid photo ID (21+).</div>}
                {r.status === 'cancelled' && r.cancel_reason && <div className="text-xs text-neutral-500 mt-1">Reason: {r.cancel_reason}</div>}
                {['new', 'confirmed'].includes(r.status) && <button className="mt-2 text-sm underline text-neutral-600 min-h-[44px]" onClick={() => cancel(r.id)}>Cancel reservation</button>}
              </div>
            );
          })}
        </section>
      )}

      {isLoading ? (
        <div className="grid gap-3">{[0, 1, 2].map((i) => <SkeletonOrderCard key={i} />)}</div>
      ) : orders.length === 0 && reservations.length === 0 ? <p className="text-neutral-400">No orders yet.</p> : orders.length === 0 ? null :

        <div className="grid gap-3 fade-in">
          {orders.map((o) => {
            const s = STATUS[o.status] || STATUS.new;
            return (
              <div key={o.id} className="bg-white rounded-xl border p-4">
                <div className="flex items-center justify-between">
                  <div className="font-bold">#{o.order_number}</div>

                  <span className={`text-xs font-semibold rounded-full px-2.5 py-1 ${s.cls}`}>{s.label}</span>

                </div>

                <div className="text-sm text-neutral-500 mt-1">
                  {(o.online_order_items || []).map((i: { name: string; qty: number }) => `${i.qty}× ${i.name}`).join(', ')}
                </div>

                <div className="text-sm mt-1"><span className="font-semibold">{fmt(o.total)}</span> · {new Date(o.created_at).toLocaleString()}</div>
              </div>

            );
          })}
        </div>}

    </div>

  );
}
