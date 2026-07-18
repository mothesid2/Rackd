import type { Formatter, ReportRow, ReportContext } from './index.ts';

function csv(v: unknown): string {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Generic scan-data CSV. Reasonable, documented columns until a manufacturer's
// certified spec is dropped into its own formatter. One row per applied rebate.
export const generic: Formatter = {
  filename(ctx: ReportContext): string {
    const code = ctx.manufacturer.parent_company_code || 'MFR';
    return `${code}_${ctx.tenant_id.slice(0, 8)}_${ctx.period_start}_${ctx.period_end}.csv`;
  },
  format(rows: ReportRow[], ctx: ReportContext): string {
    const header = [
      'store_id', 'location_id', 'period_start', 'period_end', 'sold_at', 'upc',
      'discount_amount', 'manufacturer_funded', 'auto_applied', 'transaction_id',
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
      lines.push([
        ctx.tenant_id, r.location_id ?? '', ctx.period_start, ctx.period_end, r.applied_at,
        r.barcode ?? '', (Number(r.discount_amount) || 0).toFixed(2),
        r.is_manufacturer_funded ? 'Y' : 'N', r.was_auto_applied ? 'Y' : 'N', r.transaction_id ?? '',
      ].map(csv).join(','));
    }
    return lines.join('\r\n') + '\r\n';
  },
};
