// Client-side step validation (inline errors). The database re-validates everything on submit
// (app_submit), so these rules are for guidance and must stay at least as lenient as the server's.

import type { ApplicationDto, LicenseDto, LocationDto, OwnerDto, Operations } from './types';

export type Errors = Record<string, string>;

/** Same rule as functions/_lib/crypto normalizeEin (kept separate so the browser bundle stays free of server code). */
const normalizeEin = (v: string) => /^\s*\d{2}-?\d{7}\s*$/.test(v);

export const isEmail = (v: string | null | undefined) => !!v && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim());
export const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
export const isPhone = (v: string | null | undefined) => {
  const d = digits(v);
  return d.length === 10 || (d.length === 11 && d.startsWith('1'));
};
export const isZip = (v: string | null | undefined) => /^\d{5}(-\d{4})?$/.test((v ?? '').trim());
export const isState = (v: string | null | undefined) => /^[A-Za-z]{2}$/.test((v ?? '').trim());
export const isUrl = (v: string | null | undefined) => {
  if (!v || !v.trim()) return true; // optional
  try {
    const u = new URL(/^https?:\/\//i.test(v.trim()) ? v.trim() : `https://${v.trim()}`);
    return u.hostname.includes('.');
  } catch {
    return false;
  }
};

const req = (e: Errors, key: string, v: string | null | undefined, msg: string) => {
  if (!v || !v.trim()) e[key] = msg;
};

/** yyyy-mm-dd compared as strings against today's local date. */
export function isPast(dateStr: string, today = new Date()): boolean {
  const t = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return dateStr < t;
}

export function daysUntil(dateStr: string, today = new Date()): number {
  const d = new Date(`${dateStr}T00:00:00`);
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((d.getTime() - t.getTime()) / 86400000);
}

export function validateAccount(a: Pick<ApplicationDto, 'full_name' | 'email' | 'phone' | 'contact_role'>): Errors {
  const e: Errors = {};
  if (!a.full_name || a.full_name.trim().length < 2) e.full_name = 'Enter your full name.';
  if (!isEmail(a.email)) e.email = 'Enter a valid email address.';
  if (!isPhone(a.phone)) e.phone = 'Enter a 10-digit mobile number.';
  if (!a.contact_role) e.contact_role = 'Choose your role.';
  return e;
}

export function validateBusiness(a: ApplicationDto, einInput: string): Errors {
  const e: Errors = {};
  req(e, 'legal_name', a.legal_name, 'Enter the legal business name.');
  if (!a.entity_type) e.entity_type = 'Choose an entity type.';
  if (einInput.trim()) {
    if (!normalizeEin(einInput)) e.ein = 'Enter the EIN as 9 digits, like 12-3456789.';
  } else if (!a.ein_set) {
    e.ein = 'Enter the business EIN.';
  }
  if (a.years_in_business == null || Number.isNaN(a.years_in_business) || a.years_in_business < 0 || a.years_in_business > 200) {
    e.years_in_business = 'Enter years in business (0 or more).';
  }
  if (!isEmail(a.business_email)) e.business_email = 'Enter a valid business email.';
  if (!isPhone(a.business_phone)) e.business_phone = 'Enter a 10-digit business phone.';
  if (!isUrl(a.website)) e.website = 'Enter a valid website, like example.com.';
  const m = a.mailing_address ?? {};
  req(e, 'mailing_street', m.street, 'Enter the mailing street address.');
  req(e, 'mailing_city', m.city, 'Enter the city.');
  if (!isState(m.state)) e.mailing_state = 'Use the 2-letter state.';
  if (!isZip(m.zip)) e.mailing_zip = 'Enter a 5-digit ZIP.';
  if (!a.location_count || a.location_count < 1) e.location_count = 'Enter how many locations you have.';
  return e;
}

function licenseOf(l: LocationDto, kind: LicenseDto['kind']): LicenseDto | undefined {
  return l.licenses.find((x) => x.kind === kind);
}

export function validateLocations(locs: LocationDto[]): Errors {
  const e: Errors = {};
  if (locs.length === 0) e['locations'] = 'Add at least one location.';
  for (const l of locs) {
    const p = `loc.${l.id}`;
    req(e, `${p}.name`, l.name, 'Name this location.');
    req(e, `${p}.street`, l.street, 'Enter the street address.');
    req(e, `${p}.city`, l.city, 'Enter the city.');
    if (!isState(l.state)) e[`${p}.state`] = 'Use the 2-letter state.';
    if (!isZip(l.zip)) e[`${p}.zip`] = 'Enter a 5-digit ZIP.';
    if (!isPhone(l.phone)) e[`${p}.phone`] = 'Enter a 10-digit phone.';

    const checkPermit = (kind: LicenseDto['kind'], label: string, needExpiry: boolean, required: boolean) => {
      const lic = licenseOf(l, kind);
      if (!lic) {
        if (required) e[`${p}.${kind}.number`] = `${label} is required.`;
        return;
      }
      const k = `${p}.${kind}`;
      req(e, `${k}.number`, lic.number, `Enter the ${label} number.`);
      if (needExpiry) {
        if (!lic.expiry) e[`${k}.expiry`] = 'Enter the expiry date.';
        else if (isPast(lic.expiry)) e[`${k}.expiry`] = 'This permit is expired. Permits must be current.';
      } else if (lic.expiry && isPast(lic.expiry)) {
        e[`${k}.expiry`] = 'This permit is expired. Permits must be current.';
      }
      if (!lic.document_id) e[`${k}.document`] = 'Upload a copy of the permit.';
    };
    checkPermit('tx_ecig', 'Texas E-Cigarette Retailer Permit', true, true);
    checkPermit('sales_tax', 'sales tax permit', false, true);
    if (licenseOf(l, 'tobacco')) checkPermit('tobacco', 'tobacco/cigarette permit', true, false);
    if (licenseOf(l, 'tabc')) checkPermit('tabc', 'TABC permit', true, false);
  }
  return e;
}

export function validateOwners(owners: OwnerDto[]): Errors {
  const e: Errors = {};
  if (owners.length === 0) e['owners'] = 'Add at least one owner.';
  const controls = owners.filter((o) => o.is_control_person).length;
  if (owners.length && controls !== 1) e['control'] = 'Choose exactly one control person.';
  const total = owners.reduce((s, o) => s + (Number(o.ownership_pct) || 0), 0);
  if (total > 100) e['total'] = 'Ownership adds up to more than 100%.';
  for (const o of owners) {
    const p = `owner.${o.id}`;
    req(e, `${p}.full_name`, o.full_name, 'Enter the owner’s full name.');
    const pct = Number(o.ownership_pct);
    if (Number.isNaN(pct) || pct < 0 || pct > 100) e[`${p}.ownership_pct`] = 'Enter a percentage from 0 to 100.';
    if ((pct >= 25 || o.is_control_person) && !o.id_document_id) e[`${p}.id`] = 'Upload a photo ID.';
  }
  return e;
}

export function validateOperations(ops: Operations): Errors {
  const e: Errors = {};
  if (!ops.current_pos?.trim()) e.current_pos = 'Tell us what POS you use now (or “none”).';
  if (!ops.current_processor?.trim()) e.current_processor = 'Tell us your current processor (or “cash only”).';
  if (!ops.monthly_sales_range) e.monthly_sales_range = 'Choose a range.';
  if (ops.card_pct == null || ops.card_pct < 0 || ops.card_pct > 100) e.card_pct = 'Enter a percentage from 0 to 100.';
  if (ops.avg_ticket == null || ops.avg_ticket <= 0) e.avg_ticket = 'Enter your average ticket in dollars.';
  if (!ops.product_mix || ops.product_mix.length === 0) e.product_mix = 'Choose at least one.';
  if (!ops.registers || ops.registers < 1) e.registers = 'Enter at least 1.';
  if (ops.employees == null || ops.employees < 0) e.employees = 'Enter the number of employees.';
  return e;
}

export function validatePlan(a: Pick<ApplicationDto, 'plan_model'>): Errors {
  return a.plan_model ? {} : { plan_model: 'Choose a plan.' };
}

export function validateAgreements(v: { typedName: string; agree: boolean; compliance: boolean }): Errors {
  const e: Errors = {};
  if (v.typedName.trim().length < 2) e.typedName = 'Type your full legal name to sign.';
  if (!v.agree) e.agree = 'You must agree to both documents to continue.';
  if (!v.compliance) e.compliance = 'You must acknowledge the 21+ and compliance statement.';
  return e;
}

export const firstError = (e: Errors): string | null => Object.keys(e)[0] ?? null;
