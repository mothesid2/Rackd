'use client';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config';

let client: SupabaseClient | null = null;

/** Browser Supabase client (Supabase Auth for customers). Singleton. */
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
