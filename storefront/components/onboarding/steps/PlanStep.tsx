'use client';
import { describeFee, money, usePublicConfig } from '@/lib/onboarding/config';
import { Card, CheckboxField, ErrorText, Notice } from '../fields';
import type { StepProps } from './types';

const FEATURES: { label: string; a: boolean; b: boolean }[] = [
  { label: 'Point of sale (POS)', a: true, b: false },
  { label: 'Online reserve-and-pickup storefront', a: true, b: true },
  { label: 'Automatic inventory sync', a: true, b: false },
  { label: 'Rebate reporting', a: true, b: false },
  { label: 'Curated online item list', a: false, b: true },
  { label: 'iPad order board included', a: false, b: true },
  { label: 'Keep your current POS', a: false, b: true },
];

const ADDON_ORDER = ['sms_marketing', 'loyalty_crm', 'automated_rebates', 'multi_location', 'extra_registers'];
const ADDON_NOTE: Record<string, string> = {
  sms_marketing: 'Text customers about offers. Requires their consent; nothing is sent until you turn it on.',
  loyalty_crm: 'Rewards and customer records.',
  automated_rebates: 'Submit manufacturer rebate reports automatically.',
  multi_location: 'Manage more than one store under one account.',
  extra_registers: 'Add more registers than your plan includes.',
};

export function PlanStep({ draft, ctx }: StepProps) {
  const cfg = usePublicConfig();
  const a = draft.application;
  const hasPrices = cfg.status === 'ready';
  const placeholder = hasPrices && (cfg.data.plans.is_placeholder || cfg.data.addonsPlaceholder || cfg.data.onlineFee.is_placeholder);

  const choose = (m: 'model_a' | 'model_b') => ctx.updateApp({ plan_model: m });
  const toggleAddon = (id: string, on: boolean) =>
    ctx.updateApp({ addons: on ? [...a.addons, id] : a.addons.filter((x) => x !== id) });

  return (
    <div className="grid gap-4">
      {placeholder && <Notice tone="dev"><strong>Placeholder pricing.</strong> The prices below are not final.</Notice>}
      {cfg.status === 'error' && <Notice tone="warn">We could not load pricing right now. You can still choose a plan; we will confirm pricing with you before you are billed.</Notice>}

      <fieldset>
        <legend className="sr-only">Choose a plan</legend>
        <div className="grid md:grid-cols-2 gap-4">
          {(['model_a', 'model_b'] as const).map((m) => {
            const plan = hasPrices ? cfg.data.plans[m] : null;
            const selected = a.plan_model === m;
            const title = plan?.name ?? (m === 'model_a' ? 'Full Rackd POS' : 'Online Storefront only');
            const blurb = m === 'model_a'
              ? 'POS, online storefront, automatic inventory sync and rebate reporting.'
              : 'Keep your current POS and add reserve-online with a curated item list.';
            return (
              <label key={m} className={`block rounded-2xl border p-4 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-ember ${selected ? 'border-ember bg-accent/10' : 'border-line bg-paper hover:border-smoke'}`}>
                <input type="radio" name="plan" className="sr-only" checked={selected} onChange={() => choose(m)} />
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-display font-extrabold text-xl">{title}</div>
                    <p className="text-sm text-smoke mt-1">{blurb}</p>
                  </div>
                  <span aria-hidden="true" className={`mt-1 w-5 h-5 rounded-full border-2 shrink-0 ${selected ? 'border-ember bg-ember' : 'border-smoke'}`} />
                </div>
                <div className="mt-3 price text-2xl">
                  {plan ? <>{money(plan.monthly_cents)}<span className="text-sm text-smoke font-normal"> / month</span></>
                    : cfg.status === 'loading' ? <div className="skel h-8 w-28" aria-label="Loading price" /> : <span className="text-smoke text-base">Pricing unavailable</span>}
                </div>
                {plan && plan.setup_cents > 0 && <p className="text-xs text-smoke">+ {money(plan.setup_cents)} one-time setup</p>}
                {m === 'model_b' && <p className="mt-2 text-sm text-green-400">✓ Includes an iPad order board for incoming online orders</p>}
              </label>
            );
          })}
        </div>
        <ErrorText>{ctx.err('plan_model')}</ErrorText>
      </fieldset>

      <Card>
        <h3 className="font-display font-bold text-lg mb-3">What is included</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="sr-only">Plan feature comparison</caption>
            <thead>
              <tr className="text-left text-smoke">
                <th scope="col" className="py-2 pr-3 font-semibold">Feature</th>
                <th scope="col" className="py-2 px-3 font-semibold text-center">Full POS</th>
                <th scope="col" className="py-2 pl-3 font-semibold text-center">Storefront only</th>
              </tr>
            </thead>
            <tbody>
              {FEATURES.map((f) => (
                <tr key={f.label} className="border-t border-line">
                  <th scope="row" className="py-2 pr-3 font-normal text-left">{f.label}</th>
                  <td className="py-2 px-3 text-center">{f.a ? <><span aria-hidden="true" className="text-green-400">✓</span><span className="sr-only">Included</span></> : <><span aria-hidden="true" className="text-smoke">—</span><span className="sr-only">Not included</span></>}</td>
                  <td className="py-2 pl-3 text-center">{f.b ? <><span aria-hidden="true" className="text-green-400">✓</span><span className="sr-only">Included</span></> : <><span aria-hidden="true" className="text-smoke">—</span><span className="sr-only">Not included</span></>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <Card>
        <h3 className="font-display font-bold text-lg">Online order fee</h3>
        <p className="text-sm mt-1">
          {hasPrices ? <>Customers pay an online order fee of <strong>{describeFee(cfg.data.onlineFee)}</strong> at checkout. You do not pay it out of your sales.</>
            : 'Customers pay a small online order fee at checkout. You do not pay it out of your sales.'}
        </p>
      </Card>

      <Card>
        <h3 className="font-display font-bold text-lg mb-1">Add-ons</h3>
        <p className="text-sm text-smoke mb-2">Optional. You can change these later.</p>
        <div className="grid gap-1">
          {ADDON_ORDER.map((id) => {
            const ad = hasPrices ? cfg.data.addons[id] : null;
            return (
              <CheckboxField key={id}
                label={<span><strong>{ad?.name ?? id.replace(/_/g, ' ')}</strong>{ad && <span className="text-smoke"> — {money(ad.monthly_cents)}/mo</span>}</span>}
                hint={ADDON_NOTE[id]}
                checked={a.addons.includes(id)} onChange={(on) => toggleAddon(id, on)} />
            );
          })}
        </div>
      </Card>
    </div>
  );
}
