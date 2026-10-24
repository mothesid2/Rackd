'use client';
import { money, useBundles } from '@/lib/onboarding/config';
import type { HardwareSelection } from '@/lib/onboarding/types';
import { Card, Notice } from '../fields';
import { SkeletonOrderCard } from '../../ui/Skeleton';
import type { StepProps } from './types';

export function HardwareStep({ draft, ctx }: StepProps) {
  const bundles = useBundles();
  const a = draft.application;
  const sel: HardwareSelection = a.hardware_selection ?? { mode: 'none' };
  const set = (s: HardwareSelection) => ctx.updateApp({ hardware_selection: s });
  const fits = bundles.status === 'ready' ? bundles.data.filter((b) => b.model_fit === 'any' || b.model_fit === a.plan_model) : [];
  const anyPlaceholder = bundles.status === 'ready' && bundles.data.some((b) => b.is_placeholder);

  const optionCls = (on: boolean) =>
    `block rounded-2xl border p-4 cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-ember ${on ? 'border-ember bg-accent/10' : 'border-line bg-paper hover:border-smoke'}`;

  return (
    <div className="grid gap-4">
      <p className="text-sm text-smoke">Hardware is optional. Whatever you choose here carries into your hardware cart, where you can still change it.</p>
      {anyPlaceholder && <Notice tone="dev"><strong>Placeholder prices.</strong> Hardware pricing is not final.</Notice>}

      <fieldset className="grid gap-3">
        <legend className="sr-only">Hardware choice</legend>

        {bundles.status === 'loading' && <><SkeletonOrderCard /><SkeletonOrderCard /></>}
        {bundles.status === 'error' && <Notice tone="warn">We could not load bundles right now. You can skip this step and order hardware later.</Notice>}

        {fits.map((b) => {
          const on = sel.mode === 'bundle' && sel.bundle_slug === b.slug;
          return (
            <label key={b.slug} className={optionCls(on)}>
              <input type="radio" name="hw" className="sr-only" checked={on} onChange={() => set({ mode: 'bundle', bundle_slug: b.slug })} />
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-display font-bold text-lg">{b.name}</div>
                  {b.description && <p className="text-sm text-smoke">{b.description}</p>}
                </div>
                <div className="price text-xl whitespace-nowrap">{money(b.total_cents)}</div>
              </div>
              <ul className="mt-2 text-sm text-smoke grid gap-0.5">
                {b.items.filter((i) => !i.is_optional).map((i) => <li key={i.name}>{i.quantity} × {i.name}</li>)}
              </ul>
              {b.discount_cents > 0 && <p className="mt-1 text-xs text-green-400">Includes a {money(b.discount_cents)} bundle discount</p>}
            </label>
          );
        })}

        <label className={optionCls(sel.mode === 'own')}>
          <input type="radio" name="hw" className="sr-only" checked={sel.mode === 'own'} onChange={() => set({ mode: 'own' })} />
          <div className="font-display font-bold text-lg">I will bring my own hardware</div>
          <p className="text-sm text-smoke">We will send a compatibility checklist so you can confirm your equipment works with Rackd.</p>
        </label>
        <label className={optionCls(sel.mode === 'none')}>
          <input type="radio" name="hw" className="sr-only" checked={sel.mode === 'none'} onChange={() => set({ mode: 'none' })} />
          <div className="font-display font-bold text-lg">Decide later</div>
          <p className="text-sm text-smoke">Skip hardware for now.</p>
        </label>
      </fieldset>
      <Card className="text-sm text-smoke">Shipping and sales tax are calculated at checkout. Hardware is paid to Rackd by card in a separate step after you apply.</Card>
    </div>
  );
}
