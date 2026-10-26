'use client';
import { Card, Notice, NumberField, SelectField, TextField } from '../fields';
import type { StepProps } from './types';

const ENTITY = [
  { value: 'llc', label: 'LLC' },
  { value: 'corporation', label: 'Corporation' },
  { value: 'sole_proprietor', label: 'Sole proprietor' },
  { value: 'partnership', label: 'Partnership' },
];

export function BusinessStep({ draft, ctx }: StepProps) {
  const a = draft.application;
  const m = a.mailing_address ?? {};
  const setAddr = (k: 'street' | 'city' | 'state' | 'zip', v: string) =>
    ctx.updateApp({ mailing_address: { ...m, [k]: k === 'state' ? v.toUpperCase().slice(0, 2) : v } });

  return (
    <div className="grid gap-4">
      <Card>
        <div className="grid sm:grid-cols-2 gap-4">
          <TextField label="Legal business name" required value={a.legal_name ?? ''} onChange={(v) => ctx.updateApp({ legal_name: v })} onBlur={() => ctx.touch('legal_name')} error={ctx.err('legal_name')} autoComplete="organization" />
          <TextField label="DBA (doing business as)" value={a.dba ?? ''} onChange={(v) => ctx.updateApp({ dba: v })} hint="Leave blank if it matches the legal name." />
          <SelectField label="Entity type" required value={a.entity_type ?? ''} onChange={(v) => ctx.updateApp({ entity_type: (v || null) as never })} onBlur={() => ctx.touch('entity_type')} options={ENTITY} error={ctx.err('entity_type')} />
          <NumberField label="Years in business" required value={a.years_in_business} onChange={(v) => ctx.updateApp({ years_in_business: v })} onBlur={() => ctx.touch('years_in_business')} error={ctx.err('years_in_business')} />
          <div>
            <TextField
              label="EIN" required inputMode="numeric" autoComplete="off" maxLength={10} placeholder="12-3456789"
              tip="Your Employer Identification Number. It is encrypted before it is stored and only platform admins can view it."
              value={ctx.einInput}
              onChange={(v) => ctx.setEinInput(v)}
              onBlur={() => ctx.touch('ein')}
              error={ctx.err('ein')}
              hint={a.ein_set && !ctx.einInput ? `Saved securely (ends in ${a.ein_last4}). Type a new EIN only to change it.` : 'Encrypted at rest. We never show it back.'}
            />
          </div>
          <NumberField label="Number of locations" required value={a.location_count} onChange={(v) => ctx.updateApp({ location_count: v })} onBlur={() => ctx.touch('location_count')} error={ctx.err('location_count')} />
          <TextField label="Business email" type="email" inputMode="email" autoComplete="email" required value={a.business_email ?? ''} onChange={(v) => ctx.updateApp({ business_email: v })} onBlur={() => ctx.touch('business_email')} error={ctx.err('business_email')} />
          <TextField label="Business phone" type="tel" inputMode="tel" autoComplete="tel" required value={a.business_phone ?? ''} onChange={(v) => ctx.updateApp({ business_phone: v })} onBlur={() => ctx.touch('business_phone')} error={ctx.err('business_phone')} />
          <div className="sm:col-span-2">
            <TextField label="Website (optional)" inputMode="url" autoComplete="url" placeholder="example.com" value={a.website ?? ''} onChange={(v) => ctx.updateApp({ website: v })} onBlur={() => ctx.touch('website')} error={ctx.err('website')} />
          </div>
        </div>
      </Card>

      <Card>
        <h3 className="font-display font-bold text-lg mb-3">Mailing address</h3>
        <div className="grid sm:grid-cols-6 gap-4">
          <div className="sm:col-span-6">
            <TextField label="Street address" required autoComplete="address-line1" value={m.street ?? ''} onChange={(v) => setAddr('street', v)} onBlur={() => ctx.touch('mailing_street')} error={ctx.err('mailing_street')} />
          </div>
          <div className="sm:col-span-3"><TextField label="City" required autoComplete="address-level2" value={m.city ?? ''} onChange={(v) => setAddr('city', v)} onBlur={() => ctx.touch('mailing_city')} error={ctx.err('mailing_city')} /></div>
          <div className="sm:col-span-1"><TextField label="State" required autoComplete="address-level1" maxLength={2} value={m.state ?? ''} onChange={(v) => setAddr('state', v)} onBlur={() => ctx.touch('mailing_state')} error={ctx.err('mailing_state')} /></div>
          <div className="sm:col-span-2"><TextField label="ZIP" required inputMode="numeric" autoComplete="postal-code" maxLength={10} value={m.zip ?? ''} onChange={(v) => setAddr('zip', v)} onBlur={() => ctx.touch('mailing_zip')} error={ctx.err('mailing_zip')} /></div>
        </div>
      </Card>

      <Notice>We do not ask for Social Security numbers, bank account numbers or card numbers anywhere in this application.</Notice>
    </div>
  );
}
