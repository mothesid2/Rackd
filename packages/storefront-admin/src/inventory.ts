// One UI, two inventory behaviours. The module asks the InventorySource what is editable; it never branches on
// "Model A / Model B" itself.

import type { InventoryMode, ItemInput, StorefrontItem } from './types';

export type ItemField = 'name' | 'brand' | 'flavor' | 'size' | 'price' | 'qty' | 'category' | 'image_url' | 'status' | 'sort_order';

export interface InventorySource {
  mode: InventoryMode;
  label: string;
  /** Can this field be edited on this item? */
  canEdit(item: StorefrontItem | null, field: ItemField): boolean;
  /** Hand-made items can be created from scratch; POS items are added from the POS picker. */
  canCreate: boolean;
  canPickFromPos: boolean;
  canImportCsv: boolean;
  canDuplicate(item: StorefrontItem): boolean;
  /** Text shown next to a quantity so staff know where it comes from. */
  quantityNote(item: StorefrontItem): string;
  validate(input: Partial<ItemInput>): string | null;
}

/** POS sync: name, price and quantity are read live from the Rackd POS. Only visibility and presentation are editable. */
export const PosInventorySource: InventorySource = {
  mode: 'pos_sync',
  label: 'Synced from your POS',
  canEdit: (_item, field) => ['status', 'sort_order', 'image_url', 'category'].includes(field),
  canCreate: false,
  canPickFromPos: true,
  canImportCsv: false,
  canDuplicate: () => false,
  quantityNote: (i) => (i.pos_missing ? 'No longer in your POS' : 'Live from your POS'),
  validate: () => null,
};

/** Curated: a short hand-made list. Everything is editable; quantity is optional (blank = unlimited). */
export const CuratedInventorySource: InventorySource = {
  mode: 'curated',
  label: 'Hand-made list',
  canEdit: () => true,
  canCreate: true,
  canPickFromPos: false,
  canImportCsv: true,
  canDuplicate: () => true,
  quantityNote: (i) => (i.qty == null ? 'Unlimited' : `${i.qty} on hand`),
  validate(input) {
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 120)) return 'Give the item a name (up to 120 characters).';
    if (input.price !== undefined && (!Number.isFinite(input.price) || input.price < 0 || input.price >= 100000)) return 'Enter a price between $0 and $99,999.99.';
    if (input.qty != null && (!Number.isInteger(input.qty) || input.qty < 0)) return 'Quantity must be a whole number, or left blank for unlimited.';
    return null;
  },
};

export const sourceFor = (mode: InventoryMode | null | undefined): InventorySource => (mode === 'pos_sync' ? PosInventorySource : CuratedInventorySource);

/** Restricted categories always require an ID check at pickup (mirrors sf_id_required in the database). */
export const RESTRICTED_CATEGORY = /(vape|vapor|tobacco|cigar|cigarette|nicotine|e-?liquid|e-?juice|hookah|disposable|pod|smok)/i;
export const isRestrictedCategory = (c: string | null | undefined) => !!c && RESTRICTED_CATEGORY.test(c);
