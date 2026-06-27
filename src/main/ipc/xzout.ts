import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import bcrypt from 'bcryptjs';
import { nowCT } from '../utils/time';
import { DateTime } from 'luxon';

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
  sale_count: number;
  avg_ticket: number;
  // Category summary
  by_category: { category: string; qty: number; revenue: number }[];
  // Top products
  top_products: { name: string; qty: number; revenue: number }[];
  // Hourly breakdown
  by_hour: { hour: number; label: string; count: number; revenue: number }[];
}

function buildFullReport(db: ReturnType<typeof import('../db/schema').getDb>, shiftOpenedAt: string, cashierName: string): FullReport {
  // Use only the date portion (YYYY-MM-DD) for comparison to avoid timezone format mismatches.
  // created_at is stored as ISO 8601 (e.g. "2026-04-12T14:30:00.000-05:00"),
  // so substr(created_at,1,10) reliably gives the local date.
  const openDate = shiftOpenedAt.substring(0, 10); // 'YYYY-MM-DD'

  const summary = db.prepare(`
    SELECT
      COALESCE(SUM(subtotal + discount_amount), 0) AS gross_sales,
      COALESCE(SUM(discount_amount), 0) AS discount_total,
      COALESCE(SUM(tax_amount), 0) AS tax_total,
      COALESCE(SUM(total), 0) AS net_sales,
      COALESCE(SUM(CASE WHEN payment_method='cash' THEN total ELSE 0 END), 0) AS cash_total,
      COALESCE(SUM(CASE WHEN payment_method='card' THEN total ELSE 0 END), 0) AS card_total,
      COALESCE(SUM(CASE WHEN payment_method='split' THEN total ELSE 0 END), 0) AS split_total,
      COUNT(*) AS sale_count
    FROM transactions
    WHERE substr(created_at, 1, 10) >= ? AND payment_status = 'completed'
  `).get(openDate) as {
    gross_sales: number; discount_total: number; tax_total: number; net_sales: number;
    cash_total: number; card_total: number; split_total: number; sale_count: number;
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
    sale_count: summary.sale_count,
    avg_ticket: summary.sale_count > 0 ? summary.net_sales / summary.sale_count : 0,
    by_category: byCategory,
    top_products: topProducts,
    by_hour: byHour,
  };
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
    GROUP BY payment_method, card_type
  `).all(startDate, endDate) as { payment_method: string; card_type: string | null; amount: number; cnt: number }[];

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
    payments: { cash, cash_count: cashCount, brands, other_card: otherCard, card_total: cardTotal },
    by_category: byCategory,
    top_products: topProducts,
    refunds: { count: refundRow.count, total: refundRow.total },
  };
}

export function registerXZOutHandlers(): void {
  // Sales report for a chosen date range (used by both X report and Audit).
  ipcMain.handle('xzout:periodReport', async (_event, opts?: { start?: string; end?: string }) => {
    try {
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

      // Save Z report to database
      db.prepare(`
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

      return { success: true, report };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
