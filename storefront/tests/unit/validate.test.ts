import { describe, expect, it } from 'vitest';
import type { ApplicationDto, LocationDto, OwnerDto } from '../../lib/onboarding/types';
import {
  daysUntil, isEmail, isPast, isPhone, isUrl, isZip, validateAccount, validateAgreements, validateBusiness,
  validateLocations, validateOperations, validateOwners, validatePlan,
} from '../../lib/onboarding/validate';

const app = (o: Partial<ApplicationDto> = {}): ApplicationDto => ({
  id: 'a', status: 'draft', full_name: 'Alice A', email: 'a@b.co', email_verified_at: 'x', phone: '5125550100', contact_role: 'owner',
  legal_name: 'Acme LLC', dba: null, entity_type: 'llc', ein_set: false, ein_last4: null, years_in_business: 3,
  business_email: 'biz@acme.co', business_phone: '5125550101', website: null,
  mailing_address: { street: '1 Main', city: 'Austin', state: 'TX', zip: '78701' }, location_count: 1,
  operations: {}, plan_model: null, addons: [], hardware_selection: null, compliance_ack_at: null, current_step: 2,
  info_request: null, submitted_at: null, ...o,
});

describe('primitives', () => {
  it('email / phone / zip / url', () => {
    expect(isEmail('a@b.co')).toBe(true);
    expect(isEmail('a@b')).toBe(false);
    expect(isPhone('(512) 555-0100')).toBe(true);
    expect(isPhone('1-512-555-0100')).toBe(true);
    expect(isPhone('555-0100')).toBe(false);
    expect(isZip('78701')).toBe(true);
    expect(isZip('78701-1234')).toBe(true);
    expect(isZip('7870')).toBe(false);
    expect(isUrl('')).toBe(true);
    expect(isUrl('acme.co')).toBe(true);
    expect(isUrl('not a url')).toBe(false);
  });
  it('date helpers use the local calendar day', () => {
    const today = new Date(2026, 9, 24);
    expect(isPast('2026-10-23', today)).toBe(true);
    expect(isPast('2026-10-24', today)).toBe(false);
    expect(daysUntil('2026-11-03', today)).toBe(10);
    expect(daysUntil('2026-10-24', today)).toBe(0);
  });
});

describe('validateBusiness', () => {
  it('requires an EIN unless one is already stored', () => {
    expect(validateBusiness(app(), '').ein).toBeDefined();
    expect(validateBusiness(app({ ein_set: true }), '').ein).toBeUndefined();
    expect(validateBusiness(app({ ein_set: true }), '12-3').ein).toBeDefined();
    expect(validateBusiness(app(), '12-3456789').ein).toBeUndefined();
    expect(validateBusiness(app(), '123456789').ein).toBeUndefined();
  });
  it('passes for a complete business', () => {
    expect(validateBusiness(app(), '12-3456789')).toEqual({});
  });
  it('flags a bad mailing address', () => {
    const e = validateBusiness(app({ mailing_address: { street: '', city: '', state: 'Texas', zip: '1' } }), '12-3456789');
    expect(Object.keys(e)).toEqual(expect.arrayContaining(['mailing_street', 'mailing_city', 'mailing_state', 'mailing_zip']));
  });
});

const future = () => { const d = new Date(); d.setFullYear(d.getFullYear() + 1); return d.toISOString().slice(0, 10); };
const loc = (o: Partial<LocationDto> = {}): LocationDto => ({
  id: 'L1', name: 'Main', street: '1 Main', city: 'Austin', state: 'TX', zip: '78701', phone: '5125550100', hours: {},
  licenses: [
    { kind: 'tx_ecig', number: 'EC-1', expiry: future(), document_id: 'd1' },
    { kind: 'sales_tax', number: 'ST-1', expiry: null, document_id: 'd2' },
  ], ...o,
});

describe('validateLocations', () => {
  it('accepts a complete location', () => expect(validateLocations([loc()])).toEqual({}));
  it('requires at least one location', () => expect(validateLocations([]).locations).toBeDefined());
  it('requires the e-cigarette and sales tax permits with uploads', () => {
    const e = validateLocations([loc({ licenses: [] })]);
    expect(e['loc.L1.tx_ecig.number']).toBeDefined();
    expect(e['loc.L1.sales_tax.number']).toBeDefined();
  });
  it('rejects expired permits with the current-permit message', () => {
    const e = validateLocations([loc({ licenses: [{ kind: 'tx_ecig', number: 'x', expiry: '2020-01-01', document_id: 'd' }, { kind: 'sales_tax', number: 'y', expiry: null, document_id: 'd' }] })]);
    expect(e['loc.L1.tx_ecig.expiry']).toContain('expired');
  });
  it('requires an upload for each permit present, and treats tobacco/TABC as optional', () => {
    const noDoc = loc({ licenses: [{ kind: 'tx_ecig', number: 'x', expiry: future(), document_id: null }, { kind: 'sales_tax', number: 'y', expiry: null, document_id: 'd' }] });
    expect(validateLocations([noDoc])['loc.L1.tx_ecig.document']).toBeDefined();
    expect(validateLocations([loc()])['loc.L1.tobacco.number']).toBeUndefined();
    const withTabc = loc({ licenses: [...loc().licenses, { kind: 'tabc', number: '', expiry: '', document_id: null }] });
    expect(validateLocations([withTabc])['loc.L1.tabc.number']).toBeDefined();
  });
});

const owner = (o: Partial<OwnerDto> = {}): OwnerDto => ({ id: 'O1', full_name: 'Alice', title: 'Owner', ownership_pct: 100, is_control_person: true, id_document_id: 'd', ...o });

describe('validateOwners', () => {
  it('accepts a sole owner who is the control person with ID', () => expect(validateOwners([owner()])).toEqual({}));
  it('requires exactly one control person', () => {
    expect(validateOwners([owner({ is_control_person: false })]).control).toBeDefined();
    expect(validateOwners([owner({ ownership_pct: 50 }), owner({ id: 'O2', ownership_pct: 50 })]).control).toBeDefined();
  });
  it('requires ID for anyone with 25% or more, and for the control person', () => {
    const e = validateOwners([owner({ ownership_pct: 60, id_document_id: null }), owner({ id: 'O2', ownership_pct: 40, is_control_person: false, id_document_id: null })]);
    expect(e['owner.O1.id']).toBeDefined();
    expect(e['owner.O2.id']).toBeDefined();
    const small = validateOwners([owner({ ownership_pct: 80 }), owner({ id: 'O2', ownership_pct: 10, is_control_person: false, id_document_id: null })]);
    expect(small['owner.O2.id']).toBeUndefined();
  });
  it('rejects totals over 100%', () => {
    expect(validateOwners([owner({ ownership_pct: 70 }), owner({ id: 'O2', ownership_pct: 40, is_control_person: false })]).total).toBeDefined();
  });
});

describe('other steps', () => {
  it('account', () => {
    expect(validateAccount({ full_name: 'A', email: 'x', phone: '1', contact_role: null })).toMatchObject({ full_name: expect.any(String), email: expect.any(String), phone: expect.any(String), contact_role: expect.any(String) });
    expect(validateAccount({ full_name: 'Alice A', email: 'a@b.co', phone: '5125550100', contact_role: 'owner' })).toEqual({});
  });
  it('operations', () => {
    expect(Object.keys(validateOperations({}))).toEqual(expect.arrayContaining(['current_pos', 'card_pct', 'product_mix', 'registers']));
    expect(validateOperations({ current_pos: 'none', current_processor: 'cash only', monthly_sales_range: 'lt_10k', card_pct: 0, avg_ticket: 20, product_mix: ['vape'], registers: 1, employees: 0 })).toEqual({});
  });
  it('plan and agreements', () => {
    expect(validatePlan({ plan_model: null }).plan_model).toBeDefined();
    expect(validatePlan({ plan_model: 'model_b' })).toEqual({});
    expect(Object.keys(validateAgreements({ typedName: '', agree: false, compliance: false }))).toEqual(['typedName', 'agree', 'compliance']);
    expect(validateAgreements({ typedName: 'Alice A', agree: true, compliance: true })).toEqual({});
  });
});
