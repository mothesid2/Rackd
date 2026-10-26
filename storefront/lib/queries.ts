'use client';
import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/lib/supabase';
import type { FeeInfo } from '@/lib/storefront/fee';

export interface MenuItem { barcode: string; name: string; category: string | null; price: number; available: number; stock_status: 'in' | 'low' | 'out'; image_url: string | null }
export interface StoreInfo { name: string; tenant_id: string }


export interface ReserveInfo {
  enabled: boolean; paused: boolean; pause_reason: string | null; accepting: boolean;
  pickup_instructions: string | null; hold_minutes: number; max_items_per_order: number; max_qty_per_item: number;
  payment_mode: 'pay_at_pickup'; prepay_available: boolean; fee: FeeInfo;
}
interface MenuV2Row { item_id: string; name: string; category: string | null; price: number | string; image_url: string | null; status: 'available' | 'sold_out'; available: number | null }

/**
 * Menu for one shop. If the shop uses the Storefront Manager (storefront_public_info.enabled) the menu comes from
 * storefront_menu_v2 and orders are pay-at-pickup reservations; otherwise the legacy menu is used unchanged.
 * "barcode" holds the item id in reserve mode so the existing cart keeps working.
 */
export function useStoreMenu(locationId: string) {
  const qc = useQueryClient();
  // A sold-out tap (or any menu change) bumps storefront_menu_version; refetch right away instead of waiting for polling.
  useEffect(() => {
    if (!locationId) return;
    const ch = supabase().channel(`menu-${locationId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'storefront_menu_version', filter: `location_id=eq.${locationId}` },
        () => qc.invalidateQueries({ queryKey: ['store-menu', locationId] }))
      .subscribe();
    return () => { void supabase().removeChannel(ch); };
  }, [locationId, qc]);

  return useQuery({
    queryKey: ['store-menu', locationId],
    queryFn: async () => {
      const [{ data: loc }, { data: info }] = await Promise.all([
        supabase().from('locations').select('name, tenant_id').eq('id', locationId).maybeSingle(),
        supabase().rpc('storefront_public_info', { p_location: locationId }),
      ]);
      const store = loc as StoreInfo | null;
      const reserve = info as ReserveInfo | null;
      if (reserve?.enabled) {
        const { data: rows } = await supabase().rpc('storefront_menu_v2', { p_location: locationId });
        const menu: MenuItem[] = ((rows as MenuV2Row[]) || []).map((r) => ({
          barcode: r.item_id, name: r.name, category: r.category, price: Number(r.price), image_url: r.image_url,
          available: r.available ?? 999,
          stock_status: r.status === 'sold_out' ? 'out' : r.available != null && r.available <= 3 ? 'low' : 'in',
        }));
        return { store, menu, mode: 'reserve' as const, info: reserve };
      }
      const { data: items } = await supabase().rpc('storefront_menu', { p_location: locationId });
      return { store, menu: (items as MenuItem[]) || [], mode: 'legacy' as const, info: null as ReserveInfo | null };
    },
    enabled: !!locationId,
    refetchInterval: 25_000,     // safety net if the realtime connection drops
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

export interface Reservation {
  id: string; code: string; status: string; subtotal: number; fee_amount: number; fee_waived: boolean; total: number;
  payment_status: string; created_at: string; hold_expires_at: string; cancel_reason: string | null; location_id: string;
  reservation_items: { name: string; qty: number; is_removed: boolean }[];
}

export function useReservations(signedIn: boolean | null) {
  return useQuery({
    queryKey: ['reservations'],
    queryFn: async () => {
      const { data } = await supabase()
        .from('reservations')
        .select('id, code, status, subtotal, fee_amount, fee_waived, total, payment_status, created_at, hold_expires_at, cancel_reason, location_id, reservation_items(name, qty, is_removed)')
        .order('created_at', { ascending: false }).limit(30);
      return (data || []) as Reservation[];
    },
    enabled: signedIn === true,
    staleTime: 10_000,
    refetchInterval: 20_000,
  });
}

export function useInvalidateReservations() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['reservations'] });
}
