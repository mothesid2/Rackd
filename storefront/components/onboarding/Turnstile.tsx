'use client';
import { useEffect, useRef } from 'react';
import { TURNSTILE_SITE_KEY } from '@/lib/config';

interface TurnstileApi {
  render: (el: HTMLElement, opts: Record<string, unknown>) => string;
  reset: (id?: string) => void;
  remove: (id?: string) => void;
}
declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

const SRC = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<void> | null = null;
function loadScript(): Promise<void> {
  if (window.turnstile) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { loading = null; reject(new Error('turnstile_load_failed')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

/** Bot check. Calls onToken('') when the token expires or errors so the form disables its submit. */
export function Turnstile({ action, onToken, resetKey = 0 }: { action: string; onToken: (t: string) => void; resetKey?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<string | undefined>(undefined);
  const cb = useRef(onToken);
  cb.current = onToken;

  useEffect(() => {
    if (!TURNSTILE_SITE_KEY || !box.current) return;
    let cancelled = false;
    loadScript().then(() => {
      if (cancelled || !box.current || !window.turnstile) return;
      widget.current = window.turnstile.render(box.current, {
        sitekey: TURNSTILE_SITE_KEY,
        action,
        theme: 'dark',
        callback: (t: string) => cb.current(t),
        'expired-callback': () => cb.current(''),
        'error-callback': () => cb.current(''),
      });
    }).catch(() => cb.current(''));
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
      widget.current = undefined;
    };
  }, [action]);

  useEffect(() => {
    if (resetKey > 0 && widget.current && window.turnstile) {
      cb.current('');
      window.turnstile.reset(widget.current);
    }
  }, [resetKey]);

  if (!TURNSTILE_SITE_KEY) {
    return <p role="alert" className="text-sm text-red-400">Bot check is not configured (NEXT_PUBLIC_TURNSTILE_SITE_KEY).</p>;
  }
  return <div ref={box} role="group" aria-label="Bot check" className="min-h-[65px]" />;
}
