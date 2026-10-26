import { createClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { createSupabaseApi } from '@sfm/api';
import { StorefrontManager } from '@sfm/StorefrontManager';
import type { LocationRef } from '@sfm/types';
import { btnGhost, btnPrimary, Field, input, ListSkeleton, Notice } from '@sfm/ui';

interface Config { supabaseUrl: string; anonKey: string; kickUrl?: string }
const cfg = (window as unknown as { MANAGE_CONFIG?: Config }).MANAGE_CONFIG;

const IDLE_MS = 5 * 60 * 1000;
const KEY_STORE = 'rackd.manage.business_key';
const SESSION = 'rackd.manage.session';

interface Session { token: string; expires_at: string; tenantId: string; name: string; username: string; businessKey: string }

const read = (k: string, s: Storage) => { try { return s.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null, s: Storage) => { try { if (v == null) s.removeItem(k); else s.setItem(k, v); } catch { /* storage blocked */ } };

function tenantOf(token: string): string {
  try { return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).tenant_id as string; } catch { return ''; }
}

async function login(businessKey: string, username: string, password: string): Promise<Session> {
  if (!cfg) throw new Error('Site is not configured.');
  let r: Response;
  try {
    r = await fetch(`${cfg.supabaseUrl}/functions/v1/staff-login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', apikey: cfg.anonKey, Authorization: `Bearer ${cfg.anonKey}` },
      body: JSON.stringify({ license_key: businessKey, username, password }),
    });
  } catch { throw new Error('Could not reach the server. Check your connection.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof j.error === 'string' ? j.error : 'Sign-in failed.');
  return { token: j.token, expires_at: j.expires_at, tenantId: tenantOf(j.token), name: j.name, username, businessKey };
}

function LoginForm({ onSession, lockedFor }: { onSession: (s: Session) => void; lockedFor?: Session }) {
  const [key, setKey] = useState(lockedFor?.businessKey ?? read(KEY_STORE, localStorage) ?? '');
  const [user, setUser] = useState(lockedFor?.username ?? '');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try {
      const s = await login(key.trim(), user.trim(), pw);
      if (lockedFor && s.tenantId !== lockedFor.tenantId) throw new Error('Sign in as the same account to unlock.');
      write(KEY_STORE, key.trim(), localStorage);
      onSession(s);
    } catch (x) { setErr(x instanceof Error ? x.message : 'Sign-in failed.'); setPw(''); } finally { setBusy(false); }
  }
  return (
    <main className="min-h-[80vh] grid place-items-center">
      <form onSubmit={submit} className="w-[min(26rem,100%)] grid gap-4 bg-paper border border-line rounded-2xl p-6" aria-labelledby="login-h">
        <h1 id="login-h" className="font-display font-bold text-2xl">{lockedFor ? 'Locked for inactivity' : 'Online Storefront'}</h1>
        {lockedFor && <p className="text-sm text-smoke">Enter your password to continue as {lockedFor.name}.</p>}
        {!lockedFor && <Field label="Business key">{(id) => <input id={id} className={input} value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" required />}</Field>}
        {!lockedFor && <Field label="Email or username">{(id) => <input id={id} className={input} value={user} onChange={(e) => setUser(e.target.value)} autoComplete="username" required />}</Field>}
        <Field label="Password">{(id) => <input id={id} className={input} type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" required autoFocus={!!lockedFor} />}</Field>
        {err && <Notice tone="error">{err}</Notice>}
        <button className={btnPrimary} disabled={busy}>{busy ? 'Signing in…' : lockedFor ? 'Unlock' : 'Sign in'}</button>
        {lockedFor && <button type="button" className={btnGhost} onClick={() => { write(SESSION, null, sessionStorage); location.reload(); }}>Sign out</button>}
      </form>
    </main>
  );
}

function App() {
  const [session, setSession] = useState<Session | null>(() => {
    const raw = read(SESSION, sessionStorage);
    if (!raw) return null;
    try { const s = JSON.parse(raw) as Session; return Date.parse(s.expires_at) > Date.now() ? s : null; } catch { return null; }
  });
  const [locked, setLocked] = useState(false);
  const [locations, setLocations] = useState<LocationRef[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef<string | null>(session?.token ?? null);
  tokenRef.current = session?.token ?? null;

  // The api closes over tenantId, so it is built once a session exists.
  const sessionApi = useCallback(() => {
    if (!cfg || !session) return null;
    const sb = createClient(cfg.supabaseUrl, cfg.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      accessToken: async () => tokenRef.current,
    });
    return { sb, api: createSupabaseApi(sb, { kickUrl: cfg.kickUrl, tenantId: session.tenantId }) };
  }, [session?.tenantId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [bundle, setBundle] = useState<ReturnType<typeof sessionApi>>(null);
  useEffect(() => { setBundle(sessionApi()); }, [sessionApi]);

  const onSession = (s: Session) => { write(SESSION, JSON.stringify(s), sessionStorage); setSession(s); setLocked(false); };

  useEffect(() => {
    if (!bundle) return;
    void (async () => {
      const { data, error: e } = await bundle.sb.from('locations').select('id, name').order('name');
      if (e) setError('Could not load your locations.'); else setLocations((data ?? []) as LocationRef[]);
    })();
  }, [bundle]);

  // Idle lock: after 5 minutes without input the screen is covered until the password is re-entered.
  useEffect(() => {
    if (!session) return;
    let t = window.setTimeout(() => setLocked(true), IDLE_MS);
    const reset = () => { clearTimeout(t); t = window.setTimeout(() => setLocked(true), IDLE_MS); };
    const evs = ['pointerdown', 'keydown', 'touchstart'] as const;
    evs.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    return () => { clearTimeout(t); evs.forEach((e) => window.removeEventListener(e, reset)); };
  }, [session]);

  // Session ends when the token expires.
  useEffect(() => {
    if (!session) return;
    const ms = Date.parse(session.expires_at) - Date.now();
    const t = window.setTimeout(() => { write(SESSION, null, sessionStorage); setSession(null); }, Math.max(0, ms));
    return () => clearTimeout(t);
  }, [session]);

  if (!cfg) return <Notice tone="error">This site is not configured (missing config.js).</Notice>;
  if (!session) return <LoginForm onSession={onSession} />;
  return (
    <>
      <div className="flex justify-end gap-2 mb-2 text-sm text-smoke items-center">
        <span>{session.name}</span>
        <button className={btnGhost} onClick={() => setLocked(true)}>Lock</button>
        <button className={btnGhost} onClick={() => { write(SESSION, null, sessionStorage); setSession(null); setLocations(null); }}>Sign out</button>
      </div>
      {error ? <Notice tone="error">{error}</Notice> : !locations || !bundle ? <ListSkeleton rows={3} /> : (
        <StorefrontManager api={bundle.api} mode="location" locations={locations} />
      )}
      {locked && <div className="fixed inset-0 z-[10000] bg-char"><LoginForm lockedFor={session} onSession={onSession} /></div>}
    </>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
