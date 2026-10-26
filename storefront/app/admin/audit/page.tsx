'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { diffKeys, fmtDateTime } from '@/lib/admin/api';
import { selectCls } from '@/components/admin/ui';
import { Card, Notice } from '@/components/onboarding/fields';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';

type J = Record<string, any>;

const show = (v: unknown) => (v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

export default function AuditPage() {
  const [rows, setRows] = useState<J[] | null>(null);
  const [me, setMe] = useState<string | null>(null);
  const [entity, setEntity] = useState('');
  const [action, setAction] = useState('');
  const [err, setErr] = useState(false);

  const load = useCallback(async () => {
    setErr(false);
    let q = supabase().from('audit_log').select('*').order('id', { ascending: false }).limit(200);
    if (entity) q = q.eq('entity', entity);
    if (action.trim()) q = q.ilike('action', `%${action.trim().replace(/[%,()]/g, '')}%`);
    const { data, error } = await q;
    if (error || !data) { setErr(true); setRows([]); return; }
    setRows(data);
  }, [entity, action]);
  useEffect(() => { setRows(null); const t = setTimeout(() => void load(), action ? 300 : 0); return () => clearTimeout(t); }, [load, action]);
  useEffect(() => { supabase().auth.getUser().then(({ data }) => setMe(data.user?.id ?? null)); }, []);

  return (
    <div className="grid gap-4">
      <h1 className="font-display font-extrabold text-3xl tracking-tight">Audit log</h1>
      <Notice>Append-only. Nothing here can be edited or deleted, including by admins.</Notice>
      <Card className="grid sm:grid-cols-2 gap-3 !p-3">
        <label className="grid gap-1 text-xs text-smoke">Record type
          <select className={selectCls} value={entity} onChange={(e) => setEntity(e.target.value)}>
            <option value="">All</option><option value="onboarding_applications">Applications</option><option value="hardware_orders">Hardware orders</option>
            <option value="app_config">Pricing and config</option><option value="hardware_products">Products</option><option value="hardware_bundles">Bundles</option><option value="onboarding_documents">Documents viewed</option>
          </select>
        </label>
        <label className="grid gap-1 text-xs text-smoke">Action contains<input type="search" className={selectCls} placeholder="e.g. approve, ein.reveal" value={action} onChange={(e) => setAction(e.target.value)} /></label>
      </Card>
      {err && <Notice tone="warn">Could not load the audit log.</Notice>}
      {rows === null && <div aria-busy="true" className="grid gap-3"><SkeletonOrderCard /><SkeletonOrderCard /></div>}
      {rows && rows.length === 0 && !err && <Card><p className="text-smoke">No entries.</p></Card>}
      {rows && rows.length > 0 && (
        <ol className="grid gap-2" aria-label="Audit entries">
          {rows.map((r) => {
            const changes = diffKeys(r.before, r.after);
            return (
              <li key={r.id} className="bg-paper rounded-xl border border-line p-3 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span><strong>{r.action}</strong> <span className="text-smoke">on {r.entity}{r.entity_id ? ` ${String(r.entity_id).slice(0, 8)}` : ''}</span></span>
                  <time className="text-xs text-smoke" dateTime={r.created_at}>{fmtDateTime(r.created_at)}</time>
                </div>
                <div className="text-xs text-smoke">by {r.actor ? (r.actor === me ? 'you' : String(r.actor).slice(0, 8)) : 'system'}</div>
                {changes.length > 0 && (
                  <ul className="mt-2 grid gap-0.5 font-mono text-xs break-all">
                    {changes.slice(0, 8).map((c) => <li key={c.key}><span className="text-smoke">{c.key}:</span> <span className="text-red-300 line-through">{show(c.from)}</span> → <span className="text-green-300">{show(c.to)}</span></li>)}
                    {changes.length > 8 && <li className="text-smoke">…and {changes.length - 8} more</li>}
                  </ul>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
