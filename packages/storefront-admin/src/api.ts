import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  BusinessDefaults, Dashboard, InventoryMode, ItemInput, ItemStatus, LedgerRow, Permissions, PosProduct, Report, Reservation,
  Settings, StaffMember, Statement, StorefrontItem,
} from './types';

/** Everything the module needs from the outside world. Hosts get a Supabase-backed one from createSupabaseApi. */
export interface StorefrontApi {
  permissions(): Promise<Permissions>;
  settings(location: string): Promise<Settings | null>;
  saveSettings(location: string, patch: Partial<Settings>): Promise<Settings>;
  setPaused(location: string, paused: boolean, reason?: string): Promise<void>;
  businessDefaults(): Promise<BusinessDefaults | null>;
  saveBusinessDefaults(patch: Partial<BusinessDefaults>): Promise<BusinessDefaults>;
  setInventoryMode(location: string, mode: InventoryMode): Promise<void>;
  ensureSettings(location: string): Promise<void>;

  items(location: string): Promise<StorefrontItem[]>;
  posProducts(location: string, search: string): Promise<PosProduct[]>;
  addPosItem(location: string, barcode: string): Promise<void>;
  createItem(location: string, input: ItemInput): Promise<StorefrontItem>;
  updateItem(id: string, patch: Partial<ItemInput> & { sort_order?: number }): Promise<void>;
  deleteItem(id: string): Promise<void>;
  setStatus(ids: string[], status: ItemStatus): Promise<number>;
  reorder(location: string, orderedIds: string[]): Promise<void>;
  duplicate(id: string): Promise<string>;
  importItems(location: string, rows: Record<string, unknown>[]): Promise<{ inserted: number; errors: { row: number; message: string }[] }>;
  uploadImage(location: string, blob: Blob): Promise<string>;

  reservations(location: string): Promise<Reservation[]>;
  subscribeReservations(location: string, onChange: (kind: 'insert' | 'update') => void): () => void;
  confirm(id: string): Promise<void>;
  markReady(id: string): Promise<void>;
  pickup(id: string, idChecked: boolean): Promise<void>;
  noShow(id: string): Promise<void>;
  cancel(id: string, reason: string): Promise<void>;
  payRegister(id: string): Promise<void>;
  itemUnavailable(id: string, line: string, replacementItem?: string, qty?: number): Promise<void>;
  kick(): Promise<void>;

  dashboard(location: string): Promise<Dashboard>;
  report(location: string | null, from: string, to: string): Promise<Report>;
  ledger(location: string | null): Promise<LedgerRow[]>;
  statements(): Promise<Statement[]>;
  markStatementPaid(id: string): Promise<void>;
  staff(): Promise<StaffMember[]>;
  setPermission(uid: string, key: string, granted: boolean): Promise<void>;
}

export class ApiError extends Error {
  constructor(public readonly code: string, message?: string) { super(message ?? code); this.name = 'ApiError'; }
}

/** Database errors are raised as short slugs ("id_check_required", "invalid_transition: new -> ready"). */
export function toApiError(e: { message?: string; code?: string } | null | undefined): ApiError {
  const raw = String(e?.message ?? 'unknown_error');
  if (e?.code === '42501' || raw.includes('row-level security') || raw === 'forbidden') return new ApiError('forbidden', raw);
  return new ApiError(raw.split(':')[0].trim().replace(/\s+/g, '_').toLowerCase().slice(0, 60), raw);
}

const MESSAGES: Record<string, string> = {
  forbidden: 'You do not have permission to do that.',
  id_check_required: 'Check the customer’s ID first and tick the box.',
  invalid_transition: 'That order has already moved on. Refresh to see its current status.',
  reason_required: 'Please give a reason.',
  pos_item_read_only: 'Price, name and quantity come from your POS and cannot be changed here.',
  pos_product_not_found: 'That product is not in your POS inventory.',
  pos_items_not_allowed_in_curated_mode: 'This location uses a hand-made list, not POS sync.',
  curated_items_not_allowed_in_pos_mode: 'This location syncs from the POS. Add items from your POS.',
  cannot_remove_last_item: 'That is the only item. Cancel the reservation instead.',
  item_unavailable: 'That replacement is not available.',
  insufficient_stock: 'There is not enough stock for the replacement.',
  qty_over_limit: 'That quantity is over the per-item limit.',
  prepay_not_available: 'Card prepay is not available yet.',
  storefront_disabled_by_owner: 'The business owner has turned the online storefront off.',
  payment_mode_not_allowed: 'That payment mode is not allowed for this business.',
  import_needs_curated_mode: 'CSV import only works for hand-made lists.',
  too_many_rows: 'That file has too many rows (500 at most).',
  network_error: 'Could not reach the server. Check your connection.',
};
export const messageFor = (e: unknown): string => (e instanceof ApiError ? MESSAGES[e.code] : undefined) ?? 'Something went wrong. Please try again.';

type Row = Record<string, any>;
const num = (v: unknown) => (v == null ? null : Number(v));

const mapItem = (r: Row): StorefrontItem => ({
  id: r.id, source: r.source, pos_product_id: r.pos_product_id, name: r.name, brand: r.brand, flavor: r.flavor, size: r.size,
  price: num(r.price), image_url: r.image_url, category: r.category, status: r.status, qty: num(r.qty), available: num(r.available),
  sort_order: r.sort_order, read_only: !!r.read_only, pos_missing: !!r.pos_missing, updated_at: r.updated_at,
});

const mapReservation = (r: Row): Reservation => ({
  ...(r as Reservation),
  subtotal: Number(r.subtotal), fee_amount: Number(r.fee_amount), total: Number(r.total), fee_value: num(r.fee_value),
  reservation_items: ((r.reservation_items ?? []) as Row[]).map((i) => ({ ...(i as any), unit_price: Number(i.unit_price), line_total: Number(i.line_total) })),
});

export interface SupabaseApiOptions {
  /** Pages Function that drains the notification outbox right after a change (best effort). */
  kickUrl?: string;
  tenantId?: string;
}

export function createSupabaseApi(sb: SupabaseClient, opts: SupabaseApiOptions = {}): StorefrontApi {
  const rpc = async <T = any>(fn: string, args?: Record<string, unknown>): Promise<T> => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw toApiError(error);
    return data as T;
  };
  const ok = (r: { error: any }) => { if (r.error) throw toApiError(r.error); };
  const kick = async () => { if (opts.kickUrl) { try { await fetch(opts.kickUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); } catch { /* best effort */ } } };

  const RES_SELECT = '*, reservation_items(id, item_id, name, category, unit_price, qty, line_total, is_removed)';

  return {
    permissions: () => rpc<Permissions>('sf_my_permissions'),
    async settings(location) {
      const { data, error } = await sb.from('storefront_settings').select('*').eq('location_id', location).maybeSingle();
      if (error) throw toApiError(error);
      return (data as Settings | null) ?? null;
    },
    async saveSettings(location, patch) { return rpc<Settings>('sf_save_settings', { p_location: location, p_patch: patch }); },
    async setPaused(location, paused, reason) { await rpc('sf_set_paused', { p_location: location, p_paused: paused, p_reason: reason ?? null }); await kick(); },
    async businessDefaults() {
      const { data, error } = await sb.from('business_storefront_defaults').select('*').maybeSingle();
      if (error) throw toApiError(error);
      return (data as BusinessDefaults | null) ?? null;
    },
    saveBusinessDefaults: (patch) => rpc<BusinessDefaults>('sf_owner_save_defaults', { p_patch: patch }),
    async setInventoryMode(location, mode) { await rpc('sf_owner_set_inventory_mode', { p_location: location, p_mode: mode }); },
    async ensureSettings(location) { await rpc('sf_ensure_settings', { p_location: location }); },

    async items(location) { return (await rpc<Row[]>('sf_items_list', { p_location: location })).map(mapItem); },
    async posProducts(location, search) {
      return (await rpc<Row[]>('sf_pos_products', { p_location: location, p_search: search || null })).map((r) => ({ ...(r as PosProduct), price: Number(r.price), quantity: Number(r.quantity) }));
    },
    async addPosItem(location, barcode) {
      if (!opts.tenantId) throw new ApiError('forbidden');
      ok(await sb.from('storefront_items').insert({ tenant_id: opts.tenantId, location_id: location, source: 'pos', pos_product_id: barcode, status: 'available' }));
    },
    async createItem(location, input) {
      if (!opts.tenantId) throw new ApiError('forbidden');
      const { data, error } = await sb.from('storefront_items').insert({
        tenant_id: opts.tenantId, location_id: location, source: 'curated', name: input.name.trim(), brand: input.brand || null, flavor: input.flavor || null,
        size: input.size || null, price: input.price, qty: input.qty ?? null, category: input.category || null, image_url: input.image_url || null,
        status: input.status ?? 'available', sort_order: Math.floor(Date.now() / 1000),
      }).select('*').single();
      if (error) throw toApiError(error);
      return mapItem({ ...(data as Row), read_only: false, pos_missing: false, available: (data as Row).qty });
    },
    async updateItem(id, patch) {
      const { error, count } = await sb.from('storefront_items').update(patch, { count: 'exact' }).eq('id', id);
      if (error) throw toApiError(error);
      if (count === 0) throw new ApiError('forbidden');         // RLS hides rows you may not edit: zero rows changed
    },
    async deleteItem(id) { ok(await sb.from('storefront_items').delete().eq('id', id)); },
    setStatus: (ids, status) => rpc<number>('sf_bulk_set_status', { p_ids: ids, p_status: status }),
    async reorder(location, orderedIds) { await rpc('sf_reorder_items', { p_location: location, p_ids: orderedIds }); },
    duplicate: (id) => rpc<string>('sf_duplicate_item', { p_item: id }),
    importItems: (location, rows) => rpc('sf_import_items', { p_location: location, p_rows: rows }),
    async uploadImage(location, blob) {
      if (!opts.tenantId) throw new ApiError('forbidden');
      const path = `${opts.tenantId}/storefront/${location}/${crypto.randomUUID()}.jpg`;
      const { error } = await sb.storage.from('product-images').upload(path, blob, { contentType: 'image/jpeg', upsert: false });
      if (error) throw toApiError(error);
      return sb.storage.from('product-images').getPublicUrl(path).data.publicUrl;
    },

    async reservations(location) {
      const since = new Date(Date.now() - 36 * 3600e3).toISOString();
      const { data, error } = await sb.from('reservations').select(RES_SELECT).eq('location_id', location)
        .or(`status.in.(new,confirmed,ready),created_at.gte.${since}`).order('created_at', { ascending: false }).limit(200);
      if (error) throw toApiError(error);
      return ((data ?? []) as Row[]).map(mapReservation);
    },
    subscribeReservations(location, onChange) {
      const ch = sb.channel(`sf-res-${location}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'reservations', filter: `location_id=eq.${location}` },
          (p: { eventType?: string }) => onChange(p.eventType === 'INSERT' ? 'insert' : 'update'))
        .subscribe();
      return () => { void sb.removeChannel(ch); };
    },
    async confirm(id) { await rpc('sf_reservation_confirm', { p_id: id }); await kick(); },
    async markReady(id) { await rpc('sf_reservation_ready', { p_id: id }); await kick(); },
    async pickup(id, idChecked) { await rpc('sf_reservation_pickup', { p_id: id, p_id_checked: idChecked }); },
    async noShow(id) { await rpc('sf_reservation_no_show', { p_id: id }); await kick(); },
    async cancel(id, reason) { await rpc('sf_reservation_cancel', { p_id: id, p_reason: reason }); await kick(); },
    async payRegister(id) { await rpc('sf_reservation_pay_register', { p_id: id }); },
    async itemUnavailable(id, line, replacement, qty) {
      await rpc('sf_reservation_item_unavailable', { p_id: id, p_line: line, p_replacement: replacement ?? null, p_replacement_qty: qty ?? null }); await kick();
    },
    kick,

    async dashboard(location) { const d = await rpc<Row>('sf_dashboard', { p_location: location }); return { ...(d as Dashboard), sales_7d: Number(d.sales_7d), fees_7d: Number(d.fees_7d), no_show_rate_30d: Number(d.no_show_rate_30d) }; },
    async report(location, from, to) {
      const r = await rpc<Row>('sf_report', { p_location: location, p_from: from, p_to: to });
      return { ...(r as Report), online_sales: Number(r.online_sales), fees_accrued: Number(r.fees_accrued), no_show_rate: Number(r.no_show_rate) };
    },
    async ledger(location) {
      let q = sb.from('fee_ledger').select('*').order('created_at', { ascending: false }).limit(1000);
      if (location) q = q.eq('location_id', location);
      const { data, error } = await q;
      if (error) throw toApiError(error);
      return ((data ?? []) as Row[]).map((r) => ({ ...(r as LedgerRow), amount: Number(r.amount) }));
    },
    async statements() {
      const { data, error } = await sb.from('fee_statements').select('*').order('period', { ascending: false });
      if (error) throw toApiError(error);
      return ((data ?? []) as Row[]).map((r) => ({ ...(r as Statement), total: Number(r.total) }));
    },
    async markStatementPaid(id) { await rpc('sf_mark_statement_paid', { p_id: id }); },
    staff: () => rpc<StaffMember[]>('sf_staff_list'),
    async setPermission(uid, key, granted) { await rpc('sf_set_permission', { p_employee: uid, p_key: key, p_granted: granted }); },
  };
}
