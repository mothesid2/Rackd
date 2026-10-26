import { describe, expect, it } from 'vitest';
import { feeExplanation, previewFee, type FeeInfo } from '../../lib/storefront/fee';

const pct = (value: number, extra: Partial<FeeInfo> = {}): FeeInfo => ({ type: 'percent', value, waived: false, first_order_waiver: false, label: 'Reservation fee', ...extra });
const flat = (value: number, extra: Partial<FeeInfo> = {}): FeeInfo => ({ type: 'flat', value, waived: false, first_order_waiver: false, label: 'Reservation fee', ...extra });

describe('previewFee mirrors the database sf_compute_fee', () => {
  // the same cases are asserted in supabase/tests/storefront_manager_tests.sql
  it.each([
    [pct(5), 12.35, 0.62],      // 0.6175 -> 0.62
    [pct(5), 10.10, 0.51],      // 0.505  -> 0.51 (half up)
    [pct(8.25), 100, 8.25],
    [pct(5), 0, 0],
    [pct(5), 25, 1.25],
    [pct(10), 30, 3.0],
    [flat(1.499), 100, 1.5],
    [flat(2.5), 0.01, 2.5],
  ])('%j on %d is %d', (fee, subtotal, expected) => {
    expect(previewFee(fee, subtotal).amount).toBe(expected);
  });

  it('business waiver shows zero and waived; first-order waiver is flagged as possible, not promised', () => {
    expect(previewFee(pct(5, { waived: true }), 50)).toEqual({ amount: 0, waived: true, maybeWaived: false });
    expect(previewFee(pct(5, { first_order_waiver: true }), 50)).toEqual({ amount: 2.5, waived: false, maybeWaived: true });
  });
  it('no fee info means no fee', () => {
    expect(previewFee(null, 10)).toEqual({ amount: 0, waived: false, maybeWaived: false });
  });
  it('explains the fee in plain language, including that it is paid at the shop', () => {
    expect(feeExplanation(pct(5))).toContain('5% of your items');
    expect(feeExplanation(flat(1.5))).toContain('flat $1.50');
    expect(feeExplanation(pct(5))).toContain('pay it at the shop');
  });
});
