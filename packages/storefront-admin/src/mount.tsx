// Entry for the IIFE bundle used by hosts that cannot import React modules directly (Electron apps, the static manage site).
//   window.RackdStorefront.mount(el, { supabaseUrl, anonKey, token, tenantId, mode, locations, kickUrl })
import { createClient } from '@supabase/supabase-js';
import { createRoot, type Root } from 'react-dom/client';
import { createSupabaseApi, type StorefrontApi } from './api';
import { StorefrontManager } from './StorefrontManager';
import type { LocationRef } from './types';

export interface MountOptions {
  mode: 'location' | 'business';
  locations: LocationRef[];
  initialLocation?: string;
  /** Provide either a ready-made api (tests, custom hosts) or Supabase connection details. */
  api?: StorefrontApi;
  supabaseUrl?: string;
  anonKey?: string;
  /** Rackd session JWT (kind manager / register / owner). Kept in memory only. */
  token?: string;
  /** Lets the host refresh an expiring token; called by supabase-js before each request. */
  getToken?: () => string | null | Promise<string | null>;
  tenantId?: string;
  kickUrl?: string;
  onToast?: (text: string, tone: 'ok' | 'error') => void;
}

export interface MountHandle { unmount(): void }

export function mount(el: HTMLElement, o: MountOptions): MountHandle {
  let api = o.api;
  if (!api) {
    if (!o.supabaseUrl || !o.anonKey) throw new Error('mount: supabaseUrl and anonKey are required');
    const sb = createClient(o.supabaseUrl, o.anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      accessToken: async () => (o.getToken ? await o.getToken() : o.token ?? null),
    });
    api = createSupabaseApi(sb, { kickUrl: o.kickUrl, tenantId: o.tenantId });
  }
  const root: Root = createRoot(el);
  root.render(<StorefrontManager api={api} mode={o.mode} locations={o.locations} initialLocation={o.initialLocation} onToast={o.onToast} />);
  return { unmount: () => root.unmount() };
}

export { StorefrontManager, createSupabaseApi };
export * from './payments';
export type { StorefrontApi } from './api';
