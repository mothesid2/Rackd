'use client';
import { Card, CheckboxField, ErrorText, Notice, NumberField, SelectField, TextField } from '../fields';
import type { StepProps } from './types';

const SALES = [
  { value: 'lt_10k', label: 'Under $10,000' },
  { value: '10k_25k', label: '$10,000 – $25,000' },
  { value: '25k_50k', label: '$25,000 – $50,000' },
  { value: '50k_100k', label: '$50,000 – $100,000' },
  { value: 'gt_100k', label: 'Over $100,000' },
];

export const PRODUCT_MIX = [
  { value: 'vape', label: 'Vape' },
  { value: 'tobacco', label: 'Tobacco' },
  { value: 'hemp', label: 'Hemp' },
  { value: 'glass', label: 'Glass' },
  { value: 'liquor', label: 'Liquor' },
  { value: 'other', label: 'Other' },
];

export function OperationsStep({ draft, ctx }: StepProps) {
  const ops = draft.application.operations ?? {};
  const set = (patch: Partial<typeof ops>) => ctx.updateApp({ operations: { ...ops, ...patch } });
  const mix = ops.product_mix ?? [];

  return (
    <div className="grid gap-4">
      <Card>
        <div className="grid sm:grid-cols-2 gap-4">
          <TextField label="Current POS" required placeholder="Name, or “none”" value={ops.current_pos ?? ''} onChange={(v) => set({ current_pos: v })} onBlur={() => ctx.touch('current_pos')} error={ctx.err('current_pos')} />
          <TextField label="Current payment processor" required placeholder="Name, “none” or “cash only”" value={ops.current_processor ?? ''} onChange={(v) => set({ current_processor: v })} onBlur={() => ctx.touch('current_processor')} error={ctx.err('current_processor')} />
          <SelectField label="Monthly sales" required value={ops.monthly_sales_range ?? ''} onChange={(v) => set({ monthly_sales_range: v })} onBlur={() => ctx.touch('monthly_sales_range')} options={SALES} error={ctx.err('monthly_sales_range')} />
          <NumberField label="Percent paid by card" required value={ops.card_pct} onChange={(v) => set({ card_pct: v })} onBlur={() => ctx.touch('card_pct')} error={ctx.err('card_pct')} hint="0 to 100" />
          <NumberField label="Average ticket ($)" required value={ops.avg_ticket} onChange={(v) => set({ avg_ticket: v })} onBlur={() => ctx.touch('avg_ticket')} error={ctx.err('avg_ticket')} />
          <NumberField label="Registers" required value={ops.registers} onChange={(v) => set({ registers: v })} onBlur={() => ctx.touch('registers')} error={ctx.err('registers')} />
          <NumberField label="Employees" required value={ops.employees} onChange={(v) => set({ employees: v })} onBlur={() => ctx.touch('employees')} error={ctx.err('employees')} />
        </div>
      </Card>

      <Card>
        <fieldset aria-describedby={ctx.err('product_mix') ? 'mix-err' : undefined}>
          <legend className="font-semibold text-sm mb-1">Product mix <span className="text-ember" aria-hidden="true">*</span></legend>
          <p className="text-xs text-smoke mb-1">Choose everything you sell.</p>
          <div className="grid grid-cols-2 sm:grid-cols-3">
            {PRODUCT_MIX.map((m) => (
              <CheckboxField key={m.value} label={m.label} checked={mix.includes(m.value)}
                onChange={(on) => set({ product_mix: on ? [...mix, m.value] : mix.filter((x) => x !== m.value) })} />
            ))}
          </div>
          <ErrorText id="mix-err">{ctx.err('product_mix')}</ErrorText>
        </fieldset>
      </Card>

      <Card>
        <h3 className="font-display font-bold text-lg">Optional: your current costs</h3>
        <p className="text-sm text-smoke mt-1 mb-3">Tell us what you pay today and we can show a savings comparison. Skip this if you prefer.</p>
        <div className="grid sm:grid-cols-2 gap-4">
          <NumberField label="Monthly software cost ($)" value={ops.current_software_cost} onChange={(v) => set({ current_software_cost: v })} />
          <NumberField label="Monthly processing cost ($)" value={ops.current_processing_cost} onChange={(v) => set({ current_processing_cost: v })} />
        </div>
      </Card>
      <Notice>Do not enter bank account or card numbers anywhere in this form.</Notice>
    </div>
  );
}
