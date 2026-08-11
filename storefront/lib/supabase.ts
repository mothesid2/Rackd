'use client';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

let client: SupabaseClient | null = null;

/**
 * Browser Supabase client (Supabase Auth for customers). Singleton.
 *
 * SECURITY NOTE (audit batch 8, item 3): persistSession:true with no custom
 * `storage` uses supabase-js's default — window.localStorage — so the
 * customer's access/refresh tokens are readable by any script that runs on
 * this origin (i.e. an XSS payload could steal a session). A true httpOnly
 * cookie isn't available here without changing the deploy model: this app is
 * `output: 'export'` (next.config.mjs) — a static site on Cloudflare Pages
 * with no Next.js server/API route of ours that could set a server-side
 * cookie. Supabase's own SSR cookie helpers assume exactly the server this
 * app deliberately doesn't have; adopting them would mean giving up the
 * static-export deploy model, which is a bigger architectural change than
 * this security pass should make unilaterally.
 * Given that constraint, the practical mitigation is preventing the XSS that
 * would read the token in the first place, not moving it to another
 * JS-readable spot (sessionStorage is exactly as readable) — see
 * public/_headers for the CSP this project now ships (restricts script/
 * frame/connect sources; script-src still needs 'unsafe-inline' because
 * Next's static export itself emits inline hydration <script> tags with no
 * server available to nonce them).
 */
export function supabase(): SupabaseClient {
  if (!client) {
    client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        // OAuth (Apple/Google) returns to /account/ with a `?code=` — parse and
        // exchange it automatically. PKCE keeps the code in a query param, which
        // survives the trailingSlash 308 redirect (a hash fragment can be lost).
        detectSessionInUrl: true,
        flowType: 'pkce',
      },
    });
  }
  return client;
}

/** Call a storefront edge function with the current customer session token. */
export async function callFn<T = unknown>(name: string, body: unknown): Promise<T> {
  const { data: { session } } = await supabase().auth.getSession();
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}/functions/v1/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${session?.access_token || SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { data: json });
  return json as T;
}
