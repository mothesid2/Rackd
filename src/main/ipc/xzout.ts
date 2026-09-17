import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import bcrypt from 'bcryptjs';
import { nowCT, getBusinessTZ, businessDayBounds, currentBusinessDate, currentBusinessDayWindow } from '../utils/time';
import { DateTime } from 'luxon';
import { getSupabase } from '../supabase/client';
import { getLocationId, getTenantId, enqueueZReport, triggerSyncNow } from '../supabase/sync';
import { userHasPermission } from '../permissions';
import { closeDay, dayInfo } from '../daySession';
import { printZReport, printPeriodReport } from '../services/printer';


function canViewReports(): boolean {
  const s = getCurrentSession();
  if (!s) return false;
  if (s.role === 'manager') return true;
  return userHasPermission(getDb(), s.userId, 'view_reports').granted;
}
const REPORTS_DENIED = { success: false as const, error: 'You do not have permission to view reports' };

interface FullReport {
  generated_at: string;
  shift_opened_at: string;
  cashier_name: string;
  
  gross_sales: number;
  discount_total: number;
  tax_total: number;
  net_sales: number;
  
  cash_total: number;
  card_total: number;
  split_total: number;
  online_total: number; 
  
  
  
  
  
  by_card_brand: { brand: string; amount: number; count: number }[];
  sale_count: number;
  avg_ticket: number;
  
  by_category: { category: string; qty: number; revenue: number }[];
  
  top_products: { name: string; qty: number; revenue: number }[];
  
  by_hour: { hour: number; label: string; count: number; revenue: number }[];
  
  tip_pool: TipPool;
  
  
  
  
  card_processing_fee_pct: number;
  card_processing_fee_flat_cents: number;
  card_processing_fee_amount: number;
}


export function buildFullReport(db: ReturnType<typeof import('../db/schema').getDb>, shiftOpenedAt: string, cashierName: string): FullReport {
  
  
  
  
  
  
  
  
  
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
    WHERE created_at >= ? AND payment_status = 'completed'
  `).get(shiftOpenedAt) as {
    gross_sales: number; discount_total: number; tax_total: number; net_sales: number;
    cash_total: number; card_total: number; split_total: number; online_total: number; sale_count: number; card_txn_count: number;
  };

  
  
  
  const payRows = db.prepare(`
    SELECT payment_method, card_type, SUM(total) AS amount, COUNT(*) AS cnt
    FROM transactions
    WHERE created_at >= ? AND payment_status = 'completed'
      AND COALESCE(order_source, 'in_store') <> 'online'
    GROUP BY payment_method, card_type
  `).all(shiftOpenedAt) as { payment_method: string; card_type: string | null; amount: number; cnt: number }[];
  const brandMap: Record<string, { amount: number; count: number }> = {
    Visa: { amount: 0, count: 0 }, Mastercard: { amount: 0, count: 0 },
    Discover: { amount: 0, count: 0 }, Amex: { amount: 0, count: 0 }, Other: { amount: 0, count: 0 },
  };
  for (const r of payRows) {
    if (r.payment_method === 'cash') continue;
    const b = normalizeBrand(r.card_type);
    brandMap[b].amount += r.amount; brandMap[b].count += r.cnt;
  }
  const byCardBrand = ['Visa', 'Mastercard', 'Discover', 'Amex', 'Other']
    .map(b => ({ brand: b, ...brandMap[b] }))
    .filter(b => b.count > 0);

  const byCategory = db.prepare(`
    SELECT
      COALESCE(p.category, ti.category, 'Uncategorized') AS category,
      SUM(ti.qty) AS qty,
      SUM(ti.line_total) AS revenue
    FROM transaction_items ti
    LEFT JOIN products p ON ti.product_id = p.id
    JOIN transactions t ON ti.transaction_id = t.id
    WHERE t.created_at >= ? AND t.payment_status = 'completed'
    GROUP BY COALESCE(p.category, ti.category, 'Uncategorized')
    ORDER BY revenue DESC
  `).all(shiftOpenedAt) as { category: string; qty: number; revenue: number }[];

  const topProducts = db.prepare(`
    SELECT
      p.name,
      SUM(ti.qty) AS qty,
      SUM(ti.line_total) AS revenue
    FROM transaction_items ti
    JOIN products p ON ti.product_id = p.id
    JOIN transactions t ON ti.transaction_id = t.id
    WHERE t.created_at >= ? AND t.payment_status = 'completed'
    GROUP BY ti.product_id
    ORDER BY revenue DESC
    LIMIT 5
  `).all(shiftOpenedAt) as { name: string; qty: number; revenue: number }[];

  
  
  
  const hourlyRaw = db.prepare(`
    SELECT
      CAST(substr(created_at, 12, 2) AS INTEGER) AS hour,
      COUNT(*) AS count,
      SUM(total) AS revenue
    FROM transactions
    WHERE created_at >= ? AND payment_status = 'completed'
    GROUP BY hour
    ORDER BY hour
  `).all(shiftOpenedAt) as { hour: number; count: number; revenue: number }[];

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
    by_card_brand: byCardBrand,
    sale_count: summary.sale_count,
    avg_ticket: summary.sale_count > 0 ? summary.net_sales / summary.sale_count : 0,
    by_category: byCategory,
    top_products: topProducts,
    by_hour: byHour,
    tip_pool: computeTipPoolWindow(db, shiftOpenedAt, null),
    card_processing_fee_pct: fees.effectivePct,
    card_processing_fee_flat_cents: fees.flatCents,
    card_processing_fee_amount: Math.round(((summary.card_total + summary.split_total) * (fees.effectivePct / 100) + summary.card_txn_count * (fees.flatCents / 100)) * 100) / 100,
  };
}


export async function buildFullReportLocation(
  db: ReturnType<typeof import('../db/schema').getDb>,
  supabase: NonNullable<ReturnType<typeof import('../supabase/client').getSupabase>>,
  shiftOpenedAt: string,
  cashierName: string
): Promise<FullReport | null> {
  try {
    const tenantId = getTenantId(db);
    const locationId = getLocationId(db);
    if (!locationId) return null;

    const { data, error } = await supabase.rpc('location_report_core_window', {
      p_tenant: tenantId, p_location: locationId, p_start: shiftOpenedAt, p_end: nowCT(),
    });
    if (error || !data) return null;

    const s = data.summary as Record<string, number>;
    const p = data.payments as { cash: number; brands: { brand: string; amount: number; count: number }[]; other_card: { amount: number; count: number }; card_total: number };
    const byCardBrand = [...p.brands, ...(p.other_card.count > 0 ? [{ brand: 'Other', ...p.other_card }] : [])].filter((b) => b.count > 0);

    return {
      generated_at: nowCT(),
      shift_opened_at: shiftOpenedAt,
      cashier_name: cashierName,
      gross_sales: s.gross,
      discount_total: s.discounts,
      tax_total: s.tax,
      net_sales: s.total_collected,
      cash_total: p.cash,
      card_total: p.card_total,
      split_total: s.split_total ?? 0,
      online_total: s.online_total ?? 0,
      by_card_brand: byCardBrand,
      sale_count: s.count,
      avg_ticket: s.avg,
      by_category: (data.by_category as FullReport['by_category']) ?? [],
      top_products: (data.top_products as FullReport['top_products']) ?? [],
      by_hour: [], 
      tip_pool: computeTipPoolWindow(db, shiftOpenedAt, null), 
      card_processing_fee_pct: s.merchant_fee_pct,
      card_processing_fee_flat_cents: s.merchant_fee_flat_cents ?? 0,
      card_processing_fee_amount: s.merchant_fee_amount,
    };
  } catch {
    return null;
  }
}


async function buildZReportData(
  db: ReturnType<typeof import('../db/schema').getDb>,
  shiftOpenedAt: string,
  cashierName: string
): Promise<FullReport> {
  const supabase = getSupabase();
  if (supabase) {
    const locationReport = await buildFullReportLocation(db, supabase, shiftOpenedAt, cashierName);
    if (locationReport) return locationReport;
  }
  return buildFullReport(db, shiftOpenedAt, cashierName);
}

interface MerchantFeeRates { creditPct: number; debitPct: number; effectivePct: number; flatCents: number }


function merchantFeeRates(db: ReturnType<typeof import('../db/schema').getDb>): MerchantFeeRates {
  const get = (key: string) => {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return Number(row?.value) || 0;
  };
  const creditPct = Math.max(0, Math.min(100, get('merchant_fee_credit_pct')));
  const debitPct = Math.max(0, Math.min(100, get('merchant_fee_debit_pct')));
  const flatCents = Math.max(0, get('merchant_fee_flat_cents'));
  
  
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


const MANAGEMENT_ROLES = new Set(['admin', 'manager']);


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



export function computeTipPoolWindow(db: ReturnType<typeof import('../db/schema').getDb>, startIso: string, endIso: string | null): TipPool {
  const txnClause = endIso ? `created_at >= ? AND created_at < ?` : `created_at >= ?`;
  const txnParams = endIso ? [startIso, endIso] : [startIso];
  const punchClause = endIso ? `clock_in >= ? AND clock_in < ?` : `clock_in >= ?`;
  const punchParams = endIso ? [startIso, endIso] : [startIso];
  const directClause = endIso ? `t.created_at >= ? AND t.created_at < ?` : `t.created_at >= ?`;
  const directParams = endIso ? [startIso, endIso] : [startIso];
  return computeTipPoolInternal(db, txnClause, txnParams, punchClause, punchParams, directClause, directParams);
}

function computeTipPoolInternal(
  db: ReturnType<typeof import('../db/schema').getDb>,
  txnClause: string, txnParams: (string | number)[],
  punchClause: string, punchParams: (string | number)[],
  directClause: string, directParams: (string | number)[],
): TipPool {
  const tipRow = db.prepare(
    `SELECT COALESCE(SUM(tip_amount), 0) AS total,
            COALESCE(SUM(CASE WHEN payment_method IN ('card','split') THEN tip_amount ELSE 0 END), 0) AS card_total,
            COALESCE(SUM(CASE WHEN payment_method IN ('card','split') AND tip_amount > 0 THEN 1 ELSE 0 END), 0) AS card_tip_txns
     FROM transactions WHERE ${txnClause} AND payment_status = 'completed'`
  ).get(...txnParams) as { total: number; card_total: number; card_tip_txns: number };
  const totalTips = Math.round((tipRow.total || 0) * 100) / 100;
  const cardTipTotal = Math.round((tipRow.card_total || 0) * 100) / 100;
  const cardTipTxnCount = tipRow.card_tip_txns || 0;

  const fees = merchantFeeRates(db);

  
  
  const roleByUid = new Map<string, string>();
  for (const u of db.prepare('SELECT uid, role FROM users WHERE uid IS NOT NULL').all() as { uid: string; role: string }[]) {
    roleByUid.set(u.uid, u.role);
  }

  const punches = db.prepare(
    `SELECT employee_uid, employee_name, clock_in, clock_out FROM time_clock WHERE ${punchClause}`
  ).all(...punchParams) as { employee_uid: string; employee_name: string | null; clock_in: string; clock_out: string | null }[];

  const nowMs = Date.now();
  const eligibleHours = new Map<string, { name: string; hours: number }>();
  for (const p of punches) {
    const role = roleByUid.get(p.employee_uid);
    if (!role || MANAGEMENT_ROLES.has(role)) continue; 
    const inMs = new Date(p.clock_in).getTime();
    const outMs = p.clock_out ? new Date(p.clock_out).getTime() : nowMs;
    const hrs = Math.max(0, (outMs - inMs) / 3_600_000);
    const cur = eligibleHours.get(p.employee_uid) || { name: p.employee_name || 'Employee', hours: 0 };
    cur.hours += hrs;
    eligibleHours.set(p.employee_uid, cur);
  }
  const totalHours = [...eligibleHours.values()].reduce((s, e) => s + e.hours, 0);

  if (totalHours <= 0) {
    
    
    
    const direct = db.prepare(
      `SELECT t.cashier_id AS uid, COALESCE(SUM(t.tip_amount), 0) AS total
       FROM transactions t
       WHERE ${directClause} AND t.payment_status = 'completed' AND t.tip_amount > 0
       GROUP BY t.cashier_id`
    ).all(...directParams) as { uid: number | null; total: number }[];
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


export function buildPeriodReport(db: ReturnType<typeof import('../db/schema').getDb>, startDate: string, endDate: string) {
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const today = currentBusinessDate(db);
  const start = startDate === today ? currentBusinessDayWindow(db).start : businessDayBounds(startDate, db).start;
  const end = businessDayBounds(endDate, db).end;
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
    WHERE created_at >= ? AND created_at < ? AND payment_status = 'completed'
  `).get(start, end) as {
    gross: number; discounts: number; net_presubtax: number; tax: number; total_collected: number; count: number;
  };

  const payRows = db.prepare(`
    SELECT payment_method, card_type, SUM(total) AS amount, COUNT(*) AS cnt
    FROM transactions
    WHERE created_at >= ? AND created_at < ? AND payment_status = 'completed'
      AND COALESCE(order_source, 'in_store') <> 'online'
    GROUP BY payment_method, card_type
  `).all(start, end) as { payment_method: string; card_type: string | null; amount: number; cnt: number }[];

  
  const onlineRow = db.prepare(`
    SELECT COALESCE(SUM(total), 0) AS amount, COUNT(*) AS cnt
    FROM transactions
    WHERE created_at >= ? AND created_at < ? AND payment_status = 'completed' AND order_source = 'online'
  `).get(start, end) as { amount: number; cnt: number };

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
    WHERE t.created_at >= ? AND t.created_at < ? AND t.payment_status = 'completed'
    GROUP BY COALESCE(p.category, ti.category, 'Uncategorized')
    ORDER BY revenue DESC
  `).all(start, end) as { category: string; qty: number; revenue: number }[];

  const topProducts = db.prepare(`
    SELECT COALESCE(p.name || ' - ' || v.label, p.name) AS name,
           SUM(ti.qty) AS qty, SUM(ti.line_total) AS revenue
    FROM transaction_items ti
    JOIN products p ON ti.product_id = p.id
    LEFT JOIN product_variants v ON ti.variant_id = v.id
    JOIN transactions t ON ti.transaction_id = t.id
    WHERE t.created_at >= ? AND t.created_at < ? AND t.payment_status = 'completed'
    GROUP BY ti.product_id, ti.variant_id
    ORDER BY revenue DESC
    LIMIT 5
  `).all(start, end) as { name: string; qty: number; revenue: number }[];

  
  const unitsRow = db.prepare(`
    SELECT COALESCE(SUM(ti.qty), 0) AS units
    FROM transaction_items ti JOIN transactions t ON ti.transaction_id = t.id
    WHERE t.created_at >= ? AND t.created_at < ? AND t.payment_status = 'completed' AND ti.qty > 0
  `).get(start, end) as { units: number };

  const refundRow = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
    FROM transactions
    WHERE created_at >= ? AND created_at < ? AND payment_status = 'completed' AND total < 0
  `).get(start, end) as { count: number; total: number };

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
    tip_pool: computeTipPoolWindow(db, start, end),
    card_processing_fee_pct: fees.effectivePct,
    card_processing_fee_flat_cents: fees.flatCents,
    card_processing_fee_amount: Math.round((cardTotal * (fees.effectivePct / 100) + cardCount * (fees.flatCents / 100)) * 100) / 100,
  };
}

export function registerXZOutHandlers(): void {
  
  ipcMain.handle('xzout:periodReport', async (_event, opts?: { start?: string; end?: string }) => {
    try {
      if (!canViewReports()) return REPORTS_DENIED;
      const db = getDb();
      
      
      
      const start = opts?.start || currentBusinessDate(db);
      const end = opts?.end || start;
      const label = start === end
        ? DateTime.fromISO(start, { zone: getBusinessTZ() }).toFormat('MMM d, yyyy')
        : `${DateTime.fromISO(start, { zone: getBusinessTZ() }).toFormat('MMM d, yyyy')} — ${DateTime.fromISO(end, { zone: getBusinessTZ() }).toFormat('MMM d, yyyy')}`;

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


  
  
  
  
  ipcMain.handle('xzout:locationPeriodReport', async (_event, opts?: { start?: string; end?: string }) => {
    try {
      if (!canViewReports()) return REPORTS_DENIED;
      const db = getDb();
      const start = opts?.start || currentBusinessDate(db);
      const end = opts?.end || start;
      const label = start === end
        ? DateTime.fromISO(start, { zone: getBusinessTZ() }).toFormat('MMM d, yyyy')
        : `${DateTime.fromISO(start, { zone: getBusinessTZ() }).toFormat('MMM d, yyyy')} — ${DateTime.fromISO(end, { zone: getBusinessTZ() }).toFormat('MMM d, yyyy')}`;

      if (!getLocationId()) return { success: false, error: 'This register is not assigned to a location yet.' };
      const supabase = getSupabase();
      if (!supabase) return { success: false, error: 'Cloud not configured — location totals need internet.' };

      
      
      
      
      
      
      
      
      
      
      
      
      
      
      
      const { start: startTs } = businessDayBounds(start, db);
      const { end: endTs } = businessDayBounds(end, db);
      const { data, error } = await supabase.rpc('location_period_report_window', { p_start: startTs, p_end: endTs });
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

      const info = dayInfo(db);
      
      
      
      const openedAt = currentBusinessDayWindow(db).start;
      const cashierName = info.openedByName || session?.username || 'Unknown';

      const report = await buildZReportData(db, openedAt, cashierName);
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

      
      
      
      
      
      
      
      
      
      
      
      
      
      const openedAt = currentBusinessDayWindow(db).start;
      
      
      
      const report = await buildZReportData(db, openedAt, user.username);

      
      
      
      
      
      
      const closedAt = nowCT();
      db.prepare(`UPDATE shift_totals SET closed_at = ? WHERE closed_at IS NULL`).run(closedAt);
      db.prepare(`INSERT INTO shift_totals (cashier_id, opened_at) VALUES (?, ?)`).run(session.userId, closedAt);

      
      
      closeDay(db);

      
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

      
      
      
      try { saveTipPoolLedger(db, report.shift_opened_at.substring(0, 10), Number(zRes.lastInsertRowid), report.tip_pool); }
      catch (e) { console.error('[tip pool] failed to save audit ledger:', e); }

      
      
      try { enqueueZReport(Number(zRes.lastInsertRowid), db); } catch (e) { console.warn('[z-report] failed to enqueue cloud sync:', e); }

      return { success: true, report };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  
  
  
  
  ipcMain.handle('xzout:printZReport', async (_event, report: Record<string, unknown>) => {
    try {
      const session = getCurrentSession();
      if (session?.role !== 'manager') return { success: false, error: 'Manager access required' };
      if (!report || typeof report !== 'object') return { success: false, error: 'Missing report' };
      const db = getDb();
      const config = db.prepare('SELECT * FROM receipt_config WHERE id = 1').get() as Record<string, unknown>;
      return await printZReport(report, config || {});
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  
  
  
  
  
  
  
  
  
  
  ipcMain.handle('xzout:printClosingSummary', async () => {
    try {
      if (!canViewReports()) return REPORTS_DENIED;
      const db = getDb();
      const session = getCurrentSession();

      const info = dayInfo(db);
      const openedAt = currentBusinessDayWindow(db).start;
      const report = await buildZReportData(db, openedAt, info.openedByName || session?.username || 'Staff');

      const config = db.prepare('SELECT * FROM receipt_config WHERE id = 1').get() as Record<string, unknown>;
      const res = await printZReport(report as unknown as Record<string, unknown>, config || {}, { preview: true });
      return { ...res, report };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  
  
  
  
  ipcMain.handle('xzout:printPeriodReport', async (_event, report: Record<string, unknown>) => {
    try {
      if (!canViewReports()) return REPORTS_DENIED;
      if (!report || typeof report !== 'object') return { success: false, error: 'Missing report' };
      const db = getDb();
      const config = db.prepare('SELECT * FROM receipt_config WHERE id = 1').get() as Record<string, unknown>;
      return await printPeriodReport(report, config || {});
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}


export async function runAutomaticZReport(db: ReturnType<typeof import('../db/schema').getDb> = getDb()): Promise<{ success: boolean; error?: string }> {
  try {
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    try { await triggerSyncNow(); } catch {  }

    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    const openedAt = currentBusinessDayWindow(db, DateTime.now().minus({ minutes: 2 })).start;
    const report = await buildZReportData(db, openedAt, 'Automatic batch close-out');

    
    
    
    
    
    
    
    
    
    
    db.prepare(`UPDATE shift_totals SET closed_at = ? WHERE closed_at IS NULL`).run(nowCT());

    closeDay(db);

    const zRes = db.prepare(`
      INSERT INTO z_reports
        (generated_at, generated_by, shift_opened_at, cash_total, card_total, split_total,
         sale_count, tax_total, discount_total, gross_sales, net_sales, report_json)
      VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      report.generated_at, report.shift_opened_at, report.cash_total, report.card_total, report.split_total,
      report.sale_count, report.tax_total, report.discount_total, report.gross_sales, report.net_sales,
      JSON.stringify(report)
    );

    try { saveTipPoolLedger(db, report.shift_opened_at.substring(0, 10), Number(zRes.lastInsertRowid), report.tip_pool); }
    catch (e) { console.error('[batch] failed to save tip pool ledger:', e); }

    try { enqueueZReport(Number(zRes.lastInsertRowid), db); } catch (e) { console.warn('[batch] failed to enqueue z-report cloud sync:', e); }

    const config = db.prepare('SELECT * FROM receipt_config WHERE id = 1').get() as Record<string, unknown>;
    const printRes = await printZReport(report as unknown as Record<string, unknown>, config || {});
    if (!printRes.success) console.error('[batch] Z report print failed:', printRes.error);

    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}
