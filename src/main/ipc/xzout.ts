import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import bcrypt from 'bcryptjs';
import { nowCT } from '../utils/time';
import { DateTime } from 'luxon';
import { getSupabase } from '../supabase/client';
import { getLocationId } from '../supabase/sync';
import { userHasPermission } from '../permissions';
import { closeDay } from '../daySession';

/** Managers always may view reports; cashiers need the view_reports grant. */
function canViewReports(): boolean {
  const s = getCurrentSession();
  if (!s) return false;
  if (s.role === 'manager') return true;
  return userHasPermission(getDb(), s.userId, 'view_reports').granted;
}
const REPORTS_DENIED = { success: false as const, error: 'You do not have permission to view reports' };

const TZ = 'America/Chicago';

interface FullReport {
  generated_at: string;
  shift_opened_at: string;
  cashier_name: string;
  // Sales summary
  gross_sales: number;
  discount_total: number;
  tax_total: number;
  net_sales: number;
  // Payment breakdown
  cash_total: number;
  card_total: number;
  split_total: number;
  online_total: number; // Online — Prepaid (NOT part of the cash drawer)
  sale_count: number;
  avg_ticket: number;
  // Category summary
  by_category: { category: string; qty: number; revenue: number }[];
  // Top products
  top_products: { name: string; qty: number; revenue: number }[];
  // Hourly breakdown
  by_hour: { hour: number; label: string; count: number; revenue: number }[];
  // Tip pool (batch 5, item 7 + item 9: shows up in X/Z reporting)
  tip_pool: TipPool;
  // Estimated card-processing cost on product sales (batch 5 legal rework,
  // item 3) — same merchant fee rates as the tip deduction, since card fees
  // eat into sale revenue too, not just tips. Informational only: does NOT
  // alter gross_sales/net_sales above, which keep their existing meaning.
  card_processing_fee_pct: number;
  card_processing_fee_flat_cents: number;
  card_processing_fee_amount: number;
}

function buildFullReport(db: ReturnType<typeof import('../db/schema').getDb>, shiftOpenedAt: string, cashierName: string): FullReport {
  // Use only the date portion (YYYY-MM-DD) for comparison to avoid timezone format mismatches.
  // created_at is stored as ISO 8601 (e.g. "2026-04-12T14:30:00.000-05:00"),
  // so substr(created_at,1,10) reliably gives the local date.
  const openDate = shiftOpenedAt.substring(0, 10); // 'YYYY-MM-DD'
  const fees = merchantFeeRates(db);

  const summary = db.prepare(`
    SELECT
      COALESCE(SUM(subtotal + discount_amount), 0) AS gross_sales,
      COALESCE(SUM(discount_amount), 0) AS discount_total,
      COALESCE(SUM(tax_amount), 0) AS tax_total,
      COALESCE(SUM(total), 0) AS net_sales,
      COALESCE(SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END), 0) AS cash_total,
      COALESCE(SUM(CASE WHEN payment_method='card' THEN total ELSE 0 END), 0) AS card_total,
      COALESCE(SUM(CASE WHEN payment_method='split' THEN total ELSE 0 END), 0) AS split_total,
      COALESCE(SUM(CASE WHEN order_source='online' THEN total ELSE 0 END), 0) AS online_total,
      COUNT(*) AS sale_count,
      COALESCE(SUM(CASE WHEN payment_method IN ('card','split') THEN 1 ELSE 0 END), 0) AS card_txn_count
    FROM transactions
    WHERE substr(created_at, 1, 10) >= ? AND payment_status = 'completed'
  `).get(openDate) as {
    gross_sales: number; discount_total: number; tax_total: number; net_sales: number;
    cash_total: number; card_total: number; split_total: number; online_total: number; sale_count: number; card_txn_count: number;
  };

  const byCategory = db.prepare(`
    SELECT
      COALESCE(p.category, ti.category, 'Uncategorized') AS category,
      SUM(ti.qty) AS qty,
      SUM(ti.line_total) AS revenue
    FROM transaction_items ti
    LEFT JOIN products p ON ti.product_id = p.id
    JOIN transactions t ON ti.transaction_id = t.id
    WHERE substr(t.created_at, 1, 10) >= ? AND t.payment_status = 'completed'
    GROUP BY COALESCE(p.category, ti.category, 'Uncategorized')
    ORDER BY revenue DESC
  `).all(openDate) as { category: string; qty: number; revenue: number }[];

  const topProducts = db.prepare(`
    SELECT
      p.name,
      SUM(ti.qty) AS qty,
      SUM(ti.line_total) AS revenue
    FROM transaction_items ti
    JOIN products p ON ti.product_id = p.id
    JOIN transactions t ON ti.transaction_id = t.id
    WHERE substr(t.created_at, 1, 10) >= ? AND t.payment_status = 'completed'
    GROUP BY ti.product_id
    ORDER BY revenue DESC
    LIMIT 5
  `).all(openDate) as { name: string; qty: number; revenue: number }[];

  const hourlyRaw = db.prepare(`
    SELECT
      CAST(substr(created_at, 12, 2) AS INTEGER) AS hour,
      COUNT(*) AS count,
      SUM(total) AS revenue
    FROM transactions
    WHERE substr(created_at, 1, 10) >= ? AND payment_status = 'completed'
    GROUP BY hour
    ORDER BY hour
  `).all(openDate) as { hour: number; count: number; revenue: number }[];

  const hourMap = new Map(hourlyRaw.map(r => [r.hour, r]));
  const byHour = Array.from({ length: 24 }, (_, h) => {
    const row = hourMap.get(h);
    const suffix = h < 12 ? 'AM' : 'PM';
    const display = h === 0 ? '12 AM' : h < 12 ? `${h} AM` : h === 12 ? '12 PM' : `${h - 12} PM`;
    return { hour: h, label: display, count: row?.count || 0, revenue: row?.revenue || 0 };
  }).filter(r => r.count > 0);

  return {
    generated_at: nowCT(),
    shift_opened_at: shiftOpenedAt,
    cashier_name: cashierName,
    gross_sales: summary.gross_sales,
    discount_total: summary.discount_total,
    tax_total: summary.tax_total,
    net_sales: summary.net_sales,
    cash_total: summary.cash_total,
    card_total: summary.card_total,
    split_total: summary.split_total,
    online_total: summary.online_total,
    sale_count: summary.sale_count,
    avg_ticket: summary.sale_count > 0 ? summary.net_sales / summary.sale_count : 0,
    by_category: byCategory,
    top_products: topProducts,
    by_hour: byHour,
    tip_pool: computeTipPool(db, openDate, openDate),
    card_processing_fee_pct: fees.effectivePct,
    card_processing_fee_flat_cents: fees.flatCents,
    card_processing_fee_amount: Math.round(((summary.card_total + summary.split_total) * (fees.effectivePct / 100) + summary.card_txn_count * (fees.flatCents / 100)) * 100) / 100,
  };
}

interface MerchantFeeRates { creditPct: number; debitPct: number; effectivePct: number; flatCents: number }

/**
 * Owner-set merchant/card-processing rates for this location (all 0 until
 * configured) — credit %, debit %, and a flat per-transaction fee, matching
 * how real card processing prices (e.g. "2.6% + $0.10"), not one blended %.
 *
 * CONSTRAINT: this build's terminal integration (src/main/services/
 * valorTerminal.ts) only ever reports card BRAND (Visa/Mastercard/etc, from
 * ISSUER/CARD_TYPE) — never an account-type flag distinguishing credit from
 * debit. Until that data exists, `effectivePct` is the LOWER of the two
 * configured rates, applied uniformly to every card transaction. This is a
 * deliberate legal-safety choice: since the actual card type used per sale is
 * unknown, applying the higher (credit) rate would risk OVER-deducting from
 * the tip pool on transactions that were actually cheaper debit swipes —
 * deducting more than the true incurred cost is the direction that's legally
 * indefensible, so this always errs toward under-deducting instead.
 */
function merchantFeeRates(db: ReturnType<typeof import('../db/schema').getDb>): MerchantFeeRates {
  const get = (key: string) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return Number(row?.value) || 0;
  };
  const creditPct = Math.max(0, Math.min(100, get('merchant_fee_credit_pct')));
  const debitPct = Math.max(0, Math.min(100, get('merchant_fee_debit_pct')));
  const flatCents = Math.max(0, get('merchant_fee_flat_cents'));
  // If only one of the two rates has been set, use it rather than treating
  // the unset one's 0 as "free" and averaging it away.
  const configured = [creditPct, debitPct].filter((v) => v > 0);
  const effectivePct = configured.length ? Math.min(...configured) : 0;
  return { creditPct, debitPct, effectivePct, flatCents };
}

interface TipPoolShare { employee_uid: string; name: string; role: string; hours: number; share: number }
interface TipPool {
  total_tips: number;
  card_tip_total: number;
  merchant_fee_credit_pct: number;
  merchant_fee_debit_pct: number;
  merchant_fee_effective_pct: number;
  merchant_fee_flat_cents: number;
  card_tip_txn_count: number;
  deduction_amount: number;
  pool_amount: number;
  total_hours: number;
  pooled: boolean;
  skip_reason: string | null;
  by_employee: TipPoolShare[];
}

/** Roles that can NEVER receive a tip-pool distribution — FLSA 2018 amendment,
 * 29 U.S.C. §203(m)(2)(B): employers/managers/supervisors are excluded from
 * tip pools entirely, not just from taking a cut. Written as an explicit
 * denylist (not "role === 'cashier'") so a future non-management tipped role
 * is eligible by default rather than silently excluded. */
const MANAGEMENT_ROLES = new Set(['admin', 'manager']);

/** Split `poolCents` proportional to each entry's weight, largest-remainder
 * method so the parts always sum to exactly poolCents (money-safe rounding). */
function allocateCents<T extends { weight: number }>(entries: T[], poolCents: number): (T & { cents: number })[] {
  const totalWeight = entries.reduce((s, e) => s + e.weight, 0);
  if (totalWeight <= 0 || poolCents <= 0) return entries.map((e) => ({ ...e, cents: 0 }));
  let allocated = 0;
  const raw = entries.map((e) => {
    const exact = poolCents * (e.weight / totalWeight);
    const cents = Math.floor(exact);
    allocated += cents;
    return { ...e, cents, remainder: exact - cents };
  });
  let leftover = poolCents - allocated;
  raw.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < raw.length && leftover > 0; i++, leftover--) raw[i].cents += 1;
  return raw;
}

/**
 * Tip pool for a date range (batch 5, rebuilt to the user's legal spec after
 * their own research — see their instructions for the full citations):
 *
 *  - Deduction is the ACTUAL card-processing cost (location.merchant_fee_pct,
 *    owner-set in the Owner Console, synced down — never a guessed/flat %),
 *    applied only to the CARD-tendered portion of tips (cash tips carry no
 *    processing cost). NOT hardcoded.
 *  - Only role='cashier' employees are eligible to receive a share, and only
 *    their hours count toward the weighting — admin/manager are excluded from
 *    the calculation entirely (29 U.S.C. §203(m)(2)(B)), not merely from the
 *    fee cut.
 *  - Sole-service exception (29 CFR §531.52): if NO eligible (cashier) hours
 *    were logged in the range, pooling is skipped entirely — tips post
 *    directly to whoever rang each sale (by_employee reflects DIRECT
 *    per-transaction totals here, not a pooled split), with no deduction
 *    applied. This also correctly covers "multiple managers, no cashiers":
 *    each manager's own directly-rung tips stay individual, never pooled
 *    with each other.
 */
export function computeTipPool(db: ReturnType<typeof import('../db/schema').getDb>, startDate: string, endDate: string): TipPool {
  const tipRow = db.prepare(
    `SELECT COALESCE(SUM(tip_amount), 0) AS total,
            COALESCE(SUM(CASE WHEN payment_method IN ('card','split') THEN tip_amount ELSE 0 END), 0) AS card_total,
            COALESCE(SUM(CASE WHEN payment_method IN ('card','split') AND tip_amount > 0 THEN 1 ELSE 0 END), 0) AS card_tip_txns
     FROM transactions WHERE substr(created_at, 1, 10) BETWEEN ? AND ? AND payment_status = 'completed'`
  ).get(startDate, endDate) as { total: number; card_total: number; card_tip_txns: number };
  const totalTips = Math.round((tipRow.total || 0) * 100) / 100;
  const cardTipTotal = Math.round((tipRow.card_total || 0) * 100) / 100;
  const cardTipTxnCount = tipRow.card_tip_txns || 0;

  const fees = merchantFeeRates(db);

  // Role lookup — the whole point of this rebuild is that this can never be
  // skipped or bypassed for a given employee_uid.
  const roleByUid = new Map<string, string>();
  for (const u of db.prepare('SELECT uid, role FROM users WHERE uid IS NOT NULL').all() as { uid: string; role: string }[]) {
    roleByUid.set(u.uid, u.role);
  }

  const punches = db.prepare(
    `SELECT employee_uid, employee_name, clock_in, clock_out FROM time_clock
     WHERE substr(clock_in, 1, 10) BETWEEN ? AND ?`
  ).all(startDate, endDate) as { employee_uid: string; employee_name: string | null; clock_in: string; clock_out: string | null }[];

  const nowMs = Date.now();
  const eligibleHours = new Map<string, { name: string; hours: number }>();
  for (const p of punches) {
    const role = roleByUid.get(p.employee_uid);
    if (!role || MANAGEMENT_ROLES.has(role)) continue; // never counted toward the pool, at all
    const inMs = new Date(p.clock_in).getTime();
    const outMs = p.clock_out ? new Date(p.clock_out).getTime() : nowMs;
    const hrs = Math.max(0, (outMs - inMs) / 3_600_000);
    const cur = eligibleHours.get(p.employee_uid) || { name: p.employee_name || 'Employee', hours: 0 };
    cur.hours += hrs;
    eligibleHours.set(p.employee_uid, cur);
  }
  const totalHours = [...eligibleHours.values()].reduce((s, e) => s + e.hours, 0);

  if (totalHours <= 0) {
    // Sole-service exception: nobody eligible worked (or only management did —
    // including the "multiple managers, no cashiers" case). Do not pool. Tips
    // stay exactly where they were rung, no fee deducted.
    const direct = db.prepare(
      `SELECT t.cashier_id AS uid, COALESCE(SUM(t.tip_amount), 0) AS total
       FROM transactions t
       WHERE substr(t.created_at, 1, 10) BETWEEN ? AND ? AND t.payment_status = 'completed' AND t.tip_amount > 0
       GROUP BY t.cashier_id`
    ).all(startDate, endDate) as { uid: number | null; total: number }[];
    const byEmployee: TipPoolShare[] = [];
    for (const d of direct) {
      if (d.uid == null) continue;
      const u = db.prepare('SELECT uid, name, username, role FROM users WHERE id = ?').get(d.uid) as { uid: string | null; name: string | null; username: string | null; role: string } | undefined;
      if (!u) continue;
      byEmployee.push({ employee_uid: u.uid || String(d.uid), name: u.name || u.username || 'Employee', role: u.role, hours: 0, share: Math.round(d.total * 100) / 100 });
    }
    byEmployee.sort((a, b) => b.share - a.share);
    return {
      total_tips: totalTips, card_tip_total: cardTipTotal,
      merchant_fee_credit_pct: fees.creditPct, merchant_fee_debit_pct: fees.debitPct,
      merchant_fee_effective_pct: fees.effectivePct, merchant_fee_flat_cents: fees.flatCents, card_tip_txn_count: cardTipTxnCount,
      deduction_amount: 0, pool_amount: 0, total_hours: 0, pooled: false,
      skip_reason: 'No eligible (non-management) employee clocked in — tips post directly to whoever rang the sale, not pooled (29 CFR §531.52).',
      by_employee: byEmployee,
    };
  }

  // Deduction = (% rate on the card-tendered tip total) + (flat per-swipe fee,
  // once for each card transaction that included a tip). The flat fee is a
  // real cost triggered by the swipe itself; attributing one flat-fee unit to
  // each tipped card transaction (rather than splitting it proportionally
  // across item total vs. tip) keeps the calculation simple and auditable —
  // flagged to the user as a judgment call, not dictated by the legal guidance.
  const pctDeduction = cardTipTotal * (fees.effectivePct / 100);
  const flatDeduction = cardTipTxnCount * (fees.flatCents / 100);
  const deductionAmount = Math.round((pctDeduction + flatDeduction) * 100) / 100;
  const poolAmount = Math.round((totalTips - deductionAmount) * 100) / 100;

  const shares = allocateCents(
    [...eligibleHours.entries()].map(([uid, e]) => ({ uid, name: e.name, weight: e.hours, hours: e.hours })),
    Math.round(poolAmount * 100)
  );
  const byEmployee: TipPoolShare[] = shares
    .map((s) => ({ employee_uid: s.uid, name: s.name, role: 'cashier', hours: Math.round(s.hours * 100) / 100, share: s.cents / 100 }))
    .sort((a, b) => b.share - a.share);

  return {
    total_tips: totalTips, card_tip_total: cardTipTotal,
    merchant_fee_credit_pct: fees.creditPct, merchant_fee_debit_pct: fees.debitPct,
    merchant_fee_effective_pct: fees.effectivePct, merchant_fee_flat_cents: fees.flatCents, card_tip_txn_count: cardTipTxnCount,
    deduction_amount: deductionAmount, pool_amount: poolAmount,
    total_hours: Math.round(totalHours * 100) / 100, pooled: true, skip_reason: null,
    by_employee: byEmployee,
  };
}

/** Persist a computed tip pool to the audit trail (batch 5) — called once per
 * business day at Z-report close, not on every X-report preview. Keeps the
 * fee rate and deduction actually used on record, not just the final shares. */
export function saveTipPoolLedger(db: ReturnType<typeof import('../db/schema').getDb>, reportDate: string, zReportId: number | null, tp: TipPool): void {
  const generatedAt = nowCT();
  const res = db.prepare(
    `INSERT INTO tip_pool_ledger (report_date, z_report_id, total_tips, card_tip_total, merchant_fee_credit_pct, merchant_fee_debit_pct, merchant_fee_flat_cents, card_tip_txn_count, deduction_amount, pool_amount, pooled, skip_reason, total_hours, generated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(reportDate, zReportId, tp.total_tips, tp.card_tip_total, tp.merchant_fee_credit_pct, tp.merchant_fee_debit_pct, tp.merchant_fee_flat_cents, tp.card_tip_txn_count, tp.deduction_amount, tp.pool_amount, tp.pooled ? 1 : 0, tp.skip_reason, tp.total_hours, generatedAt);
  const ledgerId = Number(res.lastInsertRowid);
  const insertShare = db.prepare(
    `INSERT INTO tip_pool_shares (ledger_id, employee_uid, employee_name, role, hours, share_amount) VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const e of tp.by_employee) insertShare.run(ledgerId, e.employee_uid, e.name, e.role, e.hours, e.share);
}

function normalizeBrand(cardType: string | null): string {
  if (!cardType) return 'Other';
  const s = cardType.toUpperCase();
  if (s.includes('VISA')) return 'Visa';
  if (s.includes('MASTER') || s === 'MC') return 'Mastercard';
  if (s.includes('DISC')) return 'Discover';
  if (s.includes('AMEX') || s.includes('AMERICAN')) return 'Amex';
  return 'Other';
}

// Period report for an arbitrary date range (YYYY-MM-DD inclusive). Used by the
// monthly / MTD / YTD audit report. Breaks payments out by card brand + cash,
// and sales out by department (product category).
function buildPeriodReport(db: ReturnType<typeof import('../db/schema').getDb>, startDate: string, endDate: string) {
  const fees = merchantFeeRates(db);
  const summary = db.prepare(`
    SELECT
      COALESCE(SUM(subtotal + discount_amount), 0) AS gross,
      COALESCE(SUM(discount_amount), 0) AS discounts,
      COALESCE(SUM(subtotal), 0) AS net_presubtax,
      COALESCE(SUM(tax_amount), 0) AS tax,
      COALESCE(SUM(total), 0) AS total_collected,
      COUNT(*) AS count
    FROM transactions
    WHERE substr(created_at, 1, 10) BETWEEN ? AND ? AND payment_status = 'completed'
  `).get(startDate, endDate) as {
    gross: number; discounts: number; net_presubtax: number; tax: number; total_collected: number; count: number;
  };

  const payRows = db.prepare(`
    SELECT payment_method, card_type, SUM(total) AS amount, COUNT(*) AS cnt
    FROM transactions
    WHERE substr(created_at, 1, 10) BETWEEN ? AND ? AND payment_status = 'completed'
      AND COALESCE(order_source, 'in_store') <> 'online'
    GROUP BY payment_method, card_type
  `).all(startDate, endDate) as { payment_method: string; card_type: string | null; amount: number; cnt: number }[];

  // Online — Prepaid: reported distinctly, never mixed into the cash/card drawer.
  const onlineRow = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS amount, COUNT(*) AS cnt
    FROM transactions
    WHERE substr(created_at, 1, 10) BETWEEN ? AND ? AND payment_status = 'completed' AND order_source = 'online'
  `).get(startDate, endDate) as { amount: number; cnt: number };

  const brandMap: Record<string, { amount: number; count: number }> = {
    Visa: { amount: 0, count: 0 }, Mastercard: { amount: 0, count: 0 },
    Discover: { amount: 0, count: 0 }, Amex: { amount: 0, count: 0 }, Other: { amount: 0, count: 0 },
  };
  let cash = 0, cashCount = 0;
  for (const r of payRows) {
    if (r.payment_method === 'cash') { cash += r.amount; cashCount += r.cnt; continue; }
    const b = normalizeBrand(r.card_type);
    brandMap[b].amount += r.amount; brandMap[b].count += r.cnt;
  }
  const brands = ['Visa', 'Mastercard', 'Discover', 'Amex'].map(b => ({ brand: b, ...brandMap[b] }));
  const otherCard = brandMap.Other;
  const cardTotal = brands.reduce((s, b) => s + b.amount, 0) + otherCard.amount;
  const cardCount = brands.reduce((s, b) => s + b.count, 0) + otherCard.count;

  const byCategory = db.prepare(`
    SELECT COALESCE(p.category, ti.category, 'Uncategorized') AS category,
           SUM(ti.qty) AS qty, SUM(ti.line_total) AS revenue
    FROM transaction_items ti
    LEFT JOIN products p ON ti.product_id = p.id
    JOIN transactions t ON ti.transaction_id = t.id
    WHERE substr(t.created_at, 1, 10) BETWEEN ? AND ? AND t.payment_status = 'completed'
    GROUP BY COALESCE(p.category, ti.category, 'Uncategorized')
    ORDER BY revenue DESC
  `).all(startDate, endDate) as { category: string; qty: number; revenue: number }[];

  const topProducts = db.prepare(`
    SELECT COALESCE(p.name || ' - ' || v.label, p.name) AS name,
           SUM(ti.qty) AS qty, SUM(ti.line_total) AS revenue
    FROM transaction_items ti
    JOIN products p ON ti.product_id = p.id
    LEFT JOIN product_variants v ON ti.variant_id = v.id
    JOIN transactions t ON ti.transaction_id = t.id
    WHERE substr(t.created_at, 1, 10) BETWEEN ? AND ? AND t.payment_status = 'completed'
    GROUP BY ti.product_id, ti.variant_id
    ORDER BY revenue DESC
    LIMIT 5
  `).all(startDate, endDate) as { name: string; qty: number; revenue: number }[];

  // Units sold (positive lines) and refunds (negative-total transactions)
  const unitsRow = db.prepare(`
    SELECT COALESCE(SUM(ti.qty), 0) AS units
    FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id
    WHERE substr(t.created_at, 1, 10) BETWEEN ? AND ? AND t.payment_status = 'completed' AND ti.qty > 0
  `).get(startDate, endDate) as { units: number };

  const refundRow = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
    FROM transactions
    WHERE substr(created_at, 1, 10) BETWEEN ? AND ? AND payment_status = 'completed' AND total < 0
  `).get(startDate, endDate) as { count: number; total: number };

  return {
    summary: {
      ...summary,
      avg: summary.count > 0 ? summary.total_collected / summary.count : 0,
      units: unitsRow.units,
      units_per_txn: summary.count > 0 ? unitsRow.units / summary.count : 0,
    },
    payments: { cash, cash_count: cashCount, brands, other_card: otherCard, card_total: cardTotal, online: onlineRow.amount, online_count: onlineRow.cnt },
    by_category: byCategory,
    top_products: topProducts,
    refunds: { count: refundRow.count, total: refundRow.total },
    tip_pool: computeTipPool(db, startDate, endDate),
    card_processing_fee_pct: fees.effectivePct,
    card_processing_fee_flat_cents: fees.flatCents,
    card_processing_fee_amount: Math.round((cardTotal * (fees.effectivePct / 100) + cardCount * (fees.flatCents / 100)) * 100) / 100,
  };
}

export function registerXZOutHandlers(): void {
  // Sales report for a chosen date range (used by both X report and Audit).
  ipcMain.handle('xzout:periodReport', async (_event, opts?: { start?: string; end?: string }) => {
    try {
      if (!canViewReports()) return REPORTS_DENIED;
      const db = getDb();
      const now = DateTime.now().setZone(TZ);
      const start = opts?.start || (now.toISODate() as string);
      const end = opts?.end || start;
      const label = start === end
        ? DateTime.fromISO(start, { zone: TZ }).toFormat('MMM d, yyyy')
        : `${DateTime.fromISO(start, { zone: TZ }).toFormat('MMM d, yyyy')} — ${DateTime.fromISO(end, { zone: TZ }).toFormat('MMM d, yyyy')}`;

      const report = buildPeriodReport(db, start, end);

      return {
        success: true,
        period: { label, start, end },
        ...report,
        generated_at: nowCT(),
        generated_by: getCurrentSession()?.username || 'Staff',
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });


  // Location roll-up of the period report (Phase 4): the SAME shape as
  // xzout:periodReport but aggregated across every register in this location via
  // the cloud RPC. Requires internet + a location-scoped license; the caller
  // falls back to the local ("This register") report when this returns an error.
  ipcMain.handle('xzout:locationPeriodReport', async (_event, opts?: { start?: string; end?: string }) => {
    try {
      if (!canViewReports()) return REPORTS_DENIED;
      const now = DateTime.now().setZone(TZ);
      const start = opts?.start || (now.toISODate() as string);
      const end = opts?.end || start;
      const label = start === end
        ? DateTime.fromISO(start, { zone: TZ }).toFormat('MMM d, yyyy')
        : `${DateTime.fromISO(start, { zone: TZ }).toFormat('MMM d, yyyy')} — ${DateTime.fromISO(end, { zone: TZ }).toFormat('MMM d, yyyy')}`;

      if (!getLocationId()) return { success: false, error: 'This register is not assigned to a location yet.' };
      const supabase = getSupabase();
      if (!supabase) return { success: false, error: 'Cloud not configured — location totals need internet.' };

      const { data, error } = await supabase.rpc('location_period_report', { p_start: start, p_end: end });
      if (error) return { success: false, error: error.message };

      return {
        success: true,
        scope: 'location',
        period: { label, start, end },
        ...(data as Record<string, unknown>),
        generated_at: nowCT(),
        generated_by: getCurrentSession()?.username || 'Staff',
      };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // Age-verification audit log — manager only.
  ipcMain.handle('compliance:ageLog', async (_event, opts?: { limit?: number }) => {
    try {
      if (getCurrentSession()?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      const limit = Math.min(1000, Math.max(1, opts?.limit || 250));
      const log = db.prepare(`
        SELECT a.id, a.transaction_id, a.customer_name, a.dob, a.age_at_sale, a.min_age,
               a.result, a.method, a.cashier_name, a.created_at, t.total AS txn_total
        FROM age_checks a
        LEFT JOIN transactions t ON t.id = a.transaction_id
        ORDER BY a.id DESC
        LIMIT ?
      `).all(limit);
      return { success: true, log };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('xzout:xReport', async () => {
    try {
      if (!canViewReports()) return REPORTS_DENIED;
      const db = getDb();
      const session = getCurrentSession();

      const shift = db.prepare(`
        SELECT st.*, u.username
        FROM shift_totals st
        LEFT JOIN users u ON st.cashier_id = u.id
        WHERE st.cashier_id = ? AND st.closed_at IS NULL
        ORDER BY st.opened_at DESC LIMIT 1
      `).get(session?.userId || 0) as {
        id: number; cash_total: number; card_total: number;
        sale_count: number; tax_total: number; opened_at: string; username: string;
      } | undefined;

      const openedAt = shift?.opened_at || DateTime.now().setZone(TZ).startOf('day').toISO() as string;
      const cashierName = shift?.username || session?.username || 'Unknown';

      const report = buildFullReport(db, openedAt, cashierName);
      return { success: true, report };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('xzout:zReport', async (_event, pin: string) => {
    try {
      const db = getDb();
      const session = getCurrentSession();

      if (session?.role !== 'manager') {
        return { success: false, error: 'Manager access required' };
      }

      const user = db.prepare('SELECT password_hash, username FROM users WHERE id = ?').get(session.userId) as { password_hash: string; username: string } | undefined;
      if (!user || !bcrypt.compareSync(pin, user.password_hash)) {
        return { success: false, error: 'Invalid PIN' };
      }

      const shift = db.prepare(`
        SELECT * FROM shift_totals
        WHERE cashier_id = ? AND closed_at IS NULL
        ORDER BY opened_at DESC LIMIT 1
      `).get(session.userId) as {
        id: number; opened_at: string;
      } | undefined;

      const openedAt = shift?.opened_at || DateTime.now().setZone(TZ).startOf('day').toISO() as string;
      const report = buildFullReport(db, openedAt, user.username);

      if (shift) {
        const closedAt = nowCT();
        db.prepare(`UPDATE shift_totals SET closed_at = ? WHERE id = ?`).run(closedAt, shift.id);
        db.prepare(`INSERT INTO shift_totals (cashier_id, opened_at) VALUES (?, ?)`).run(session.userId, closedAt);
      }

      // The Z-report is the explicit end-of-day close-out: end the business-day
      // session so the next sign-in again requires a manager username + password.
      closeDay(db);

      // Save Z report to database
      const zRes = db.prepare(`
        INSERT INTO z_reports
          (generated_at, generated_by, shift_opened_at, cash_total, card_total, split_total,
           sale_count, tax_total, discount_total, gross_sales, net_sales, report_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        report.generated_at,
        session.userId,
        report.shift_opened_at,
        report.cash_total,
        report.card_total,
        report.split_total,
        report.sale_count,
        report.tax_total,
        report.discount_total,
        report.gross_sales,
        report.net_sales,
        JSON.stringify(report)
      );

      // Tip-pool audit trail (batch 5): one ledger row per business day, at
      // close — the durable record of the fee rate + deduction actually used,
      // not just the report_json snapshot above.
      try { saveTipPoolLedger(db, report.shift_opened_at.substring(0, 10), Number(zRes.lastInsertRowid), report.tip_pool); }
      catch (e) { console.error('[tip pool] failed to save audit ledger:', e); }

      return { success: true, report };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
