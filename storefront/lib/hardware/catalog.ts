'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config';
import { BUNDLE_SELECT, buildCatalog, PRODUCT_SELECT, type Catalog } from './pricing';

export type CatalogState = { status: 'loading' } | { status: 'error' } | { status: 'ready'; catalog: Catalog };

/** Public catalog read with the anon key; RLS only returns active rows and public config. */
export function useCatalog(): CatalogState {
  const [s, setS] = useState<CatalogState>({ status: 'loading' });
  useEffect(() => {
    let off = false;
    const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
    (async () => {
      const [p, b, c] = await Promise.all([
        sb.from('hardware_products').select(PRODUCT_SELECT).order('sort_order'),
        sb.from('hardware_bundles').select(BUNDLE_SELECT).order('sort_order'),
        sb.from('app_config').select('key,value').in('key', ['hardware_tax', 'hardware_shipping']),
      ]);
      if (off) return;
      if (p.error || b.error || c.error || !p.data || !b.data || !c.data) return setS({ status: 'error' });
      setS({ status: 'ready', catalog: buildCatalog(p.data as any[], b.data as any[], c.data as any[]) });
    })().catch(() => { if (!off) setS({ status: 'error' }); });
    return () => { off = true; };
  }, []);
  return s;
}

export const slugOf = (sku: string) => sku.toLowerCase();
export const skuOf = (slug: string) => slug.toUpperCase();
