import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from './env';

/**
 * Supabase client — main process ONLY. Never exposed to the renderer (the
 * renderer reaches data through db:/sync:/license: IPC channels). The app is
 * local-first: if Supabase isn't configured this returns null and the cloud
 * layer stays dormant while the POS keeps running entirely on local SQLite.
 *
 * `undefined` = not yet resolved, `null` = resolved-but-unconfigured.
 */
let client: SupabaseClient | null | undefined;

// Values still set to the .env.example template are treated as "not configured".
const PLACEHOLDER = /^\s*$|your-.*-here/i;

function readConfig(): { url?: string; key?: string } {
  loadEnv();
  // Accept both the correct main-process names and the VITE_ names from the
  // spec's .env.example, so whichever the operator sets just works. (VITE_ is
  // only meaningful to the Vite-bundled renderer; here we just read process.env.)
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  return { url, key };
}

export function isSupabaseConfigured(): boolean {
  const { url, key } = readConfig();
  return Boolean(url && key && !PLACEHOLDER.test(url) && !PLACEHOLDER.test(key));
}

export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;

  if (!isSupabaseConfigured()) {
    console.warn(
      '[supabase] not configured (URL/anon key missing or still the template ' +
        'placeholder) — cloud features disabled. Local-first POS is unaffected.'
    );
    client = null;
    return null;
  }

  const { url, key } = readConfig();
  try {
    // TODO: Replace with signed per-install JWT carrying tenant_id and license_key
    // claims before production. Today this uses the anon key with no tenant
    // context, so the tenant-scoped RLS policies in supabase/migrations/*.sql
    // will reject reads/writes until that JWT is attached here (e.g. via
    // global headers Authorization: Bearer <jwt> or supabase.auth.setSession).
    client = createClient(url as string, key as string, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  } catch (err) {
    console.error('[supabase] failed to create client:', String(err));
    client = null;
  }
  return client;
}

/**
 * Lightweight reachability probe. Returns true when Supabase answers — even if
 * the `licenses` table doesn't exist yet (that still proves the connection and
 * key are valid). Returns false when unconfigured or the network/auth fails.
 */
export async function checkConnection(): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('licenses').select('id').limit(1);
    if (!error) return true;
    // PostgREST 42P01 = undefined_table -> server reachable, table just absent.
    if (error.code === '42P01' || /does not exist/i.test(error.message)) return true;
    console.warn('[supabase] connection check returned an error:', error.message);
    return false;
  } catch (err) {
    console.warn('[supabase] connection check failed:', String(err));
    return false;
  }
}

/** Drop the memoized client so the next getSupabase() re-reads env (e.g. after .env edits). */
export function resetSupabase(): void {
  client = undefined;
}
