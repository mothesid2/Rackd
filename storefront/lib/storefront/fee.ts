// Fee preview for the customer cart. Mirrors the database function sf_compute_fee EXACTLY (percent of the
// subtotal rounded half-up to the cent; flat is a dollar amount). The database computes and snapshots the real fee
// when the reservation is created; this is only what the customer sees beforehand.

export interface FeeInfo {
  type: 'percent' | 'flat';
  value: number;
  waived: boolean;
  first_order_waiver: boolean;
  label: string;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function previewFee(fee: FeeInfo | null | undefined, subtotal: number): { amount: number; waived: boolean; maybeWaived: boolean } {
  if (!fee) return { amount: 0, waived: false, maybeWaived: false };
  if (fee.waived) return { amount: 0, waived: true, maybeWaived: false };
  const amount = fee.type === 'percent' ? round2((subtotal * fee.value) / 100) : round2(fee.value);
  return { amount, waived: false, maybeWaived: fee.first_order_waiver };
}

export function feeExplanation(fee: FeeInfo | null | undefined): string {
  if (!fee) return 'A small fee for reserving online.';
  const how = fee.type === 'percent' ? `${fee.value}% of your items` : `a flat $${fee.value.toFixed(2)} per reservation`;
  return `This shop charges ${how} for online reservations. You pay it at the shop with your items, and it helps cover the cost of the online ordering service.`;
}
