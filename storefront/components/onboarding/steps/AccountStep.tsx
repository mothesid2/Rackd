'use client';
import { useState } from 'react';
import { api, ApiError, messageFor, setToken } from '@/lib/onboarding/api';
import { isEmail, validateAccount } from '@/lib/onboarding/validate';
import { btnGhost, btnPrimary, Card, ErrorText, Notice, SelectField, TextField } from '../fields';
import { Turnstile } from '../Turnstile';
import type { StepProps } from './types';

const ROLES = [
  { value: 'owner', label: 'Owner' },
  { value: 'manager', label: 'Manager' },
  { value: 'other', label: 'Other' },
];

/** Step 1 before a draft exists: collects the account basics, runs the bot check, creates the draft. */
export function AccountCreate({ onCreated }: { onCreated: (token: string, devCode?: string) => void }) {
  const [f, setF] = useState({ full_name: '', email: '', phone: '', role: '' });
  const [fax, setFax] = useState(''); // honeypot: hidden from people, filled by naive bots
  const [ts, setTs] = useState('');
  const [tsKey, setTsKey] = useState(0);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<'new' | 'resume' | 'resume-sent'>('new');

  const errs = validateAccount({ full_name: f.full_name, email: f.email, phone: f.phone, contact_role: (f.role || null) as never });
  const show = (k: string) => (touched[k] ? errs[k] : undefined);
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const blur = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }));

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setTouched({ full_name: true, email: true, phone: true, contact_role: true });
    if (Object.keys(errs).length || !ts) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.create({ ...f, email: f.email.trim(), turnstileToken: ts, fax_number: fax });
      setToken(r.resume_token);
      onCreated(r.resume_token, r.dev_email_code);
    } catch (err) {
      setError(messageFor(err));
      setTsKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  async function requestLink(e: React.FormEvent) {
    e.preventDefault();
    if (!isEmail(f.email) || !ts) return setTouched((t) => ({ ...t, email: true }));
    setBusy(true);
    setError(null);
    try {
      await api.resumeRequest(f.email.trim(), ts);
      setMode('resume-sent');
    } catch (err) {
      setError(messageFor(err));
      setTsKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  if (mode === 'resume-sent') {
    return (
      <Card>
        <h3 className="font-display font-bold text-lg mb-2">Check your email</h3>
        <p className="text-sm">If we have an application for that address, we just sent a link to continue it. The link works once and expires in 7 days.</p>
        <button type="button" className={`${btnGhost} mt-4`} onClick={() => setMode('new')}>Back</button>
      </Card>
    );
  }

  if (mode === 'resume') {
    return (
      <Card>
        <form onSubmit={requestLink} className="grid gap-4" noValidate>
          <h3 className="font-display font-bold text-lg">Continue an application</h3>
          <TextField label="Email you applied with" type="email" inputMode="email" autoComplete="email" required value={f.email} onChange={set('email')} onBlur={blur('email')} error={show('email')} />
          <Turnstile action="resume" onToken={setTs} resetKey={tsKey} />
          <ErrorText>{error}</ErrorText>
          <div className="flex flex-wrap gap-3">
            <button className={btnPrimary} disabled={busy || !ts}>{busy ? 'Sending…' : 'Email me a link'}</button>
            <button type="button" className={btnGhost} onClick={() => { setMode('new'); setError(null); }}>Start a new application</button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card>
      <form onSubmit={create} className="grid gap-4" noValidate>
        <div className="grid sm:grid-cols-2 gap-4">
          <TextField label="Full name" autoComplete="name" required value={f.full_name} onChange={set('full_name')} onBlur={blur('full_name')} error={show('full_name')} />
          <SelectField label="Your role" required value={f.role} onChange={set('role')} onBlur={blur('contact_role')} options={ROLES} error={show('contact_role')} />
          <TextField label="Email" type="email" inputMode="email" autoComplete="email" required value={f.email} onChange={set('email')} onBlur={blur('email')} error={show('email')} hint="We will email you a code to verify this address." />
          <TextField label="Mobile phone" type="tel" inputMode="tel" autoComplete="tel" required value={f.phone} onChange={set('phone')} onBlur={blur('phone')} error={show('phone')} />
        </div>
        {/* honeypot: off-screen, not focusable, ignored by assistive tech */}
        <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px', width: 1, height: 1, overflow: 'hidden' }}>
          <label>Fax number<input tabIndex={-1} autoComplete="off" name="fax_number" value={fax} onChange={(e) => setFax(e.target.value)} /></label>
        </div>
        <Turnstile action="create" onToken={setTs} resetKey={tsKey} />
        <ErrorText>{error}</ErrorText>
        <div className="flex flex-wrap items-center gap-3">
          <button className={btnPrimary} disabled={busy || !ts}>{busy ? 'Creating…' : 'Create account and continue'}</button>
          <button type="button" className="text-sm underline text-smoke hover:text-ink min-h-[44px] px-2" onClick={() => { setMode('resume'); setError(null); }}>
            Already started? Email me a link
          </button>
        </div>
      </form>
    </Card>
  );
}

/** Step 1 with a draft: verify the email (if needed), then edit the contact basics. */
export function AccountStep({ draft, ctx, devCode }: StepProps & { devCode?: string }) {
  const a = draft.application;
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [dev, setDev] = useState<string | undefined>(devCode);

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!/^\d{6}$/.test(code.trim())) return setErr('Enter the 6-digit code.');
    setBusy(true);
    try {
      const r = await api.verifyEmail(code.trim());
      if (!r.verified) return setErr('That code is wrong or expired. Request a new one.');
      await ctx.reload();
    } catch (e2) {
      setErr(messageFor(e2));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setErr(null);
    setMsg(null);
    setBusy(true);
    try {
      const r = await api.sendCode();
      setDev(r.dev_email_code);
      setMsg(r.email_sent ? 'A new code is on its way.' : 'We could not send email right now. Please try again shortly.');
    } catch (e2) {
      setErr(e2 instanceof ApiError && e2.code === 'too_soon' ? 'Please wait a minute before requesting another code.' : messageFor(e2));
    } finally {
      setBusy(false);
    }
  }

  if (!a.email_verified_at) {
    return (
      <Card>
        <form onSubmit={verify} className="grid gap-4" noValidate>
          <div>
            <h3 className="font-display font-bold text-lg">Verify your email</h3>
            <p className="text-sm text-smoke mt-1">We sent a 6-digit code to <strong className="text-ink">{a.email}</strong>. You can also click the link in that email to continue.</p>
          </div>
          {dev && <Notice tone="dev">Dev mode: your code is <strong>{dev}</strong></Notice>}
          <TextField label="6-digit code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(v) => setCode(v.replace(/\D/g, ''))} error={err ?? undefined} />
          {msg && <p role="status" className="text-sm text-green-400">{msg}</p>}
          <div className="flex flex-wrap gap-3">
            <button className={btnPrimary} disabled={busy}>{busy ? 'Checking…' : 'Verify email'}</button>
            <button type="button" className={btnGhost} onClick={resend} disabled={busy}>Send a new code</button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card>
      <div className="grid sm:grid-cols-2 gap-4">
        <TextField label="Full name" autoComplete="name" required value={a.full_name} onChange={(v) => ctx.updateApp({ full_name: v })} onBlur={() => ctx.touch('full_name')} error={ctx.err('full_name')} />
        <SelectField label="Your role" required value={a.contact_role ?? ''} onChange={(v) => ctx.updateApp({ contact_role: (v || null) as never })} onBlur={() => ctx.touch('contact_role')} options={ROLES} error={ctx.err('contact_role')} />
        <div>
          <TextField label="Email" value={a.email} onChange={() => {}} disabled />
          <p className="mt-1 text-xs text-green-400">✓ Verified</p>
        </div>
        <TextField label="Mobile phone" type="tel" inputMode="tel" autoComplete="tel" required value={a.phone ?? ''} onChange={(v) => ctx.updateApp({ phone: v })} onBlur={() => ctx.touch('phone')} error={ctx.err('phone')} />
      </div>
      <p className="mt-4 text-xs text-smoke">Your progress saves automatically. If you close this tab, use the link in your email to pick up where you left off.</p>
    </Card>
  );
}

