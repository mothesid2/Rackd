'use client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';

export interface MenuItem { barcode: string; name: string; category: string | null; price: number; available: number; stock_status: 'in' | 'low' | 'out'; image_url: string | null }
export interface StoreInfo { name: string; tenant_id: string }


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
    
    
    
    staleTime: 10_000,
  });
}

export function useInvalidateOrders() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['orders'] });
}
