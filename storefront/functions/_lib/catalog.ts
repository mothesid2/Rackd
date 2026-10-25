// Server-side catalog loader: authoritative prices and stock come from the database, never the client.

import { BUNDLE_SELECT, buildCatalog, PRODUCT_SELECT, type Catalog } from '../../lib/hardware/pricing';
import type { Env } from './env';
import { restSelect, type FetchLike } from './supabase';

export async function loadCatalog(env: Partial<Env>, fetchImpl?: FetchLike): Promise<Catalog> {
  const [products, bundles, config] = await Promise.all([
    restSelect<any[]>(env, 'hardware_products', `select=${PRODUCT_SELECT}&is_active=eq.true`, fetchImpl),
    restSelect<any[]>(env, 'hardware_bundles', `select=${encodeURIComponent(BUNDLE_SELECT)}&is_active=eq.true`, fetchImpl),
    restSelect<any[]>(env, 'app_config', 'select=key,value&key=in.(hardware_tax,hardware_shipping)', fetchImpl),
  ]);
  return buildCatalog(products, bundles, config);
}
