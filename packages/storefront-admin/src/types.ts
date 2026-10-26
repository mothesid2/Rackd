export type ItemStatus = 'available' | 'sold_out' | 'hidden';
export type InventoryMode = 'pos_sync' | 'curated';
export type ReservationStatus = 'new' | 'confirmed' | 'ready' | 'picked_up' | 'no_show' | 'cancelled';
export type PaymentStatus = 'unpaid' | 'paid_at_register' | 'prepaid' | 'refunded';

export interface Permissions {
  owner: boolean; admin: boolean; view: boolean; items_edit: boolean; orders_manage: boolean;
  settings_edit: boolean; reports_view: boolean; fees_view: boolean; manage_staff: boolean;
}

export interface LocationRef { id: string; name: string }

export interface StorefrontItem {
  id: string; source: 'pos' | 'curated'; pos_product_id: string | null;
  name: string | null; brand: string | null; flavor: string | null; size: string | null;
  price: number | null; image_url: string | null; category: string | null;
  status: ItemStatus; qty: number | null; available: number | null; sort_order: number;
  read_only: boolean; pos_missing: boolean; updated_at: string;
}

export interface ItemInput {
  name: string; brand?: string | null; flavor?: string | null; size?: string | null;
  price: number; qty?: number | null; category?: string | null; image_url?: string | null; status?: ItemStatus;
}

export interface PosProduct { barcode: string; name: string; category: string | null; price: number; quantity: number; already_added: boolean }

export interface Settings {
  location_id: string; enabled: boolean; paused: boolean; pause_reason: string | null; inventory_mode: InventoryMode;
  pickup_hours: Record<string, { open?: string; close?: string; closed?: boolean }> | null; pickup_instructions: string | null;
  hold_minutes: number | null; order_cutoff_minutes: number | null; max_items_per_order: number | null; max_qty_per_item: number | null;
  payment_mode: 'pay_at_pickup' | 'prepay_card'; require_id_at_pickup: boolean; auto_cancel_no_show: boolean;
  notify_inapp: boolean; notify_email: boolean; notify_sms: boolean;
}

export interface BusinessDefaults {
  tenant_id: string; storefront_enabled: boolean; hold_minutes: number; order_cutoff_minutes: number; max_items_per_order: number; max_qty_per_item: number;
  fee_type: 'percent' | 'flat' | null; fee_value: number | null; fee_waived: boolean; first_order_fee_waiver: boolean; allowed_payment_modes: string[];
}

export interface ReservationLine { id: string; name: string; category: string | null; unit_price: number; qty: number; line_total: number; is_removed: boolean; item_id: string | null }

export interface Reservation {
  id: string; code: string; location_id: string; customer_name: string | null; status: ReservationStatus;
  subtotal: number; fee_amount: number; fee_type: 'percent' | 'flat' | null; fee_value: number | null; fee_waived: boolean; total: number;
  payment_mode: 'pay_at_pickup' | 'prepay_card'; payment_status: PaymentStatus; notes: string | null; cancel_reason: string | null;
  id_checked_at_pickup: boolean; created_at: string; confirmed_at: string | null; ready_at: string | null; picked_up_at: string | null; hold_expires_at: string;
  sale_id: string | null; reservation_items: ReservationLine[];
}

export interface Dashboard {
  enabled: boolean; paused: boolean; pause_reason: string | null; today: number; pending: number; sold_out: number;
  orders_7d: number; sales_7d: number; fees_7d: number; no_show_rate_30d: number;
}

export interface Report {
  orders: number; by_status: Record<string, number>; online_sales: number; fees_accrued: number; no_show_rate: number;
  top_items: { name: string; qty: number; revenue: number }[]; hourly: { dow: number; hour: number; orders: number }[];
  by_location: { location_id: string; orders: number; online_sales: number }[];
}

export interface LedgerRow { id: string; location_id: string; reservation_id: string; amount: number; status: 'accrued' | 'invoiced' | 'paid' | 'waived' | 'void'; period: string; statement_id: string | null; created_at: string }
export interface Statement { id: string; period: string; total: number; reservation_count: number; status: 'draft' | 'issued' | 'paid' | 'void'; pdf_url: string | null; csv_url: string | null; issued_at: string | null; paid_at: string | null }

export interface StaffMember { uid: string; name: string; username: string | null; role: string; active: boolean; locked: boolean; permissions: Record<string, boolean> }

export const PERMISSION_KEYS = [
  ['storefront.view', 'View the storefront'],
  ['storefront.items.edit', 'Edit items'],
  ['storefront.orders.manage', 'Manage orders'],
  ['storefront.settings.edit', 'Edit settings'],
  ['storefront.reports.view', 'View reports'],
  ['storefront.fees.view', 'View fees and statements'],
] as const;
