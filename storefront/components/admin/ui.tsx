'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import { permitFlag } from '@/lib/admin/api';

const STATUS_STYLE: Record<string, string> = {
  draft: 'bg-steel text-smoke', submitted: 'bg-sky-400/15 text-sky-300', in_review: 'bg-violet-400/15 text-violet-300',
  needs_info: 'bg-amber-400/15 text-amber-300', approved: 'bg-green-400/15 text-green-300', activated: 'bg-green-500/25 text-green-200',
  rejected: 'bg-red-400/15 text-red-300',
  pending: 'bg-steel text-smoke', paid: 'bg-green-400/15 text-green-300', fulfilled: 'bg-sky-400/15 text-sky-300',
  shipped: 'bg-violet-400/15 text-violet-300', cancelled: 'bg-red-400/15 text-red-300', refunded: 'bg-amber-400/15 text-amber-300',
};

export function StatusBadge({ status }: { status: string }) {
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap ${STATUS_STYLE[status] ?? 'bg-steel text-smoke'}`}>{status.replace(/_/g, ' ')}</span>;
}

/** Red = expired or within 30 days. Text is always present, so colour is never the only signal. */
export function PermitBadge({ expiry, flag }: { expiry?: string | null; flag?: 'expired' | 'soon' | 'ok' | null }) {
  const f = flag ?? permitFlag(expiry ?? null);
  if (!f || f === 'ok') return null;
  return f === 'expired'
    ? <span className="inline-block rounded px-2 py-0.5 text-xs font-bold bg-red-500/25 text-red-200">⚠ Expired</span>
    : <span className="inline-block rounded px-2 py-0.5 text-xs font-bold bg-red-500/15 text-red-300">⚠ Expires within 30 days</span>;
}

export function Modal({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby="modal-title"
      className="w-[min(32rem,calc(100vw-2rem))] rounded-2xl border border-line bg-paper text-ink p-0 backdrop:bg-black/70">
      {open && (
        <div className="p-5 grid gap-4">
          <h2 id="modal-title" className="font-display font-bold text-xl">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}

export function Dl({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="grid grid-cols-[8.5rem_1fr] gap-3 text-sm py-0.5">
          <dt className="text-smoke">{k}</dt>
          <dd className="break-words min-w-0">{v === null || v === undefined || v === '' ? <span className="text-smoke">—</span> : v}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="bg-paper rounded-2xl border border-line p-4 sm:p-5">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="font-display font-bold text-lg">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export const selectCls = 'w-full min-w-0 min-h-[44px] rounded-lg bg-steel border border-line px-3 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ember';
