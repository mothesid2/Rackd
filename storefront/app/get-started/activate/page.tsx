'use client';
import { Suspense, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { post, messageFor } from '@/lib/onboarding/api';
import { btnPrimary, Card, ErrorText, Notice, TextField } from '@/components/onboarding/fields';
import { Turnstile } from '@/components/onboarding/Turnstile';

function Activate() {
  const token = useSearchParams().get('token') ?? '';
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [ts, setTs] = useState('');
  const [tsKey, setTsKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const problem = pw.length > 0 && pw.length < 10 ? 'Use at least 10 characters.' : pw2 && pw !== pw2 ? 'The passwords do not match.' : null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pw.length < 10 || pw !== pw2 || !ts) return;
    setBusy(true); setErr(null);
    try {
      const r = await post<{ ok: boolean; username: string }>('activate', { invite: token, password: pw, turnstileToken: ts });
      setDone(r.username);
    } catch (e2) {
      const m = messageFor(e2);
      setErr(m === 'Your session expired. Use the link we emailed you to continue.' ? 'This link has expired or was already used. Ask us to send a new one.' : m);
      setTsKey((k) => k + 1);
    } finally { setBusy(false); }
  }

  if (!/^[0-9a-f]{64}$/.test(token)) return <Card><h1 className="font-display font-bold text-2xl mb-2">This link is not valid</h1><p className="text-sm text-smoke">Use the link from your welcome email, or contact support@r4ckd.net.</p></Card>;

  if (done) {
    return (
      <Card className="grid gap-3">
        <h1 className="font-display font-extrabold text-2xl">You are all set</h1>
        <p className="text-[15px]">Your account is ready. Sign in with:</p>
        <ul className="text-sm list-disc pl-5 grid gap-1"><li>your business activation key (in your welcome email)</li><li>username: <strong>{done}</strong></li><li>the password you just chose</li></ul>
        <p className="text-sm text-smoke">Your online storefront stays switched off until you publish it.</p>
        <Notice>You will be asked to set a register PIN the first time you use the POS.</Notice>
      </Card>
    );
  }

  return (
    <div className="max-w-md mx-auto grid gap-3">
      <div><p className="eyebrow text-red-400">Welcome to Rackd</p><h1 className="font-display font-extrabold text-3xl tracking-tight">Create your password</h1></div>
      <Card>
        <form onSubmit={submit} className="grid gap-4" noValidate>
          <TextField label="New password" type="password" autoComplete="new-password" required value={pw} onChange={setPw} hint="At least 10 characters." />
          <TextField label="Confirm password" type="password" autoComplete="new-password" required value={pw2} onChange={setPw2} error={problem ?? undefined} />
          <Turnstile action="activate" onToken={setTs} resetKey={tsKey} />
          <ErrorText>{err}</ErrorText>
          <button className={btnPrimary} disabled={busy || !ts || pw.length < 10 || pw !== pw2}>{busy ? 'Saving…' : 'Create password'}</button>
        </form>
      </Card>
      <Link href="/" className="text-xs text-smoke underline">Rackd home</Link>
    </div>
  );
}

export default function ActivatePage() {
  return <Suspense fallback={<p role="status" className="text-smoke">Loading…</p>}><Activate /></Suspense>;
}
