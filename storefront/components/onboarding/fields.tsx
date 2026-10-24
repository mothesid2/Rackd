'use client';
import { useId, type ReactNode } from 'react';
import { Tooltip } from '../ui/Tooltip';

export const inputCls =
  'w-full min-h-[44px] rounded-lg bg-steel border border-line px-3 py-2 text-ink placeholder:text-smoke ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ember disabled:opacity-60 aria-[invalid=true]:border-red-400';

export const btnPrimary =
  'inline-flex items-center justify-center min-h-[44px] rounded-lg bg-accent hover:bg-ember transition-colors text-white font-semibold px-5 py-2 ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-char focus-visible:ring-ember disabled:opacity-50 disabled:cursor-not-allowed';
export const btnGhost =
  'inline-flex items-center justify-center min-h-[44px] rounded-lg border border-line hover:border-smoke text-ink font-semibold px-5 py-2 transition-colors ' +
  'focus:outline-none focus-visible:ring-2 focus-visible:ring-ember disabled:opacity-50 disabled:cursor-not-allowed';

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`bg-paper rounded-2xl border border-line p-4 sm:p-5 ${className}`}>{children}</div>;
}

export function ErrorText({ id, children }: { id?: string; children?: ReactNode }) {
  if (!children) return null;
  return <p id={id} role="alert" className="mt-1 text-sm text-red-400">{children}</p>;
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
  error?: string;
  hint?: ReactNode;
  tip?: string;
  type?: string;
  inputMode?: 'text' | 'numeric' | 'decimal' | 'tel' | 'email' | 'url';
  autoComplete?: string;
  placeholder?: string;
  maxLength?: number;
  required?: boolean;
  disabled?: boolean;
  name?: string;
}

export function TextField(p: FieldProps) {
  const id = useId();
  const errId = `${id}-err`;
  const hintId = `${id}-hint`;
  return (
    <div>
      <label htmlFor={id} className="flex items-center gap-1.5 text-sm font-semibold mb-1">
        <span>{p.label}{p.required && <span className="text-ember" aria-hidden="true"> *</span>}</span>
        {p.tip && (
          <Tooltip label={p.tip}>
            <span tabIndex={0} aria-label={p.tip} className="inline-flex w-4 h-4 items-center justify-center rounded-full border border-smoke text-[10px] text-smoke cursor-help">?</span>
          </Tooltip>
        )}
      </label>
      <input
        id={id}
        name={p.name}
        className={inputCls}
        type={p.type ?? 'text'}
        inputMode={p.inputMode}
        autoComplete={p.autoComplete}
        placeholder={p.placeholder}
        maxLength={p.maxLength}
        required={p.required}
        disabled={p.disabled}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        onBlur={p.onBlur}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={[p.error ? errId : '', p.hint ? hintId : ''].filter(Boolean).join(' ') || undefined}
      />
      {p.hint && <p id={hintId} className="mt-1 text-xs text-smoke">{p.hint}</p>}
      <ErrorText id={errId}>{p.error}</ErrorText>
    </div>
  );
}

export function NumberField(p: Omit<FieldProps, 'value' | 'onChange' | 'type'> & { value: number | null | undefined; onChange: (v: number | null) => void; step?: string }) {
  const { value, onChange, step: _s, ...rest } = p;
  return (
    <TextField
      {...rest}
      type="number"
      inputMode="decimal"
      value={value == null ? '' : String(value)}
      onChange={(s) => onChange(s.trim() === '' || Number.isNaN(Number(s)) ? null : Number(s))}
    />
  );
}

export function SelectField(p: {
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[];
  error?: string; required?: boolean; placeholder?: string; onBlur?: () => void; hint?: ReactNode;
}) {
  const id = useId();
  const errId = `${id}-err`;
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-semibold mb-1">
        {p.label}{p.required && <span className="text-ember" aria-hidden="true"> *</span>}
      </label>
      <select
        id={id}
        className={inputCls}
        value={p.value}
        onChange={(e) => p.onChange(e.target.value)}
        onBlur={p.onBlur}
        required={p.required}
        aria-invalid={p.error ? true : undefined}
        aria-describedby={p.error ? errId : undefined}
      >
        <option value="">{p.placeholder ?? 'Select…'}</option>
        {p.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {p.hint && <p className="mt-1 text-xs text-smoke">{p.hint}</p>}
      <ErrorText id={errId}>{p.error}</ErrorText>
    </div>
  );
}

export function CheckboxField(p: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; error?: string; hint?: ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="flex items-start gap-3 min-h-[44px] py-1 cursor-pointer">
        <input
          id={id}
          type="checkbox"
          className="mt-1 w-5 h-5 accent-[#e0293d] shrink-0"
          checked={p.checked}
          onChange={(e) => p.onChange(e.target.checked)}
          aria-invalid={p.error ? true : undefined}
          aria-describedby={p.error ? `${id}-err` : undefined}
        />
        <span className="text-sm leading-relaxed">{p.label}</span>
      </label>
      {p.hint && <p className="ml-8 -mt-1 text-xs text-smoke">{p.hint}</p>}
      <ErrorText id={`${id}-err`}>{p.error}</ErrorText>
    </div>
  );
}

export function Notice({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'dev'; children: ReactNode }) {
  const cls = tone === 'warn'
    ? 'border-amber-400/50 bg-amber-400/10 text-amber-100'
    : tone === 'dev' ? 'border-ember/60 bg-accent/10 text-ink' : 'border-line bg-steel text-ink';
  return <div role={tone === 'warn' ? 'note' : undefined} className={`rounded-lg border px-3 py-2.5 text-sm ${cls}`}>{children}</div>;
}

export function SectionTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-3">
      <h3 className="font-display font-bold text-lg">{children}</h3>
      {sub && <p className="text-sm text-smoke mt-0.5">{sub}</p>}
    </div>
  );
}
