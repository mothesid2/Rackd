import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { loadEnv } from './env';
import { PUBLIC_SUPABASE_URL, PUBLIC_SUPABASE_ANON_KEY } from './publicConfig';


let client: SupabaseClient | null | undefined;


const PLACEHOLDER = /^\s*$|your-.*-here/i;

function readConfig(): { url?: string; key?: string } {
  loadEnv();
  
  
  
  
  
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY || PUBLIC_SUPABASE_ANON_KEY;
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
    
    
    
    
    
    client = createClient(url as string, key as string, {
      accessToken: async () => {
        try {
          
          const { getValidToken } = require('./tokenManager') as typeof import('./tokenManager');
          return await getValidToken();
        } catch {
          return key as string; 
        }
      },
    });
  } catch (err) {
    console.error('[supabase] failed to create client:', String(err));
    client = null;
  }
  return client;
}


export async function checkConnection(): Promise<boolean> {
  const supabase = getSupabase();
  if (!supabase) return false;
  try {
    const { error } = await supabase.from('licenses').select('id').limit(1);
    if (!error) return true;
    
    
    
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


export function resetSupabase(): void {
  client = undefined;
}
