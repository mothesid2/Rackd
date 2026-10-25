'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { btnGhost, btnPrimary, Card, ErrorText, Notice, TextField } from '../onboarding/fields';
import { SkeletonOrderCard } from '../ui/Skeleton';

type Gate = 'loading' | 'signedout' | 'denied' | 'ok';

function SignIn({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function sendCode(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    // shouldCreateUser:false => this page can never create accounts; only existing users get a code.
    const { error } = await supabase().auth.signInWithOtp({ email: email.trim(), options: { shouldCreateUser: false, emailRedirectTo: `${window.location.origin}/admin/` } });
    setBusy(false);
    // Same message either way so the form does not reveal which emails exist.
    if (error && /rate|too many|seconds/i.test(error.message)) return setErr('Please wait a minute before requesting another code.');
    setStep('code');
  }

  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    const { error } = await supabase().auth.verifyOtp({ email: email.trim(), token: code.trim(), type: 'email' });
    setBusy(false);
    if (error) return setErr('That code is wrong or has expired.');
    onDone();
  }

  return (
    <div className="max-w-md mx-auto">
      <Card>
        <h1 className="font-display font-extrabold text-2xl mb-1">Rackd admin</h1>
        <p className="text-sm text-smoke mb-4">Platform administrators only.</p>
        {step === 'email' ? (
          <form onSubmit={sendCode} className="grid gap-4" noValidate>
            <TextField label="Email" type="email" inputMode="email" autoComplete="email" required value={email} onChange={setEmail} />
            <ErrorText>{err}</ErrorText>
            <button className={btnPrimary} disabled={busy || !email.includes('@')}>{busy ? 'Sending…' : 'Email me a sign-in code'}</button>
          </form>
        ) : (
          <form onSubmit={verify} className="grid gap-4" noValidate>
            <p className="text-sm">If <strong>{email}</strong> is an admin account, a code is on its way. You can also click the link in the email.</p>
            <TextField label="Code" inputMode="numeric" autoComplete="one-time-code" maxLength={10} required value={code} onChange={(v) => setCode(v.replace(/\D/g, ''))} />
            <ErrorText>{err}</ErrorText>
            <div className="flex flex-wrap gap-3">
              <button className={btnPrimary} disabled={busy || code.length < 6}>{busy ? 'Checking…' : 'Sign in'}</button>
              <button type="button" className={btnGhost} onClick={() => { setStep('email'); setCode(''); setErr(null); }}>Use a different email</button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}

const NAV = [
  { href: '/admin/', label: 'Applications', match: (p: string) => p === '/admin/' || p === '/admin' || p.startsWith('/admin/application') },
  { href: '/admin/orders/', label: 'Hardware orders', match: (p: string) => p.startsWith('/admin/order') },
  { href: '/admin/config/', label: 'Pricing & config', match: (p: string) => p.startsWith('/admin/config') },
  { href: '/admin/audit/', label: 'Audit log', match: (p: string) => p.startsWith('/admin/audit') },
];

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const [gate, setGate] = useState<Gate>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const path = usePathname() ?? '';

  const check = useCallback(async () => {
    const { data } = await supabase().auth.getSession();
    setSession(data.session);
    if (!data.session) return setGate('signedout');
    // The database decides: admin_whoami() returns the user's id only if they are in platform_admins.
    const { data: who, error } = await supabase().rpc('admin_whoami');
    setGate(!error && who ? 'ok' : 'denied');
  }, []);

  useEffect(() => {
    void check();
    const { data: sub } = supabase().auth.onAuthStateChange((evt) => {
      if (evt === 'SIGNED_IN' || evt === 'SIGNED_OUT' || evt === 'TOKEN_REFRESHED') void check();
    });
    return () => sub.subscription.unsubscribe();
  }, [check]);

  const signOut = async () => { await supabase().auth.signOut(); setGate('signedout'); };

  if (gate === 'loading') return <div aria-busy="true" className="grid gap-3"><SkeletonOrderCard /><SkeletonOrderCard /></div>;
  if (gate === 'signedout') return <SignIn onDone={() => void check()} />;
  if (gate === 'denied') {
    return (
      <div className="max-w-md mx-auto grid gap-3">
        <Notice tone="warn"><strong>Not authorized.</strong> {session?.user.email} is signed in but is not a platform administrator.</Notice>
        <div><button className={btnGhost} onClick={signOut}>Sign out</button></div>
      </div>
    );
  }
  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <p className="eyebrow text-accent">Admin console</p>
        <p className="text-xs text-smoke">{session?.user.email} · <button type="button" className="underline min-h-[44px] px-1" onClick={signOut}>Sign out</button></p>
      </div>
      <nav aria-label="Admin" className="flex flex-wrap gap-x-1 border-b border-line mb-5 -mx-1">
        {NAV.map((n) => (
          <Link key={n.href} href={n.href} aria-current={n.match(path) ? 'page' : undefined}
            className={`min-h-[44px] inline-flex items-center px-3 text-sm border-b-2 transition-colors ${n.match(path) ? 'border-ember text-ink font-semibold' : 'border-transparent text-smoke hover:text-ink'}`}>
            {n.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
