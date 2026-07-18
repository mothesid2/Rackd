'use client';
import { useEffect, useState, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';

/** Split a full name into first / rest. "" first name means we captured nothing. */
function splitName(full: string): { first: string; last: string } {
  const parts = full.trim().replace(/\s+/g, ' ').split(' ');
  const first = parts.shift() ?? '';
  return { first, last: parts.join(' ') };
}

export default function Account() {
  const [session, setSession] = useState<Session | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [profile, setProfile] = useState<any>(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [dob, setDob] = useState('');
  const [ageErr, setAgeErr] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  // "Welcome back, {first name}" — shown only on a SUBSEQUENT login, never the
  // account-creation session (the visit that first captured the name).
  const [welcomeBack, setWelcomeBack] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data: { session } } = await supabase().auth.getSession();
    setSession(session);
    if (session) {
      await supabase().from('storefront_customers').upsert({ id: session.user.id, email: session.user.email }, { onConflict: 'id', ignoreDuplicates: true });
      const { data } = await supabase().from('storefront_customers').select('*').eq('id', session.user.id).maybeSingle();

      // Returning customer = the profile already carried a name BEFORE this load.
      const returning = !!data?.first_name;
      if (returning) {
        // Suppress the greeting during the creation session itself (a reload right
        // after the name was first saved), but greet on every later sign-in.
        const createdThisSession = typeof window !== 'undefined' && sessionStorage.getItem('rackd_created') === '1';
        if (!createdThisSession) setWelcomeBack(data.first_name as string);
      } else {
        // Creation session: capture the name from the sign-in form (localStorage)
        // or the auth user_metadata, then persist it to the profile.
        const pending =
          (typeof window !== 'undefined' && localStorage.getItem('rackd_pending_name')) ||
          (session.user.user_metadata?.full_name as string | undefined) || '';
        const { first, last } = splitName(pending);
        if (first) {
          await supabase().from('storefront_customers').update({ first_name: first, last_name: last || null }).eq('id', session.user.id);
          if (data) { data.first_name = first; data.last_name = last || null; }
          if (typeof window !== 'undefined') {
            localStorage.removeItem('rackd_pending_name');
            sessionStorage.setItem('rackd_created', '1'); // don't greet for the rest of this session
          }
        }
      }

      setProfile(data);
      if (data?.phone) setPhone(data.phone);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
    const { data: sub } = supabase().auth.onAuthStateChange(() => refresh());
    return () => sub.subscription.unsubscribe();
  }, [refresh]);

  async function sendLink() {
    if (!email) return;
    // Stash the captured name so we can persist it once the magic link is clicked
    // (which may open a fresh browser context); also pass it into auth metadata.
    const trimmed = name.trim();
    if (trimmed && typeof window !== 'undefined') localStorage.setItem('rackd_pending_name', trimmed);
    await supabase().auth.signInWithOtp({
      email,
      options: { emailRedirectTo: window.location.origin + '/account', data: trimmed ? { full_name: trimmed } : undefined },
    });
    setSent(true);
  }
  async function savePhone() {
    if (!session) return;
    setBusy(true);
    await supabase().from('storefront_customers').update({ phone }).eq('id', session.user.id);
    setBusy(false); refresh();
  }
  async function attestAge() {
    setAgeErr(null);
    if (!dob) { setAgeErr('Enter your date of birth.'); return; }
    setBusy(true);
    const { error } = await supabase().rpc('self_attest_age', { p_dob: dob });
    setBusy(false);
    if (error) {
      const m = error.message || '';
      if (/under_21/.test(m)) setAgeErr('You must be 21 or older to use this store.');
      else if (/dob_invalid/.test(m)) setAgeErr('That date of birth isn’t valid.');
      else setAgeErr(m);
      return;
    }
    refresh();
  }

  if (loading) return <p className="text-neutral-400">Loading…</p>;

  if (!session) return (
    <div>
      <h1 className="text-2xl font-extrabold mb-1">Sign in</h1>
      <p className="text-sm text-neutral-500 mb-4">We&apos;ll email you a secure sign-in link. Must be 21+.</p>
      {sent ? (
        <div className="bg-white rounded-xl border p-4">Check your email for a sign-in link.</div>
      ) : (
        <div className="bg-white rounded-xl border p-4 grid gap-3">
          <input className="border rounded-lg px-3 py-2" type="text" autoComplete="name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} />
          <input className="border rounded-lg px-3 py-2" type="email" placeholder="you@email.com" value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="rounded-lg bg-ink text-white py-2.5 font-semibold disabled:opacity-40" disabled={!email} onClick={sendLink}>Email me a link</button>
          <p className="text-xs text-neutral-400">New here? Add your name so we can set up your account. Returning? Just your email is fine.</p>
        </div>
      )}
    </div>
  );

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
        <div className="text-sm text-neutral-500">Signed in as</div>
        <div className="font-semibold">{session.user.email}</div>
      </div>

      <div className="bg-white rounded-xl border p-4">
        <div className="font-semibold mb-2">Age verification (21+)</div>
        {verified ? (
          <div className="text-green-700">✓ Verified{profile.age_verified_at ? ` on ${new Date(profile.age_verified_at).toLocaleDateString()}` : ''}</div>
        ) : (
          <>
            <p className="text-sm text-neutral-500 mb-3">Required before checkout. Enter your date of birth to confirm you are 21 or older. <strong>Bring a valid government photo ID to pick up your order</strong> — staff verify it in person.</p>
            <div className="flex gap-2 items-center">
              <input className="border rounded-lg px-3 py-2" type="date" value={dob} onChange={(e) => setDob(e.target.value)} max={new Date().toISOString().slice(0, 10)} />
              <button className="rounded-lg bg-accent text-white px-4 py-2.5 font-semibold disabled:opacity-40" disabled={busy} onClick={attestAge}>Confirm I&apos;m 21+</button>
            </div>
            {ageErr && <div className="text-red-600 text-sm mt-2">{ageErr}</div>}
          </>
        )}
      </div>

      <div className="bg-white rounded-xl border p-4">
        <div className="font-semibold mb-2">Mobile (for pickup texts)</div>
        <div className="flex gap-2">
          <input className="border rounded-lg px-3 py-2 flex-1" placeholder="(555) 000-0000" value={phone} onChange={(e) => setPhone(e.target.value)} />
          <button className="rounded-lg border px-4" onClick={savePhone} disabled={busy}>Save</button>
        </div>
      </div>

      <button className="text-sm text-neutral-500 text-left" onClick={async () => { await supabase().auth.signOut(); refresh(); }}>Sign out</button>
    </div>
  );
}
