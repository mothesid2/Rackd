'use client';
// Public pricing/config read with the anon key. RLS only returns rows where is_public / is_active.

import { useEffect, useState } from 'react';
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_ANON_KEY, SUPABASE_URL } from '../config';

export interface PlanCfg { name: string; monthly_cents: number; setup_cents: number; features: string[] }
export interface AddonCfg { name: string; monthly_cents: number; feature: string | null }
export interface PublicConfig {
  plans: { is_placeholder?: boolean; model_a: PlanCfg; model_b: PlanCfg };
  addons: Record<string, AddonCfg> & { is_placeholder?: never };
  addonsPlaceholder: boolean;
  onlineFee: { is_placeholder?: boolean; type: 'percent' | 'flat'; value: number; paid_by: string };
}

export interface BundleCfg {
  slug: string;
  name: string;
  description: string | null;
  model_fit: 'model_a' | 'model_b' | 'any';
  discount_cents: number;
  is_placeholder: boolean;
  total_cents: number;
  items: { name: string; quantity: number; price_cents: number; is_optional: boolean }[];
}

let sb: ReturnType<typeof createClient> | null = null;
const client = () => (sb ??= createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false, autoRefreshToken: false } }));

export const money = (cents: number) =>
  (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: cents % 100 ? 2 : 0 });

export function describeFee(f: PublicConfig['onlineFee']): string {
  return f.type === 'percent' ? `${f.value}% of the order` : `${money(f.value)} per order`;
}

type State<T> = { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: T };

export function usePublicConfig(): State<PublicConfig> {
  const [s, setS] = useState<State<PublicConfig>>({ status: 'loading' });
  useEffect(() => {
    let off = false;
    (async () => {
      const { data, error } = await client().from('app_config').select('key,value').in('key', ['plans', 'addons', 'online_fee']);
      if (off) return;
      if (error || !data) return setS({ status: 'error' });
      const m = Object.fromEntries((data as { key: string; value: unknown }[]).map((r) => [r.key, r.value])) as Record<string, any>;
      if (!m.plans || !m.addons || !m.online_fee) return setS({ status: 'error' });
      const { is_placeholder, ...addons } = m.addons;
      setS({ status: 'ready', data: { plans: m.plans, addons, addonsPlaceholder: !!is_placeholder, onlineFee: m.online_fee } });
    })();
    return () => { off = true; };
  }, []);
  return s;
}

export function useBundles(): State<BundleCfg[]> {
  const [s, setS] = useState<State<BundleCfg[]>>({ status: 'loading' });
  useEffect(() => {
    let off = false;
    (async () => {
      const { data, error } = await client()
        .from('hardware_bundles')
        .select('slug,name,description,model_fit,discount_cents,is_placeholder,sort_order,hardware_bundle_items(quantity,is_optional,hardware_products(name,price_cents))')
        .order('sort_order');
      if (off) return;
      if (error || !data) return setS({ status: 'error' });
      const bundles: BundleCfg[] = (data as any[]).map((b) => {
        const items = (b.hardware_bundle_items ?? []).map((i: any) => ({
          name: i.hardware_products?.name ?? 'Item',
          quantity: i.quantity,
          price_cents: i.hardware_products?.price_cents ?? 0,
          is_optional: !!i.is_optional,
        }));
        const total = items.filter((i: any) => !i.is_optional).reduce((t: number, i: any) => t + i.price_cents * i.quantity, 0) - b.discount_cents;
        return { slug: b.slug, name: b.name, description: b.description, model_fit: b.model_fit, discount_cents: b.discount_cents, is_placeholder: b.is_placeholder, items, total_cents: Math.max(0, total) };
      });
      setS({ status: 'ready', data: bundles });
    })();
    return () => { off = true; };
  }, []);
  return s;
}
