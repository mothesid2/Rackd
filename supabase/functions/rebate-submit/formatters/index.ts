


export interface ReportRow {
  applied_at: string;
  barcode: string | null;
  discount_amount: number;
  is_manufacturer_funded: boolean;
  was_auto_applied: boolean;
  rebate_rule_uid: string | null;
  transaction_id: number | null;
  location_id: string | null;
  register_id: string | null;
}

export interface ReportContext {
  manufacturer: { uid: string; name: string; parent_company_code: string | null };
  tenant_id: string;
  period_start: string;
  period_end: string;
}

export interface Formatter {
  filename(ctx: ReportContext): string;
  format(rows: ReportRow[], ctx: ReportContext): string;
}

import { generic } from './generic.ts';
import { altria } from './altria.ts';
import { rjr } from './rjr.ts';
import { itg } from './itg.ts';


export function getFormatter(code: string | null): Formatter {
  switch ((code || '').toUpperCase()) {
    case 'PM': return altria;
    case 'RJRT': return rjr;
    case 'ITG': return itg;
    default: return generic;
  }
}
