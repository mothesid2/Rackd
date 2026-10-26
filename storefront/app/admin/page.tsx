'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { fmtDate } from '@/lib/admin/api';
import { PermitBadge, selectCls, StatusBadge } from '@/components/admin/ui';
import { Card, Notice } from '@/components/onboarding/fields';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';
import { permitFlag } from '@/lib/admin/api';

interface Row {
  id: string; status: string; legal_name: string | null; full_name: string; email: string;
  plan_model: string | null; submitted_at: string | null; created_at: string; location_count: number | null;
}

const STATUSES = ['open', 'submitted', 'in_review', 'needs_info', 'approved', 'activated', 'rejected', 'draft', 'all'] as const;
const OPEN = ['submitted', 'in_review', 'needs_info'];
const PLAN_LABEL: Record<string, string> = { model_a: 'Full POS', model_b: 'Storefront only' };

export default function ApplicationsQueue() {
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('open');
  const [plan, setPlan] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<Row[] | null>(null);
  const [flags, setFlags] = useState<Record<string, 'expired' | 'soon'>>({});
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    setErr(false);
    let query = supabase().from('onboarding_applications')
      .select('id,status,legal_name,full_name,email,plan_model,submitted_at,created_at,location_count')
      .order('submitted_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(200);
    if (status === 'open') query = query.in('status', OPEN);
    else if (status !== 'all') query = query.eq('status', status);
    if (plan) query = query.eq('plan_model', plan);
    if (from) query = query.gte('submitted_at', `${from}T00:00:00`);
    if (to) query = query.lte('submitted_at', `${to}T23:59:59`);
    if (q.trim()) query = query.or(`legal_name.ilike.%${q.trim().replace(/[%,()]/g, '')}%,email.ilike.%${q.trim().replace(/[%,()]/g, '')}%,full_name.ilike.%${q.trim().replace(/[%,()]/g, '')}%`);
    const { data, error } = await query;
    if (error || !data) { setErr(true); setRows([]); return; }
    setRows(data as Row[]);

    // permit expiry flags for the rows on screen
    const ids = (data as Row[]).map((r) => r.id);
    if (!ids.length) return setFlags({});
    const { data: lic } = await supabase().from('onboarding_licenses').select('application_id,expiry').in('application_id', ids).not('expiry', 'is', null);
    const f: Record<string, 'expired' | 'soon'> = {};
    for (const l of (lic ?? []) as { application_id: string; expiry: string }[]) {
      const x = permitFlag(l.expiry);
      if (x === 'expired') f[l.application_id] = 'expired';
      else if (x === 'soon' && f[l.application_id] !== 'expired') f[l.application_id] = 'soon';
    }
    setFlags(f);
  }, [status, plan, from, to, q]);

  useEffect(() => { setRows(null); const t = setTimeout(() => void load(), q ? 300 : 0); return () => clearTimeout(t); }, [load, q]);

  return (
    <div className="grid gap-4">
      <h1 className="font-display font-extrabold text-3xl tracking-tight">Applications</h1>

      <Card className="grid sm:grid-cols-2 lg:grid-cols-5 gap-3 !p-3">
        <label className="grid gap-1 text-xs text-smoke">Status
          <select className={selectCls} value={status} onChange={(e) => setStatus(e.target.value as typeof status)}>
            {STATUSES.map((s) => <option key={s} value={s}>{s === 'open' ? 'Needs attention' : s.replace('_', ' ')}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-smoke">Plan
          <select className={selectCls} value={plan} onChange={(e) => setPlan(e.target.value)}>
            <option value="">Any plan</option><option value="model_a">Full POS</option><option value="model_b">Storefront only</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs text-smoke">Submitted from<input type="date" className={selectCls} value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="grid gap-1 text-xs text-smoke">Submitted to<input type="date" className={selectCls} value={to} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="grid gap-1 text-xs text-smoke">Search<input type="search" placeholder="Business, name or email" className={selectCls} value={q} onChange={(e) => setQ(e.target.value)} /></label>
      </Card>

      {err && <Notice tone="warn">Could not load applications. Check your connection and permissions.</Notice>}
      {rows === null && <div aria-busy="true" className="grid gap-3"><SkeletonOrderCard /><SkeletonOrderCard /><SkeletonOrderCard /></div>}
      {rows && rows.length === 0 && !err && <Card><p className="text-smoke">No applications match these filters.</p></Card>}

      {rows && rows.length > 0 && (
        <>
          <p className="text-xs text-smoke" role="status">{rows.length}{rows.length === 200 ? '+' : ''} application{rows.length === 1 ? '' : 's'}</p>
          <ul className="grid gap-3 md:hidden" aria-label="Applications">
            {rows.map((r) => (
              <li key={r.id}>
                <Link href={`/admin/application/?id=${r.id}`} className="block bg-paper rounded-2xl border border-line p-4 hover:border-smoke focus:outline-none focus-visible:ring-2 focus-visible:ring-ember">
                  <div className="flex justify-between gap-3"><span className="font-semibold">{r.legal_name ?? r.full_name}</span><StatusBadge status={r.status} /></div>
                  <div className="text-sm text-smoke mt-1">{r.full_name} · {r.email}</div>
                  <div className="text-xs text-smoke mt-1">{r.plan_model ? PLAN_LABEL[r.plan_model] : 'No plan'} · {r.submitted_at ? `submitted ${fmtDate(r.submitted_at)}` : `started ${fmtDate(r.created_at)}`}</div>
                  {flags[r.id] && <div className="mt-2"><PermitBadge flag={flags[r.id]} /></div>}
                </Link>
              </li>
            ))}
          </ul>
          <div className="hidden md:block overflow-x-auto rounded-2xl border border-line">
            <table className="w-full text-sm">
              <caption className="sr-only">Applications</caption>
              <thead className="bg-steel text-left text-smoke">
                <tr>{['Business', 'Contact', 'Plan', 'Locations', 'Submitted', 'Permits', 'Status'].map((h) => <th key={h} scope="col" className="px-3 py-2 font-semibold">{h}</th>)}</tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-t border-line hover:bg-steel/50">
                    <th scope="row" className="px-3 py-2 text-left font-semibold"><Link href={`/admin/application/?id=${r.id}`} className="hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ember rounded">{r.legal_name ?? <span className="text-smoke">(not named yet)</span>}</Link></th>
                    <td className="px-3 py-2">{r.full_name}<div className="text-xs text-smoke">{r.email}</div></td>
                    <td className="px-3 py-2">{r.plan_model ? PLAN_LABEL[r.plan_model] : '—'}</td>
                    <td className="px-3 py-2 tabular-nums">{r.location_count ?? '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.submitted_at ?? r.created_at)}</td>
                    <td className="px-3 py-2">{flags[r.id] ? <PermitBadge flag={flags[r.id]} /> : <span className="text-smoke">—</span>}</td>
                    <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
