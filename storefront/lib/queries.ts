'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export interface MenuItem { barcode: string; name: string; category: string | null; price: number; available: number; stock_status: 'in' | 'low' | 'out'; image_url: string | null }
export interface StoreInfo { name: string; tenant_id: string }

/**
 * Store name + live menu for a location. Polls every 25s via refetchInterval
 * — same cadence the old manual setInterval used — since stock can change
 * from someone else's purchase at any time and this page has no other signal
 * to know that happened. staleTime is set on the QueryClient (20s); the real
 * no-oversell check happens server-side at checkout regardless of what this
 * shows.
 */
export function useStoreMenu(locationId: string) {
  return useQuery({
    queryKey: ['store-menu', locationId],
    queryFn: async () => {
      const [{ data: loc }, { data: items }] = await Promise.all([
        supabase().from('locations').select('name, tenant_id').eq('id', locationId).maybeSingle(),
        supabase().rpc('storefront_menu', { p_location: locationId }),
      ]);
      return { store: loc as StoreInfo | null, menu: (items as MenuItem[]) || [] };
    },
    enabled: !!locationId,
    refetchInterval: 25_000,
  });
}

/** Force a fresh read right away — call after an action that changes stock
 * for THIS client (there currently isn't one on the storefront itself; kept
 * for the checkout flow / future mutations that should invalidate this). */
export function useInvalidateStoreMenu() {
  const qc = useQueryClient();
  return (locationId: string) => qc.invalidateQueries({ queryKey: ['store-menu', locationId] });
}

export interface OnlineOrder {
  id: string; order_number: string; status: string; total: number; created_at: string; ready_at: string | null;
  online_order_items: { name: string; qty: number }[];
}

export function useOrders(signedIn: boolean | null) {
  return useQuery({
    queryKey: ['orders'],
    queryFn: async () => {
      const { data } = await supabase()
        .from('online_orders')
        .select('id, order_number, status, total, created_at, ready_at, online_order_items(name, qty)')
        .order('created_at', { ascending: false }).limit(50);
      return (data || []) as OnlineOrder[];
    },
    enabled: signedIn === true,
    // A just-placed order should show up the moment the customer lands here
    // from checkout (?ok=1) — no stale cached "no orders yet" from before
    // they signed in this session.
    staleTime: 10_000,
  });
}

export function useInvalidateOrders() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['orders'] });
}
