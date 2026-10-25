'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { fmtDate, fmtMoney } from '@/lib/admin/api';
import { selectCls, StatusBadge } from '@/components/admin/ui';
import { Card, Notice } from '@/components/onboarding/fields';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';

interface Row { id: string; order_number: string; status: string; email: string; total_cents: number; is_test: boolean; created_at: string; tenant_id: string | null; application_id: string | null }
const STATUSES = ['to_ship', 'all', 'pending', 'paid', 'fulfilled', 'shipped', 'cancelled', 'refunded'];

export default function OrdersList() {
  const [status, setStatus] = useState('to_ship');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    setErr(false);
    let query = supabase().from('hardware_orders').select('id,order_number,status,email,total_cents,is_test,created_at,tenant_id,application_id').order('created_at', { ascending: false }).limit(200);
    if (status === 'to_ship') query = query.in('status', ['paid', 'fulfilled']);
    else if (status !== 'all') query = query.eq('status', status);
    const t = q.trim().replace(/[%,()]/g, '');
    if (t) query = query.or(`order_number.ilike.%${t}%,email.ilike.%${t}%`);
    const { data, error } = await query;
    if (error || !data) { setErr(true); setRows([]); return; }
    setRows(data as Row[]);
  }, [status, q]);
  useEffect(() => { setRows(null); const t = setTimeout(() => void load(), q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);

  return (
    <div className="grid gap-4">
      <h1 className="font-display font-extrabold text-3xl tracking-tight">Hardware orders</h1>
      <Card className="grid sm:grid-cols-2 gap-3 !p-3">
        <label className="grid gap-1 text-xs text-smoke">Status
          <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s === 'to_ship' ? 'Ready to ship (paid, fulfilled)' : s}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-smoke">Search<input type="search" className={selectCls} placeholder="Order number or email" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </Card>
      {err && <Notice tone="warn">Could not load orders.</Notice>}
      {rows === null && <div aria-busy="true" className="grid gap-3"><SkeletonOrderCard /><SkeletonOrderCard /></div>}
      {rows && rows.length === 0 && !err && <Card><p className="text-smoke">No orders match.</p></Card>}
      {rows && rows.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full text-sm">
            <caption className="sr-only">Hardware orders</caption>
            <thead className="bg-steel text-left text-smoke"><tr>{['Order', 'Date', 'Customer', 'Total', 'Status'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-line hover:bg-steel/50">
                  <th scope="row" className="px-3 py-2 text-left font-semibold whitespace-nowrap"><Link href={`/admin/order/?id=${r.id}`} className="hover:underline">{r.order_number}</Link>{r.is_test && <span className="ml-2 text-xs rounded bg-accent/20 px-1.5 py-0.5 text-red-400">TEST</span>}</th>
                  <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.created_at)}</td>
                  <td className="px-3 py-2 break-all">{r.email}{(r.tenant_id || r.application_id) && <span className="ml-2 text-xs text-smoke">{r.tenant_id ? 'customer account' : 'applicant'}</span>}</td>
                  <td className="px-3 py-2 tabular-nums">{fmtMoney(r.total_cents)}</td>
                  <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
