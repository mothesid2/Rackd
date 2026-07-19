'use client';
import { useEffect, useState, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

// Accepts a bare 10-digit US number (5550001234), a 1-prefixed 11-digit number,
// common punctuation "(555) 000-1234", or an already-E.164 "+…". Returns E.164
// or null when it clearly isn't a usable number.
function normalizePhone(raw: string): string | null {
  const t = (raw || '').trim();
  const d = t.replace(/\D/g, '');
  if (t.startsWith('+')) return d.length >= 8 ? '+' + d : null;
  if (d.length === 10) return '+1' + d;
  if (d.length === 11 && d[0] === '1') return '+' + d;
  return null;
}

// Whole years between dob (YYYY-MM-DD) and today; NaN if unparseable.
function ageFrom(dob: string): number {
  const b = new Date(dob + 'T00:00:00');
  if (isNaN(b.getTime())) return NaN;
  const now = new Date();
  let a = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) a--;
  return a;
}

export default function Account() {
  const [session, setSession] = useState<Session | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [welcomeBack, setWelcomeBack] = useState<string | null>(null);

  // signed-in view: DOB (age gate) + phone + per-use-case SMS consent
  const [dob, setDob] = useState('');
  const [ageErr, setAgeErr] = useState<string | null>(null);
  const [phone, setPhone] = useState('');
  const [smsOrders, setSmsOrders] = useState(false);
  const [smsMarketing, setSmsMarketing] = useState(false);

  const refresh = useCallback(async () => {
    const { data: { session } } = await supabase().auth.getSession();
    setSession(session);
    if (session) {
      await supabase().from('storefront_customers').upsert({ id: session.user.id, email: session.user.email }, { onConflict: 'id', ignoreDuplicates: true });
      const { data } = await supabase().from('storefront_customers').select('*').eq('id', session.user.id).maybeSingle();

      const returning = !!data?.first_name;
      const createdThisSession = typeof window !== 'undefined' && sessionStorage.getItem('rackd_created') === '1';
      if (returning && !createdThisSession) setWelcomeBack(data.first_name as string);

      // Creation session: backfill the profile from what was captured at signup
      // (auth user_metadata, or localStorage from the phone/social path).
      const meta = (session.user.user_metadata || {}) as Record<string, string>;
      const ls = (k: string) => (typeof window !== 'undefined' ? localStorage.getItem(k) || '' : '');
      const patch: Record<string, string> = {};
      if (!data?.first_name && (meta.first_name || ls('rackd_first'))) patch.first_name = meta.first_name || ls('rackd_first');
      if (!data?.last_name && (meta.last_name || ls('rackd_last'))) patch.last_name = meta.last_name || ls('rackd_last');
      if (!data?.phone && (meta.phone || ls('rackd_phone') || session.user.phone)) patch.phone = meta.phone || ls('rackd_phone') || session.user.phone || '';
      if (Object.keys(patch).length) {
        await supabase().from('storefront_customers').update(patch).eq('id', session.user.id);
        Object.assign(data || {}, patch);
        if (typeof window !== 'undefined') { ['rackd_first', 'rackd_last', 'rackd_phone'].forEach((k) => localStorage.removeItem(k)); sessionStorage.setItem('rackd_created', '1'); }
      }
      // DOB captured at signup feeds the existing age gate.
      const signupDob = meta.dob || ls('rackd_dob');
      if (signupDob && !data?.age_verified) {
        await supabase().rpc('self_attest_age', { p_dob: signupDob }).then(({ error }: { error: unknown }) => { if (!error && typeof window !== 'undefined') localStorage.removeItem('rackd_dob'); });
        const { data: d2 } = await supabase().from('storefront_customers').select('*').eq('id', session.user.id).maybeSingle();
        if (d2) { setProfile(d2); if (d2.phone) setPhone(d2.phone); setSmsOrders(!!d2.sms_consent_transactional); setSmsMarketing(!!d2.sms_consent_marketing); setLoading(false); return; }
      }

      setProfile(data);
      if (data?.phone) setPhone(data.phone);
      setSmsOrders(!!data?.sms_consent_transactional);
      setSmsMarketing(!!data?.sms_consent_marketing);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const { data: sub } = supabase().auth.onAuthStateChange(() => refresh());
    return () => sub.subscription.unsubscribe();
  }, [refresh]);

  async function savePhone() {
    if (!session) return;
    const p = normalizePhone(phone);
    if (!p) { alert('Enter a valid 10-digit US phone number.'); return; }
    setBusy(true);
    await supabase().from('storefront_customers').update({
      phone: p,
      sms_consent_transactional: smsOrders,
      sms_consent_marketing: smsMarketing,
      sms_consent_at: new Date().toISOString(),
    }).eq('id', session.user.id);
    setPhone(p);
    setBusy(false); refresh();
  }
  async function attestAge() {
    setAgeErr(null);
    if (!dob) { setAgeErr('Enter your date of birth.'); return; }
    // Block under-21 before the RPC so social/phone signups can't linger as a
    // half-created account: we sign them straight back out.
    if (ageFrom(dob) < 21) {
      setAgeErr('You must be 21 or older to use this store. Signing you out…');
      await supabase().auth.signOut();
      setTimeout(() => location.reload(), 1500);
      return;
    }
    setBusy(true);
    const { error } = await supabase().rpc('self_attest_age', { p_dob: dob });
    setBusy(false);
    if (error) {
      const m = error.message || '';
      if (/under_21/.test(m)) { setAgeErr('You must be 21 or older to use this store. Signing you out…'); await supabase().auth.signOut(); setTimeout(() => location.reload(), 1500); return; }
      else if (/dob_invalid/.test(m)) setAgeErr('That date of birth isn’t valid.');
      else setAgeErr(m);
      return;
    }
    refresh();
  }

  if (loading) return <p className="text-smoke">Loading…</p>;
  if (!session) return <AuthPanel />;

  const verified = !!profile?.age_verified;
  return (
    <div className="grid gap-4">
      {welcomeBack && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 px-4 py-3">
          <div className="text-lg font-extrabold">Welcome back, {welcomeBack}</div>
        </div>
      )}
      <h1 className="text-2xl font-extrabold">Account</h1>
      <div className="bg-white rounded-xl border p-4">
        <div className="text-sm text-smoke">Signed in as</div>
        <div className="font-semibold">{session.user.email || session.user.phone}</div>
      </div>

      <div className="bg-white rounded-xl border p-4">
        <div className="font-semibold mb-2">Age verification (21+)</div>
        {verified ? (
          <div className="text-green-700">✓ Verified{profile.age_verified_at ? ` on ${new Date(profile.age_verified_at).toLocaleDateString()}` : ''}</div>
        ) : (
          <>
            <p className="text-sm text-smoke mb-3">Required before checkout. Enter your date of birth to confirm you are 21 or older. <strong>Bring a valid government photo ID to pick up your order</strong> — staff verify it in person.</p>
            <div className="flex gap-2 items-center">
              <input className="border rounded-lg px-3 py-2" type="date" value={dob} onChange={(e) => setDob(e.target.value)} max={new Date().toISOString().slice(0, 10)} />
              <button className="rounded-lg bg-accent text-white px-4 py-2.5 font-semibold disabled:opacity-40" disabled={busy} onClick={attestAge}>Confirm I&apos;m 21+</button>
            </div>
            {ageErr && <div className="text-red-600 text-sm mt-2">{ageErr}</div>}
          </>
        )}
      </div>

      <div className="bg-white rounded-xl border p-4">
        <div className="font-semibold mb-2">Mobile number</div>
        <div className="flex gap-2">
          <input className="border rounded-lg px-3 py-2 flex-1" placeholder="(555) 000-0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="rounded-lg border px-4" onClick={savePhone} disabled={busy}>Save</button>
        </div>

        <div className="mt-3 grid gap-2">
          <div className="text-sm font-semibold">Text me about:</div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={smsOrders} onChange={(e) => setSmsOrders(e.target.checked)} />
            <span><strong>Order &amp; pickup updates</strong> — confirmations and a text when my order is ready to collect.</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={smsMarketing} onChange={(e) => setSmsMarketing(e.target.checked)} />
            <span><strong>Deals &amp; promotions</strong> — occasional offers from my store.</span>
          </label>
          <p className="text-xs text-smoke leading-relaxed">
            By checking a box you agree to receive automated text messages from Rackd at the number above. Consent isn&apos;t a condition of purchase.
            Message frequency varies. Message &amp; data rates may apply. Reply <strong>STOP</strong> to unsubscribe, <strong>HELP</strong> for help.
            See our <a href="mailto:support@r4ckd.net" className="underline">contact</a> for questions.
          </p>
        </div>
      </div>

      <button className="text-sm text-smoke text-left" onClick={async () => { await supabase().auth.signOut(); location.reload(); }}>Sign out</button>
    </div>
  );
}

// ── signed-out: social / phone / email+password ──────────────────────────────
function AuthPanel() {
  const [tab, setTab] = useState<'email' | 'phone'>('email');
  const [mode, setMode] = useState<'signup' | 'signin'>('signup');
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [dob, setDob] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const stash = () => { if (typeof window === 'undefined') return; localStorage.setItem('rackd_first', first.trim()); localStorage.setItem('rackd_last', last.trim()); localStorage.setItem('rackd_phone', normalizePhone(phone) || phone.trim()); localStorage.setItem('rackd_dob', dob); };

  async function oauth(provider: 'apple' | 'google') {
    setErr(null);
    // Trailing slash matches next.config `trailingSlash: true` so we don't 308 mid-callback.
    const { error } = await supabase().auth.signInWithOAuth({ provider, options: { redirectTo: origin + '/account/' } });
    if (error) setErr(`Couldn’t start ${provider === 'apple' ? 'Apple' : 'Google'} sign-in: ${error.message}`);
  }
  async function signUp() {
    setErr(null); setMsg(null);
    if (!first.trim() || !last.trim() || !dob) return setErr('Please fill in your name and date of birth.');
    const age = ageFrom(dob);
    if (isNaN(age)) return setErr('That date of birth isn’t valid.');
    if (age < 21) return setErr('You must be 21 or older to create an account.');
    if (!email || password.length < 6) return setErr('Enter an email and a password (6+ characters).');
    const normPhone = phone.trim() ? normalizePhone(phone) : '';
    if (phone.trim() && !normPhone) return setErr('Enter a valid 10-digit US phone number.');
    stash();
    setBusy(true);
    const { data, error } = await supabase().auth.signUp({
      email, password,
      options: { emailRedirectTo: origin + '/account/', data: { first_name: first.trim(), last_name: last.trim(), full_name: `${first} ${last}`.trim(), phone: normPhone || '', dob } },
    });
    setBusy(false);
    if (error) return setErr(error.message);
    if (!data.session) setMsg('Check your email to confirm your account, then come back to finish.');
  }
  async function signIn() {
    setErr(null); setBusy(true);
    const { error } = await supabase().auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) setErr(/confirm/i.test(error.message) ? 'Please confirm your email first — check your inbox.' : 'Wrong email or password.');
  }
  async function sendCode() {
    setErr(null);
    const p = normalizePhone(phone);
    if (!p) return setErr('Enter a valid 10-digit US phone number.');
    stash();
    setBusy(true);
    const { error } = await supabase().auth.signInWithOtp({ phone: p });
    setBusy(false);
    if (error) return setErr(error.message);
    setCodeSent(true);
  }
  async function verifyCode() {
    setErr(null);
    const p = normalizePhone(phone);
    if (!p) return setErr('Enter a valid 10-digit US phone number.');
    setBusy(true);
    const { error } = await supabase().auth.verifyOtp({ phone: p, token: code.trim(), type: 'sms' });
    setBusy(false);
    if (error) setErr('That code was incorrect or expired.');
  }

  const input = 'border rounded-lg px-3 py-2 w-full';
  return (
    <div>
      <h1 className="font-display font-extrabold text-2xl mb-1">Sign in or create an account</h1>
      <p className="text-sm text-smoke mb-4">21+ only. Order ahead, pick up in store.</p>

      <div className="bg-white rounded-2xl border border-black/10 shadow-tag p-4 grid gap-3">
        {msg && <div className="rounded-lg bg-green-600/10 text-green-800 text-sm p-3">{msg}</div>}
        {err && <div className="rounded-lg bg-red-600/10 text-red-700 text-sm p-3">{err}</div>}

        {/* Social */}
        <button onClick={() => oauth('apple')} className="flex items-center justify-center gap-2 rounded-lg bg-black text-white py-2.5 font-semibold">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M16.365 1.43c0 1.14-.42 2.2-1.12 3-.76.88-2 .93-2.56.9-.05-1.06.44-2.16 1.1-2.87.74-.8 2-.9 2.58-1.03zM20.5 17.2c-.36.83-.53 1.2-1 1.94-.66 1.03-1.6 2.3-2.76 2.31-1.03.01-1.3-.67-2.7-.66-1.4.01-1.7.67-2.73.65-1.16-.02-2.05-1.17-2.71-2.2-1.85-2.9-2.05-6.3-.9-8.1.8-1.28 2.07-2.03 3.26-2.03 1.2 0 1.96.67 2.96.67.97 0 1.56-.67 2.96-.67 1.05 0 2.17.57 2.96 1.56-2.6 1.42-2.18 5.13.41 6.53z"/></svg>
          Continue with Apple
        </button>
        <button onClick={() => oauth('google')} className="flex items-center justify-center gap-2 rounded-lg border border-black/15 py-2.5 font-semibold">
          <svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.76h3.56c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.56-2.76c-.98.66-2.24 1.06-3.72 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.2 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84C6.71 7.3 9.14 5.38 12 5.38z"/></svg>
          Continue with Google
        </button>

        <div className="flex items-center gap-3 text-xs text-smoke my-1"><span className="flex-1 h-px bg-black/10" />or<span className="flex-1 h-px bg-black/10" /></div>

        {/* Tabs */}
        <div className="flex gap-2 text-sm font-semibold">
          <button onClick={() => setTab('email')} className={`flex-1 rounded-lg py-1.5 ${tab === 'email' ? 'bg-ink text-white' : 'border border-black/10'}`}>Email</button>
          <button onClick={() => setTab('phone')} className={`flex-1 rounded-lg py-1.5 ${tab === 'phone' ? 'bg-ink text-white' : 'border border-black/10'}`}>Phone</button>
        </div>

        {tab === 'email' && mode === 'signup' && (
          <div className="grid gap-2.5">
            <div className="grid grid-cols-2 gap-2.5">
              <input className={input} placeholder="First name" value={first} onChange={(e) => setFirst(e.target.value)} />
              <input className={input} placeholder="Last name" value={last} onChange={(e) => setLast(e.target.value)} />
            </div>
            <input className={input} type="tel" placeholder="Phone number" value={phone} onChange={(e) => setPhone(e.target.value)} />
            <input className={input} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className={input} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <label className="text-xs text-smoke">Date of birth (must be 21+)
              <input className={input + ' mt-1'} type="date" value={dob} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setDob(e.target.value)} />
            </label>
            <button disabled={busy} onClick={signUp} className="rounded-lg bg-accent text-white py-2.5 font-semibold disabled:opacity-40">Create account</button>
            <button onClick={() => { setMode('signin'); setErr(null); }} className="text-sm text-smoke">Already have an account? Sign in</button>
          </div>
        )}
        {tab === 'email' && mode === 'signin' && (
          <div className="grid gap-2.5">
            <input className={input} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            <input className={input} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button disabled={busy} onClick={signIn} className="rounded-lg bg-accent text-white py-2.5 font-semibold disabled:opacity-40">Sign in</button>
            <button onClick={() => { setMode('signup'); setErr(null); }} className="text-sm text-smoke">New here? Create an account</button>
          </div>
        )}
        {tab === 'phone' && (
          <div className="grid gap-2.5">
            {!codeSent ? (
              <>
                <input className={input} type="tel" inputMode="tel" placeholder="Phone number, e.g. (555) 000-1234" value={phone} onChange={(e) => setPhone(e.target.value)} />
                <p className="text-xs text-smoke -mt-1">US numbers only. 10 digits, no country code needed.</p>
                <button disabled={busy} onClick={sendCode} className="rounded-lg bg-accent text-white py-2.5 font-semibold disabled:opacity-40">Text me a code</button>
                <p className="text-xs text-smoke">New here? You&apos;ll add your name &amp; date of birth after verifying.</p>
              </>
            ) : (
              <>
                <input className={input} inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
                <button disabled={busy} onClick={verifyCode} className="rounded-lg bg-accent text-white py-2.5 font-semibold disabled:opacity-40">Verify &amp; continue</button>
                <button onClick={() => setCodeSent(false)} className="text-sm text-smoke">Use a different number</button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
