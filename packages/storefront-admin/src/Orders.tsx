import { useCallback, useEffect, useRef, useState } from 'react';
import { messageFor, type StorefrontApi } from './api';
import { isRestrictedCategory } from './inventory';
import type { Permissions, Reservation } from './types';
import { btnGhost, btnPrimary, Field, input, ListSkeleton, Modal, Notice, Switch, Tooltip, useResource, useToast } from './ui';
import { holdLabel, money, shortName } from './util';

interface Props { api: StorefrontApi; location: string; perms: Permissions }

const COLS: { key: 'new' | 'ready' | 'done'; title: string }[] = [
  { key: 'new', title: 'New' }, { key: 'ready', title: 'Ready' }, { key: 'done', title: 'Picked up' },
];
const colOf = (r: Reservation) => (r.status === 'new' || r.status === 'confirmed' ? (r.status === 'new' ? 'new' : 'new') : r.status === 'ready' ? 'ready' : 'done');

/** Short two-tone beep via WebAudio. Only runs after the user taps "Enable alerts" (browser autoplay rules). */
function beep(ctx: AudioContext | null) {
  if (!ctx) return;
  const t = ctx.currentTime;
  [880, 660].forEach((f, n) => {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.frequency.value = f; o.connect(g); g.connect(ctx.destination);
    g.gain.setValueAtTime(0.0001, t + n * 0.25); g.gain.exponentialRampToValueAtTime(0.3, t + n * 0.25 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + n * 0.25 + 0.22);
    o.start(t + n * 0.25); o.stop(t + n * 0.25 + 0.24);
  });
}

export function Orders({ api, location, perms }: Props) {
  const toast = useToast();
  const res = useResource(() => api.reservations(location), [location]);
  const [alerts, setAlerts] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [idFor, setIdFor] = useState<Reservation | null>(null);
  const [cancelFor, setCancelFor] = useState<Reservation | null>(null);
  const [unavail, setUnavail] = useState<Reservation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const alertsRef = useRef(false);
  alertsRef.current = alerts;
  const reload = res.reload;

  useEffect(() => {
    const off = api.subscribeReservations(location, (kind) => {
      void reload();
      if (kind === 'insert') {
        setFlash('New online order!');
        if (alertsRef.current) beep(audio.current);
        setTimeout(() => setFlash(null), 8000);
      }
    });
    const poll = setInterval(() => void reload(), 30000);          // safety net if the realtime socket drops
    return () => { off(); clearInterval(poll); };
  }, [api, location, reload]);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 30000); return () => clearInterval(t); }, []);

  const enableAlerts = () => {
    try { audio.current = audio.current ?? new AudioContext(); void audio.current.resume(); beep(audio.current); setAlerts(true); }
    catch { toast('This device cannot play alert sounds. The on-screen banner still works.', 'error'); }
  };

  const act = useCallback(async (id: string, fn: () => Promise<void>, ok?: string) => {
    setBusy(id);
    try { await fn(); if (ok) toast(ok); await reload(); }
    catch (e) { toast(messageFor(e), 'error'); await reload(); }
    finally { setBusy(null); }
  }, [reload, toast]);

  if (res.loading && !res.data) return <ListSkeleton />;
  const list = res.data ?? [];
  void tick;
  const can = perms.orders_manage;
  const why = can ? undefined : 'You do not have permission to manage orders.';

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        {alerts ? <span className="text-sm text-green-300">Alerts on (sound + banner)</span>
          : <button className={btnGhost} onClick={enableAlerts}>Enable alerts</button>}
        <span className="flex-1" />
        <button className={btnGhost} onClick={() => void reload()}>Refresh</button>
      </div>
      {flash && <div role="alert" className="rounded-xl bg-accent text-white px-4 py-3 font-bold text-lg animate-pulse">{flash}</div>}
      {res.error && <Notice tone="error">{res.error}</Notice>}
      {!can && <Notice>You can view orders but not change them.</Notice>}

      <div className="grid gap-4 lg:grid-cols-3">
        {COLS.map((c) => {
          const rows = list.filter((r) => (r.status === 'cancelled' || r.status === 'no_show' ? c.key === 'done' : colOf(r) === c.key));
          return (
            <section key={c.key} aria-label={c.title} className="grid gap-3 content-start">
              <h3 className="font-display font-bold text-lg flex items-center gap-2">{c.title}<span className="text-xs rounded-full bg-steel px-2 py-0.5">{rows.length}</span></h3>
              {rows.length === 0 && <div className="rounded-xl border border-dashed border-line p-5 text-sm text-smoke text-center">Nothing here.</div>}
              {rows.map((r) => <OrderCard key={r.id} r={r} can={can} why={why} busy={busy === r.id}
                onConfirm={() => act(r.id, () => api.confirm(r.id))}
                onReady={() => act(r.id, () => api.markReady(r.id), 'Marked ready. The customer was told.')}
                onPickup={() => (r.id_checked_at_pickup ? act(r.id, () => api.pickup(r.id, true), 'Picked up.') : setIdFor(r))}
                onNoShow={() => confirm('Mark as no-show? No fee is charged.') && act(r.id, () => api.noShow(r.id))}
                onCancel={() => setCancelFor(r)} onUnavailable={() => setUnavail(r)}
                onPay={() => act(r.id, () => api.payRegister(r.id), 'Recorded as paid at the register.')} />)}
            </section>
          );
        })}
      </div>

      {idFor && <IdCheck r={idFor} onClose={() => setIdFor(null)} onConfirm={async () => { const r = idFor; setIdFor(null); await act(r.id, () => api.pickup(r.id, true), 'Picked up.'); }} />}
      {cancelFor && <CancelDialog r={cancelFor} onClose={() => setCancelFor(null)} onConfirm={async (reason) => { const r = cancelFor; setCancelFor(null); await act(r.id, () => api.cancel(r.id, reason), 'Order cancelled.'); }} />}
      {unavail && <UnavailableDialog api={api} location={location} r={unavail} onClose={() => setUnavail(null)} onDone={() => { setUnavail(null); void reload(); }} />}
    </div>
  );
}

function OrderCard({ r, can, why, busy, onConfirm, onReady, onPickup, onNoShow, onCancel, onUnavailable, onPay }: {
  r: Reservation; can: boolean; why?: string; busy: boolean;
  onConfirm: () => void; onReady: () => void; onPickup: () => void; onNoShow: () => void; onCancel: () => void; onUnavailable: () => void; onPay: () => void;
}) {
  const open = r.status === 'new' || r.status === 'confirmed' || r.status === 'ready';
  const hold = open ? holdLabel(r.hold_expires_at) : null;
  const lines = r.reservation_items.filter((l) => !l.is_removed);
  const restricted = lines.some((l) => isRestrictedCategory(l.category));
  const dis = !can || busy;
  const Btn = ({ label, onClick, primary }: { label: string; onClick: () => void; primary?: boolean }) => {
    const b = <button className={primary ? btnPrimary : btnGhost} disabled={dis} onClick={onClick}>{label}</button>;
    return !can && why ? <Tooltip label={why}>{b}</Tooltip> : b;
  };
  return (
    <article className={`rounded-2xl border bg-paper p-3 grid gap-2 ${hold?.overdue ? 'border-red-400/70' : 'border-line'}`} aria-label={`Order ${r.code}`}>
      <header className="flex items-start justify-between gap-2">
        <div><div className="font-bold text-lg">{r.code}</div><div className="text-sm text-smoke">{shortName(r.customer_name)} · {new Date(r.created_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div></div>
        <div className="text-right">
          <span className="text-xs rounded-full bg-steel px-2 py-0.5">{r.status.replace('_', ' ')}</span>
          {hold && <div className={`text-xs mt-1 ${hold.urgent ? 'text-red-300 font-semibold' : 'text-smoke'}`}>{hold.text}</div>}
        </div>
      </header>
      <ul className="text-sm grid gap-0.5">
        {r.reservation_items.map((l) => <li key={l.id} className={l.is_removed ? 'line-through text-smoke' : ''}>{l.qty} × {l.name} <span className="text-smoke">{money(l.line_total)}</span></li>)}
      </ul>
      {r.notes && <p className="text-xs text-smoke">Note: {r.notes}</p>}
      {r.cancel_reason && <p className="text-xs text-smoke">Reason: {r.cancel_reason}</p>}
      <div className="text-sm border-t border-line pt-2">
        <div className="flex justify-between"><span>Items</span><span>{money(r.subtotal)}</span></div>
        {r.fee_amount > 0 && <div className="flex justify-between text-smoke"><span>Reservation fee</span><span>{money(r.fee_amount)}</span></div>}
        <div className="flex justify-between font-bold"><span>Total</span><span>{money(r.total)}</span></div>
      </div>
      {r.payment_mode === 'pay_at_pickup' && open && (
        <div className="rounded-lg bg-steel px-3 py-2 font-semibold text-center">{r.payment_status === 'paid_at_register' ? 'Paid at register' : `Collect at register: ${money(r.total)}`}</div>
      )}
      {restricted && open && <p className="text-xs text-amber-300">Contains age-restricted items. Check ID at pickup.</p>}
      {open && (
        <div className="flex flex-wrap gap-2">
          {r.status === 'new' && <Btn primary label="Confirm" onClick={onConfirm} />}
          {(r.status === 'new' || r.status === 'confirmed') && <Btn primary label="Mark ready" onClick={onReady} />}
          {r.status === 'ready' && <Btn primary label="Picked up" onClick={onPickup} />}
          {r.payment_mode === 'pay_at_pickup' && r.payment_status === 'unpaid' && r.status === 'ready' && <Btn label="Paid at register" onClick={onPay} />}
          <Btn label="Item unavailable" onClick={onUnavailable} />
          {r.status === 'ready' && <Btn label="No-show" onClick={onNoShow} />}
          <Btn label="Cancel" onClick={onCancel} />
        </div>
      )}
    </article>
  );
}

function IdCheck({ r, onClose, onConfirm }: { r: Reservation; onClose: () => void; onConfirm: () => void }) {
  const [ok, setOk] = useState(false);
  return (
    <Modal open title={`Pickup ${r.code}`} onClose={onClose}>
      <p className="text-sm">Ask for a valid government photo ID before handing over {shortName(r.customer_name)}’s order.</p>
      <label className="flex items-center gap-3 min-h-[44px] font-semibold">
        <input type="checkbox" className="w-6 h-6 accent-[#e0293d]" checked={ok} onChange={(e) => setOk(e.target.checked)} />ID checked, customer is 21+
      </label>
      <div className="flex justify-end gap-2"><button className={btnGhost} onClick={onClose}>Back</button><button className={btnPrimary} disabled={!ok} onClick={onConfirm}>Complete pickup</button></div>
    </Modal>
  );
}

function CancelDialog({ r, onClose, onConfirm }: { r: Reservation; onClose: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState('');
  const presets = ['Out of stock', 'Customer asked to cancel', 'Could not reach customer', 'Closed early'];
  return (
    <Modal open title={`Cancel ${r.code}`} onClose={onClose}>
      <div className="flex flex-wrap gap-2">{presets.map((p) => <button key={p} className={btnGhost} onClick={() => setReason(p)}>{p}</button>)}</div>
      <Field label="Reason (shown to the customer)">{(id) => <input id={id} className={input} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />}</Field>
      <div className="flex justify-end gap-2"><button className={btnGhost} onClick={onClose}>Keep order</button><button className={btnPrimary} disabled={reason.trim().length < 2} onClick={() => onConfirm(reason.trim())}>Cancel order</button></div>
    </Modal>
  );
}

function UnavailableDialog({ api, location, r, onClose, onDone }: { api: StorefrontApi; location: string; r: Reservation; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const lines = r.reservation_items.filter((l) => !l.is_removed);
  const [line, setLine] = useState(lines[0]?.id ?? '');
  const [repl, setRepl] = useState('');
  const items = useResource(() => api.items(location), [location]);
  const options = (items.data ?? []).filter((i) => i.status === 'available');
  async function go() {
    try { await api.itemUnavailable(r.id, line, repl || undefined, repl ? lines.find((l) => l.id === line)?.qty : undefined); toast(repl ? 'Replaced. The customer was told.' : 'Removed. The customer was told.'); onDone(); }
    catch (e) { toast(messageFor(e), 'error'); }
  }
  return (
    <Modal open title={`Item unavailable (${r.code})`} onClose={onClose}>
      <Field label="Which item?">{(id) => <select id={id} className={input} value={line} onChange={(e) => setLine(e.target.value)}>{lines.map((l) => <option key={l.id} value={l.id}>{l.qty} × {l.name}</option>)}</select>}</Field>
      <Field label="Replace with (optional)" hint="Leave empty to just remove the item.">{(id) => (
        <select id={id} className={input} value={repl} onChange={(e) => setRepl(e.target.value)}><option value="">Remove only</option>{options.map((i) => <option key={i.id} value={i.id}>{i.name} {i.price != null ? `(${money(i.price)})` : ''}</option>)}</select>)}
      </Field>
      <div className="flex justify-end gap-2"><button className={btnGhost} onClick={onClose}>Back</button><button className={btnPrimary} disabled={!line} onClick={go}>Apply</button></div>
    </Modal>
  );
}

export { Switch };
