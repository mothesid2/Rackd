import { useEffect, useState } from 'react';
import { messageFor, type StorefrontApi } from './api';
import { PERMISSION_KEYS, type BusinessDefaults, type Permissions, type Settings } from './types';
import { btnGhost, btnPrimary, Card, Field, input, ListSkeleton, Notice, Switch, Tooltip, useResource, useToast } from './ui';
import { money, toCsv } from './util';

interface Base { api: StorefrontApi; location: string; perms: Permissions }

/** Generic CSV download; no server round trip. */
function download(name: string, rows: unknown[][]) {
  const url = URL.createObjectURL(new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ------------------------------------------------------------------ Dashboard
export function DashboardPanel({ api, location, perms, onGo }: Base & { onGo: (tab: string) => void }) {
  const toast = useToast();
  const res = useResource(() => api.dashboard(location), [location]);
  const [busy, setBusy] = useState(false);
  if (res.loading && !res.data) return <ListSkeleton rows={3} />;
  const d = res.data;
  if (!d) return <Notice tone="error">{res.error ?? 'Could not load the dashboard.'}</Notice>;
  const can = perms.settings_edit || perms.orders_manage;
  async function toggle(paused: boolean) {
    setBusy(true);
    res.setData((p) => (p ? { ...p, paused } : p));
    try { await api.setPaused(location, paused); toast(paused ? 'Online orders paused.' : 'Online orders are back on.'); }
    catch (e) { toast(messageFor(e), 'error'); }
    finally { setBusy(false); void res.reload(); }
  }
  const stat = (label: string, v: string | number, go?: string) => (
    <button type="button" onClick={() => go && onGo(go)} className="text-left rounded-2xl border border-line bg-paper p-4 min-h-[44px]">
      <div className="text-3xl font-display font-bold">{v}</div><div className="text-sm text-smoke">{label}</div>
    </button>
  );
  return (
    <div className="grid gap-4">
      {!d.enabled && <Notice tone="warn">The online storefront is off for this location. The business owner turns it on.</Notice>}
      <Card className="flex items-center justify-between gap-4">
        <div>
          <h3 className="font-display font-bold text-xl">Pause online orders</h3>
          <p className="text-sm text-smoke">{d.paused ? 'Customers see that you are not taking online orders right now.' : 'Flip this on when you are slammed or closing early.'}</p>
        </div>
        {can ? <Switch big checked={d.paused} onChange={toggle} disabled={busy} label="Pause online orders" />
          : <Tooltip label="You do not have permission to pause orders."><Switch big checked={d.paused} onChange={() => undefined} disabled label="Pause online orders" /></Tooltip>}
      </Card>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stat('Orders today', d.today, 'orders')}{stat('Waiting on you', d.pending, 'orders')}{stat('Sold out items', d.sold_out, 'items')}{stat('Orders, 7 days', d.orders_7d, 'reports')}
      </div>
      {perms.reports_view && <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {stat('Online sales, 7 days', money(d.sales_7d))}{stat('No-show rate, 30 days', `${Math.round(d.no_show_rate_30d * 100)}%`)}
        {perms.fees_view && stat('Fees, 7 days', money(d.fees_7d), 'fees')}
      </div>}
    </div>
  );
}

// ------------------------------------------------------------------ Settings
export function SettingsPanel({ api, location, perms, settings, reloadSettings }: Base & { settings: Settings | null; reloadSettings: () => void }) {
  const toast = useToast();
  const [f, setF] = useState<Settings | null>(settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => setF(settings), [settings]);
  if (!f) return <ListSkeleton rows={3} />;
  const can = perms.settings_edit;
  const set = (p: Partial<Settings>) => setF({ ...f, ...p });
  const numField = (label: string, key: 'hold_minutes' | 'order_cutoff_minutes' | 'max_items_per_order' | 'max_qty_per_item', hint?: string) => (
    <Field label={label} hint={hint}>{(id) => <input id={id} className={input} inputMode="numeric" disabled={!can} value={f[key] ?? ''} onChange={(e) => set({ [key]: e.target.value === '' ? null : Number(e.target.value) } as Partial<Settings>)} />}</Field>
  );
  async function save() {
    if (!f) return;
    setBusy(true);
    try {
      await api.saveSettings(location, {
        pickup_instructions: f.pickup_instructions, hold_minutes: f.hold_minutes, order_cutoff_minutes: f.order_cutoff_minutes,
        max_items_per_order: f.max_items_per_order, max_qty_per_item: f.max_qty_per_item, require_id_at_pickup: f.require_id_at_pickup,
        auto_cancel_no_show: f.auto_cancel_no_show, notify_inapp: f.notify_inapp, notify_email: f.notify_email, notify_sms: f.notify_sms, pickup_hours: f.pickup_hours,
      });
      toast('Settings saved.'); reloadSettings();
    } catch (e) { toast(messageFor(e), 'error'); } finally { setBusy(false); }
  }
  const days = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const hours = f.pickup_hours ?? {};
  const setDay = (d: string, p: { open?: string; close?: string; closed?: boolean }) => set({ pickup_hours: { ...hours, [d]: { ...(hours[d] ?? {}), ...p } } });
  return (
    <div className="grid gap-4">
      {!can && <Notice>You can view settings but not change them.</Notice>}
      <Card className="grid gap-3">
        <h3 className="font-display font-bold text-lg">Pickup</h3>
        <Field label="Pickup instructions" hint="Shown to customers, e.g. “Come to the counter and say your order code.”">{(id) => <textarea id={id} className={`${input} min-h-[88px]`} disabled={!can} value={f.pickup_instructions ?? ''} onChange={(e) => set({ pickup_instructions: e.target.value })} maxLength={400} />}</Field>
        <div className="grid sm:grid-cols-2 gap-3">
          {numField('Hold orders for (minutes)', 'hold_minutes', 'How long an order waits before it expires.')}
          {numField('Stop taking orders before close (minutes)', 'order_cutoff_minutes')}
          {numField('Max items per order', 'max_items_per_order')}
          {numField('Max of one item per order', 'max_qty_per_item')}
        </div>
        <fieldset className="grid gap-2"><legend className="text-sm font-semibold mb-1">Pickup hours</legend>
          {days.map((d) => { const h = hours[d] ?? {}; return (
            <div key={d} className="grid grid-cols-[3rem_1fr_1fr_auto] gap-2 items-center">
              <span className="uppercase text-xs text-smoke">{d}</span>
              <input aria-label={`${d} opens`} type="time" className={input} disabled={!can || h.closed} value={h.open ?? ''} onChange={(e) => setDay(d, { open: e.target.value })} />
              <input aria-label={`${d} closes`} type="time" className={input} disabled={!can || h.closed} value={h.close ?? ''} onChange={(e) => setDay(d, { close: e.target.value })} />
              <label className="inline-flex items-center gap-1 text-xs min-h-[44px]"><input type="checkbox" className="w-5 h-5" disabled={!can} checked={!!h.closed} onChange={(e) => setDay(d, { closed: e.target.checked })} />Closed</label>
            </div>); })}
          <p className="text-xs text-smoke">Your address and sales tax are managed by Rackd and cannot be changed here.</p>
        </fieldset>
      </Card>
      <Card className="grid gap-3">
        <h3 className="font-display font-bold text-lg">Rules and alerts</h3>
        {([['require_id_at_pickup', 'Require an ID check at pickup'], ['auto_cancel_no_show', 'Automatically cancel orders that are not picked up'],
          ['notify_inapp', 'Alert me in the app'], ['notify_email', 'Email me new orders'], ['notify_sms', 'Text me new orders (when available)']] as const).map(([k, label]) => (
          <label key={k} className="flex items-center justify-between gap-3 min-h-[44px]"><span className="text-sm">{label}</span>
            <Switch checked={!!f[k]} onChange={(v) => set({ [k]: v } as Partial<Settings>)} disabled={!can || (k === 'require_id_at_pickup' && !f.require_id_at_pickup && false)} label={label} /></label>
        ))}
      </Card>
      <div className="flex justify-end"><button className={btnPrimary} disabled={!can || busy} onClick={save}>{busy ? 'Saving…' : 'Save settings'}</button></div>
    </div>
  );
}

// ------------------------------------------------------------------ Reports
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function ReportsPanel({ api, location, businessWide }: Base & { businessWide?: boolean }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10));
  const [to, setTo] = useState(today);
  const res = useResource(() => api.report(businessWide ? null : location, from, to), [location, from, to, businessWide]);
  const r = res.data;
  const max = Math.max(1, ...(r?.hourly ?? []).map((h) => h.orders));
  const cell = (d: number, h: number) => (r?.hourly ?? []).find((x) => x.dow === d && x.hour === h)?.orders ?? 0;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Field label="From">{(id) => <input id={id} type="date" className={input} value={from} max={to} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(id) => <input id={id} type="date" className={input} value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />}</Field>
        <span className="flex-1" />
        <button className={btnGhost} disabled={!r} onClick={() => r && download(`storefront-report-${from}-${to}.csv`, [
          ['Metric', 'Value'], ['Orders', r.orders], ['Online sales', r.online_sales], ['Fees accrued', r.fees_accrued], ['No-show rate', r.no_show_rate], [], ['Top items', 'Qty', 'Revenue'],
          ...r.top_items.map((t) => [t.name, t.qty, t.revenue])])}>Download CSV</button>
      </div>
      {res.loading && !r ? <ListSkeleton rows={3} /> : res.error ? <Notice tone="error">{res.error}</Notice> : r && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[['Orders', r.orders], ['Online sales', money(r.online_sales)], ['Fees accrued', money(r.fees_accrued)], ['No-show rate', `${Math.round(r.no_show_rate * 100)}%`]].map(([l, v]) => (
              <Card key={String(l)}><div className="text-2xl font-display font-bold">{v}</div><div className="text-sm text-smoke">{l}</div></Card>))}
          </div>
          <Card>
            <h3 className="font-display font-bold mb-2">Top items</h3>
            {r.top_items.length === 0 ? <p className="text-sm text-smoke">No orders in this period.</p> : (
              <table className="w-full text-sm"><thead><tr className="text-left text-smoke"><th className="py-1">Item</th><th>Qty</th><th className="text-right">Revenue</th></tr></thead>
                <tbody>{r.top_items.map((t) => <tr key={t.name} className="border-t border-line"><td className="py-1.5">{t.name}</td><td>{t.qty}</td><td className="text-right">{money(t.revenue)}</td></tr>)}</tbody></table>)}
          </Card>
          <Card>
            <h3 className="font-display font-bold mb-2">Busiest times</h3>
            <div className="overflow-x-auto"><table className="text-xs" aria-label="Orders by day and hour"><thead><tr><th />{Array.from({ length: 24 }, (_, h) => <th key={h} className="px-0.5 font-normal text-smoke">{h}</th>)}</tr></thead>
              <tbody>{DOW.map((d, di) => <tr key={d}><th scope="row" className="pr-2 font-normal text-smoke text-left">{d}</th>
                {Array.from({ length: 24 }, (_, h) => { const n = cell(di, h); return <td key={h} title={`${d} ${h}:00 · ${n} order${n === 1 ? '' : 's'}`} className="w-5 h-5 text-center rounded-sm border border-paper" style={{ background: n ? `rgba(224,41,61,${0.15 + 0.85 * (n / max)})` : 'var(--rsm-steel, #26262c)' }}>{n || ''}</td>; })}</tr>)}</tbody></table></div>
          </Card>
          {businessWide && r.by_location.length > 0 && (
            <Card><h3 className="font-display font-bold mb-2">By location</h3>
              <table className="w-full text-sm"><tbody>{r.by_location.map((l) => <tr key={l.location_id} className="border-t border-line"><td className="py-1.5">{l.location_id.slice(0, 8)}</td><td>{l.orders} orders</td><td className="text-right">{money(l.online_sales)}</td></tr>)}</tbody></table></Card>)}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Fees and statements
export function FeesPanel({ api, location, perms, businessWide }: Base & { businessWide?: boolean }) {
  const toast = useToast();
  const led = useResource(() => api.ledger(businessWide ? null : location), [location, businessWide]);
  const st = useResource(() => api.statements(), []);
  const accrued = (led.data ?? []).filter((l) => l.status === 'accrued').reduce((s, l) => s + l.amount, 0);
  if ((led.loading && !led.data) || (st.loading && !st.data)) return <ListSkeleton rows={3} />;
  return (
    <div className="grid gap-4">
      <Card><div className="text-2xl font-display font-bold">{money(accrued)}</div><div className="text-sm text-smoke">Reservation fees accrued, not yet on a statement</div></Card>
      <Card>
        <h3 className="font-display font-bold mb-2">Monthly statements</h3>
        {(st.data ?? []).length === 0 ? <p className="text-sm text-smoke">No statements yet. The first one is issued at the start of next month.</p> : (
          <ul className="grid gap-2">{(st.data ?? []).map((s) => (
            <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2 first:border-0 first:pt-0">
              <div><div className="font-semibold">{s.period}</div><div className="text-xs text-smoke">{s.reservation_count} orders · {s.status}{s.paid_at ? ` ${new Date(s.paid_at).toLocaleDateString()}` : ''}</div></div>
              <div className="flex items-center gap-2"><strong>{money(s.total)}</strong>
                {s.pdf_url && <a className={btnGhost} href={s.pdf_url} target="_blank" rel="noopener noreferrer">PDF</a>}
                {s.csv_url && <a className={btnGhost} href={s.csv_url} target="_blank" rel="noopener noreferrer">CSV</a>}
                {perms.owner && s.status === 'issued' && <button className={btnGhost} onClick={async () => { try { await api.markStatementPaid(s.id); toast('Marked paid.'); void st.reload(); } catch (e) { toast(messageFor(e), 'error'); } }}>Mark paid</button>}
              </div>
            </li>))}</ul>)}
      </Card>
      <Card>
        <div className="flex justify-between items-center mb-2"><h3 className="font-display font-bold">Fee ledger</h3>
          <button className={btnGhost} disabled={!led.data?.length} onClick={() => download('fee-ledger.csv', [['Date', 'Reservation', 'Amount', 'Status', 'Period'], ...(led.data ?? []).map((l) => [l.created_at, l.reservation_id, l.amount, l.status, l.period])])}>Download CSV</button></div>
        {(led.data ?? []).length === 0 ? <p className="text-sm text-smoke">No fees yet.</p> : (
          <div className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left text-smoke"><th className="py-1">Date</th><th>Status</th><th>Period</th><th className="text-right">Fee</th></tr></thead>
            <tbody>{(led.data ?? []).slice(0, 200).map((l) => <tr key={l.id} className="border-t border-line"><td className="py-1.5">{new Date(l.created_at).toLocaleDateString()}</td><td>{l.status}</td><td>{l.period}</td><td className="text-right">{money(l.amount)}</td></tr>)}</tbody></table></div>)}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Staff permissions
export function StaffPanel({ api, perms }: Base) {
  const toast = useToast();
  const res = useResource(() => api.staff(), []);
  if (res.loading && !res.data) return <ListSkeleton rows={3} />;
  if (!perms.manage_staff) return <Notice>Only owners and admins can change staff permissions.</Notice>;
  async function flip(uid: string, key: string, granted: boolean) {
    const before = res.data;
    res.setData((p) => p && p.map((s) => (s.uid === uid ? { ...s, permissions: { ...s.permissions, [key]: granted } } : s)));
    try { await api.setPermission(uid, key, granted); }
    catch (e) { res.setData(before); toast(messageFor(e), 'error'); }
  }
  return (
    <div className="grid gap-3">
      <p className="text-sm text-smoke">Choose what each person can do in the Online Storefront. Owners and admins can always do everything. Changes are logged.</p>
      {(res.data ?? []).filter((s) => s.active).map((s) => (
        <Card key={s.uid}>
          <div className="font-semibold">{s.name} <span className="text-xs text-smoke">{s.role}</span></div>
          {s.role === 'admin' ? <p className="text-sm text-smoke mt-1">Admins have full access.</p> : (
            <div className="grid sm:grid-cols-2 gap-1 mt-2">{PERMISSION_KEYS.map(([k, label]) => (
              <label key={k} className="flex items-center justify-between gap-3 min-h-[44px]"><span className="text-sm">{label}</span>
                <Switch checked={!!s.permissions[k]} onChange={(v) => flip(s.uid, k, v)} label={`${s.name}: ${label}`} /></label>))}</div>)}
        </Card>))}
    </div>
  );
}

// ------------------------------------------------------------------ Owner: business-wide controls
export function BusinessControls({ api }: { api: StorefrontApi }) {
  const toast = useToast();
  const res = useResource(() => api.businessDefaults(), []);
  const [f, setF] = useState<BusinessDefaults | null>(null);
  useEffect(() => setF(res.data), [res.data]);
  if (!f) return res.loading ? <ListSkeleton rows={3} /> : <Notice tone="error">{res.error ?? 'Not available.'}</Notice>;
  const set = (p: Partial<BusinessDefaults>) => setF({ ...f, ...p });
  async function save() {
    if (!f) return;
    try {
      await api.saveBusinessDefaults({ storefront_enabled: f.storefront_enabled, hold_minutes: f.hold_minutes, order_cutoff_minutes: f.order_cutoff_minutes,
        max_items_per_order: f.max_items_per_order, max_qty_per_item: f.max_qty_per_item, fee_type: f.fee_type, fee_value: f.fee_value, fee_waived: f.fee_waived,
        first_order_fee_waiver: f.first_order_fee_waiver });
      toast('Saved.'); void res.reload();
    } catch (e) { toast(messageFor(e), 'error'); }
  }
  return (
    <div className="grid gap-4">
      <Card className="grid gap-3">
        <label className="flex items-center justify-between gap-3 min-h-[44px]"><span className="font-semibold">Online storefront</span>
          <Switch checked={f.storefront_enabled} onChange={(v) => set({ storefront_enabled: v })} label="Online storefront" /></label>
      </Card>
      <Card className="grid gap-3">
        <h3 className="font-display font-bold text-lg">Reservation fee</h3>
        <p className="text-sm text-smoke">Charged to your account on a monthly statement, not to the customer’s card. Leave blank to use Rackd’s standard fee.</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <Field label="Fee type">{(id) => <select id={id} className={input} value={f.fee_type ?? ''} onChange={(e) => set({ fee_type: (e.target.value || null) as BusinessDefaults['fee_type'] })}><option value="">Rackd standard</option><option value="percent">Percent of order</option><option value="flat">Flat per order</option></select>}</Field>
          <Field label={f.fee_type === 'flat' ? 'Amount ($)' : 'Percent (%)'}>{(id) => <input id={id} className={input} inputMode="decimal" disabled={!f.fee_type} value={f.fee_value ?? ''} onChange={(e) => set({ fee_value: e.target.value === '' ? null : Number(e.target.value) })} />}</Field>
        </div>
        <label className="flex items-center justify-between gap-3 min-h-[44px]"><span className="text-sm">Waive the fee entirely</span><Switch checked={f.fee_waived} onChange={(v) => set({ fee_waived: v })} label="Waive fee" /></label>
        <label className="flex items-center justify-between gap-3 min-h-[44px]"><span className="text-sm">Waive the fee on a customer’s first order</span><Switch checked={f.first_order_fee_waiver} onChange={(v) => set({ first_order_fee_waiver: v })} label="Waive first-order fee" /></label>
      </Card>
      <Card className="grid gap-3">
        <h3 className="font-display font-bold text-lg">Payment</h3>
        <label className="flex items-center justify-between gap-3 min-h-[44px]"><span className="text-sm">Pay at pickup (cash or card at your register)</span><Switch checked disabled onChange={() => undefined} label="Pay at pickup" /></label>
        <Tooltip label="Card prepay is not connected yet. Contact Rackd to set it up.">
          <label className="flex items-center justify-between gap-3 min-h-[44px] w-full opacity-60"><span className="text-sm">Prepay by card</span><Switch checked={false} disabled onChange={() => undefined} label="Prepay by card (not available)" /></label>
        </Tooltip>
      </Card>
      <div className="flex justify-end"><button className={btnPrimary} onClick={save}>Save</button></div>
    </div>
  );
}
