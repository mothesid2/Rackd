import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { messageFor } from './api';

// ------------------------------------------------------------------ data loading
export interface Resource<T> { data: T | null; loading: boolean; error: string | null; reload: () => Promise<void>; setData: (v: T | null | ((p: T | null) => T | null)) => void }

/** Loads on mount and whenever `key` changes; keeps old data visible while reloading. */
export function useResource<T>(fetcher: () => Promise<T>, key: unknown[]): Resource<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const fetchRef = useRef(fetcher);
  fetchRef.current = fetcher;
  const reload = useCallback(async () => {
    const my = ++seq.current;
    try {
      const v = await fetchRef.current();
      if (my === seq.current) { setData(v); setError(null); }
    } catch (e) {
      if (my === seq.current) setError(messageFor(e));
    } finally {
      if (my === seq.current) setLoading(false);
    }
  }, []);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setLoading(true); void reload(); }, key);
  return { data, loading, error, reload, setData };
}

// ------------------------------------------------------------------ toasts
interface Toast { id: number; text: string; tone: 'ok' | 'error' }
const ToastCtx = createContext<(text: string, tone?: 'ok' | 'error') => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastHost({ children, onToast }: { children: ReactNode; onToast?: (text: string, tone: 'ok' | 'error') => void }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone: 'ok' | 'error' = 'ok') => {
    const id = Date.now() + Math.random();
    setList((l) => [...l, { id, text, tone }]);
    onToast?.(text, tone);
    setTimeout(() => setList((l) => l.filter((t) => t.id !== id)), tone === 'error' ? 7000 : 3500);
  }, [onToast]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[9999] grid gap-2 w-[min(28rem,calc(100vw-2rem))]" role="status" aria-live="polite">
        {list.map((t) => (
          <div key={t.id} className={`rounded-xl px-4 py-3 text-sm shadow-lg border ${t.tone === 'error' ? 'bg-red-950 border-red-400/60 text-red-100' : 'bg-steel border-line text-ink'}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ------------------------------------------------------------------ primitives
export const btn = 'inline-flex items-center justify-center min-h-[44px] rounded-lg px-4 py-2 font-semibold text-sm transition-colors disabled:opacity-50 disabled:cursor-not-allowed';
export const btnPrimary = `${btn} bg-accent hover:bg-ember text-white`;
export const btnGhost = `${btn} border border-line hover:border-smoke text-ink`;
export const input = 'w-full min-h-[44px] rounded-lg bg-steel border border-line px-3 py-2 text-ink placeholder:text-smoke disabled:opacity-60';

export function Skeleton({ className = '' }: { className?: string }) { return <div className={`skel ${className}`} aria-hidden="true" />; }
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return <div className="grid gap-3" aria-busy="true" aria-label="Loading">{Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-16" />)}</div>;
}

export function Tooltip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const [show, setShow] = useState(false);
  return (
    <span className="relative inline-flex" onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)} onFocus={() => setShow(true)} onBlur={() => setShow(false)}>
      <span aria-describedby={show ? id : undefined} className="inline-flex">{children}</span>
      {show && <span id={id} role="tooltip" className="absolute z-50 bottom-full mb-1 left-1/2 -translate-x-1/2 w-max max-w-[240px] rounded-md bg-char border border-line px-2.5 py-1.5 text-xs text-ink shadow-lg pointer-events-none">{label}</span>}
    </span>
  );
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-paper rounded-2xl border border-line p-4 ${className}`}>{children}</div>;
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'error'; children: ReactNode }) {
  const c = tone === 'warn' ? 'border-amber-400/50 bg-amber-400/10 text-amber-100' : tone === 'error' ? 'border-red-400/60 bg-red-400/10 text-red-100' : 'border-line bg-steel text-ink';
  return <div role={tone === 'info' ? undefined : 'alert'} className={`rounded-lg border px-3 py-2.5 text-sm ${c}`}>{children}</div>;
}

export function Switch({ checked, onChange, label, disabled, big }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean; big?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled} onClick={() => onChange(!checked)}
      className={`relative shrink-0 rounded-full border border-line transition-colors ${big ? 'w-20 h-10' : 'w-12 h-7'} ${checked ? 'bg-accent' : 'bg-steel'}`}>
      <span className={`absolute top-0.5 rounded-full bg-white transition-all ${big ? 'w-8 h-8' : 'w-6 h-6'} ${checked ? (big ? 'left-[2.75rem]' : 'left-[1.4rem]') : 'left-0.5'}`} />
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: ReactNode; error?: string | null; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold mb-1">{label}</label>
      {children(id)}
      {hint && <p className="mt-1 text-xs text-smoke">{hint}</p>}
      {error && <p role="alert" className="mt-1 text-sm text-red-400">{error}</p>}
    </div>
  );
}

export function Modal({ open, title, onClose, children, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const tid = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} onClose={onClose} aria-labelledby={tid}
      className={`rsm-root rounded-2xl border border-line bg-paper text-ink p-0 backdrop:bg-black/70 ${wide ? 'w-[min(44rem,calc(100vw-1.5rem))]' : 'w-[min(30rem,calc(100vw-1.5rem))]'}`}>
      {open && <div className="p-5 grid gap-4"><h2 id={tid} className="font-display font-bold text-xl">{title}</h2>{children}</div>}
    </dialog>
  );
}

/** Radio-style status chips: one tap sets the status. */
export function StatusChips({ value, onChange, disabled, disabledReason }: { value: 'available' | 'sold_out' | 'hidden'; onChange: (v: 'available' | 'sold_out' | 'hidden') => void; disabled?: boolean; disabledReason?: string }) {
  const opts: ['available' | 'sold_out' | 'hidden', string][] = [['available', 'Available'], ['sold_out', 'Sold out'], ['hidden', 'Hidden']];
  const style = (o: string) => (o === 'available' ? 'bg-green-500/20 text-green-200 border-green-400/60' : o === 'sold_out' ? 'bg-red-500/20 text-red-200 border-red-400/60' : 'bg-steel text-ink border-smoke');
  const body = (
    <div role="radiogroup" aria-label="Status" className="inline-flex gap-1">
      {opts.map(([k, l]) => (
        <button key={k} type="button" role="radio" aria-checked={value === k} disabled={disabled} onClick={() => value !== k && onChange(k)}
          className={`min-h-[44px] min-w-[44px] px-2.5 rounded-lg text-xs font-semibold border ${value === k ? style(k) : 'border-line text-smoke hover:text-ink'} disabled:opacity-50`}>{l}</button>
      ))}
    </div>
  );
  return disabled && disabledReason ? <Tooltip label={disabledReason}>{body}</Tooltip> : body;
}
