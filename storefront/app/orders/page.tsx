'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { fmt } from '@/lib/config';

const STATUS: Record<string, { label: string; cls: string }> = {
  pending_payment: { label: 'Awaiting payment', cls: 'bg-neutral-100 text-neutral-600' },
  new: { label: 'Order received', cls: 'bg-blue-50 text-blue-700' },
  preparing: { label: 'Preparing', cls: 'bg-amber-50 text-amber-700' },
  ready: { label: 'Ready for pickup', cls: 'bg-green-50 text-green-700' },
  picked_up: { label: 'Picked up', cls: 'bg-neutral-100 text-neutral-600' },
  cancelled: { label: 'Cancelled', cls: 'bg-red-50 text-red-700' },
};

export default function Orders() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [orders, setOrders] = useState<any[]>([]);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);

  useEffect(() => { (async () => {
    const { data: { session } } = await supabase().auth.getSession();
    setSignedIn(!!session);
    if (!session) return;
    const { data } = await supabase()
      .from('online_orders')
      .select('id, order_number, status, total, created_at, ready_at, online_order_items(name, qty)')
      .order('created_at', { ascending: false }).limit(50);
    setOrders(data || []);
  })(); }, []);

  if (signedIn === null) return <p className="text-neutral-400">Loading…</p>;
  if (!signedIn) return (
    <div><h1 className="text-2xl font-extrabold mb-2">Your orders</h1>
      <div className="bg-white rounded-xl border p-4"><Link href="/account" className="text-accent font-semibold">Sign in</Link> to see your orders.</div></div>
  );

  return (
    <div>
      <h1 className="text-2xl font-extrabold mb-4">Your orders</h1>
      {orders.length === 0 ? <p className="text-neutral-400">No orders yet.</p> :
        <div className="grid gap-3">
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
