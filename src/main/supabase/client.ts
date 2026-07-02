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
    // Attach a per-install JWT (tenant_id + license_key claims) on every request
    // via the accessToken hook. tokenManager serves a valid token (refreshing as
    // needed); if none is available we fall back to the anon key so RLS blocks
    // tenant data naturally rather than erroring. Lazy require breaks the
    // client -> tokenManager -> licenseCheck -> client import cycle.
    client = createClient(url as string, key as string, {
      accessToken: async () => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-var-requires
          const { getValidToken } = require('./tokenManager') as typeof import('./tokenManager');
          return await getValidToken();
        } catch {
          return key as string; // anon -> RLS blocks tenant-scoped rows
        }
      },
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
    // Server reachable but the table just isn't there yet (migrations not run):
    //  - Postgres 42P01 = undefined_table
    //  - PostgREST PGRST205 = "Could not find the table ... in the schema cache"
    if (
      error.code === '42P01' ||
      error.code === 'PGRST205' ||
      /does not exist|could not find the table/i.test(error.message)
    ) {
      return true;
    }
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
