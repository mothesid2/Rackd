'use client';
import { useCallback, useEffect, useState } from 'react';
import { supabase } from '@/lib/supabase';
import { adminMessage, toCents, toDollars } from '@/lib/admin/api';
import { Section, selectCls } from '@/components/admin/ui';
import { btnPrimary, CheckboxField, ErrorText, Notice, TextField } from '@/components/onboarding/fields';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';

type J = Record<string, any>;

function useSave() {
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [msg, setMsg] = useState<string | null>(null);
  const run = async (fn: () => Promise<{ error: { message: string } | null }>) => {
    setState('saving'); setMsg(null);
    const { error } = await fn();
    if (error) { setState('error'); setMsg(adminMessage(error)); } else { setState('saved'); setTimeout(() => setState('idle'), 2500); }
  };
  return { state, msg, run };
}

function SaveRow({ s, label = 'Save changes', onSave, disabled }: { s: ReturnType<typeof useSave>; label?: string; onSave: () => void; disabled?: boolean }) {
  return (
    <div className="mt-4 flex flex-wrap items-center gap-3">
      <button className={btnPrimary} onClick={onSave} disabled={s.state === 'saving' || disabled}>{s.state === 'saving' ? 'Saving…' : label}</button>
      <span role="status" aria-live="polite" className="text-sm">{s.state === 'saved' && <span className="text-green-400">Saved and audit-logged.</span>}</span>
      <ErrorText>{s.msg}</ErrorText>
    </div>
  );
}

function saveConfig(key: string, value: J) {
  return supabase().from('app_config').update({ value }).eq('key', key);
}

// ------------------------------------------------------------------ plans, add-ons, fee
function PricingSection({ cfg }: { cfg: Record<string, J> }) {
  const [plans, setPlans] = useState<J>(structuredClone(cfg.plans));
  const [addons, setAddons] = useState<J>(structuredClone(cfg.addons));
  const [fee, setFee] = useState<J>(structuredClone(cfg.online_fee));
  const s = useSave();
  const setPlan = (m: string, k: string, v: any) => setPlans((p) => ({ ...p, [m]: { ...p[m], [k]: v } }));
  const feeInput = fee.type === 'flat' ? toDollars(fee.value) : String(fee.value ?? '');
  const bad = !['model_a', 'model_b'].every((m) => plans[m].monthly_cents != null && plans[m].setup_cents != null)
    || Object.entries(addons).some(([k, v]) => k !== 'is_placeholder' && (v as J).monthly_cents == null) || fee.value == null;

  return (
    <Section title="Plans, add-ons and online fee">
      <div className="grid gap-5">
        <CheckboxField label="These prices are placeholders (shows a notice in the application wizard)" checked={!!plans.is_placeholder}
          onChange={(v) => { setPlans({ ...plans, is_placeholder: v }); setAddons({ ...addons, is_placeholder: v }); setFee({ ...fee, is_placeholder: v }); }} />
        {(['model_a', 'model_b'] as const).map((m) => (
          <fieldset key={m} className="grid sm:grid-cols-3 gap-3">
            <legend className="font-semibold mb-1">{m === 'model_a' ? 'Model A: Full Rackd POS' : 'Model B: Online Storefront only'}</legend>
            <TextField label="Display name" value={plans[m].name} onChange={(v) => setPlan(m, 'name', v)} />
            <TextField label="Monthly price ($)" inputMode="decimal" value={toDollars(plans[m].monthly_cents)} onChange={(v) => setPlan(m, 'monthly_cents', toCents(v))} />
            <TextField label="Setup fee ($)" inputMode="decimal" value={toDollars(plans[m].setup_cents)} onChange={(v) => setPlan(m, 'setup_cents', toCents(v))} />
          </fieldset>
        ))}
        <fieldset className="grid gap-3">
          <legend className="font-semibold mb-1">Add-ons (monthly)</legend>
          <div className="grid sm:grid-cols-2 gap-3">
            {Object.entries(addons).filter(([k]) => k !== 'is_placeholder').map(([k, v]) => (
              <TextField key={k} label={`${(v as J).name} ($/mo)`} inputMode="decimal" value={toDollars((v as J).monthly_cents)}
                onChange={(x) => setAddons({ ...addons, [k]: { ...(v as J), monthly_cents: toCents(x) } })} />
            ))}
          </div>
        </fieldset>
        <fieldset className="grid sm:grid-cols-2 gap-3">
          <legend className="font-semibold mb-1">Online order fee (paid by the customer)</legend>
          <label className="grid gap-1 text-sm font-semibold">Type
            <select className={selectCls} value={fee.type} onChange={(e) => setFee({ ...fee, type: e.target.value, value: e.target.value === 'percent' ? 5 : 100 })}>
              <option value="percent">Percent of the order</option><option value="flat">Flat amount per order</option>
            </select>
          </label>
          <TextField label={fee.type === 'percent' ? 'Percent (0 to 100)' : 'Amount ($)'} inputMode="decimal" value={feeInput}
            onChange={(v) => setFee({ ...fee, value: fee.type === 'flat' ? toCents(v) : v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v) })} />
        </fieldset>
      </div>
      <SaveRow s={s} disabled={bad} onSave={() => void s.run(async () => {
        for (const [k, v] of [['plans', plans], ['addons', addons], ['online_fee', fee]] as const) {
          const r = await saveConfig(k, v);
          if (r.error) return r;
        }
        return { error: null };
      })} />
    </Section>
  );
}

// ------------------------------------------------------------------ hardware tax and shipping
function HardwareSettings({ cfg }: { cfg: Record<string, J> }) {
  const [tax, setTax] = useState<J>(structuredClone(cfg.hardware_tax));
  const [ship, setShip] = useState<J>(structuredClone(cfg.hardware_shipping));
  const s = useSave();
  const methods: J[] = ship.methods ?? [];
  const setM = (i: number, patch: J) => setShip({ ...ship, methods: methods.map((m, j) => (j === i ? { ...m, ...patch } : m)) });
  const bad = methods.length === 0 || methods.some((m) => !m.name?.trim() || m.cents == null) || (tax.mode === 'flat' && (tax.rate_pct == null || Number.isNaN(tax.rate_pct)));
  return (
    <Section title="Hardware tax and shipping">
      <div className="grid gap-5">
        <CheckboxField label="Tax and shipping values are placeholders" checked={!!tax.is_placeholder} onChange={(v) => { setTax({ ...tax, is_placeholder: v }); setShip({ ...ship, is_placeholder: v }); }} />
        <fieldset className="grid sm:grid-cols-2 gap-3">
          <legend className="font-semibold mb-1">Sales tax</legend>
          <label className="grid gap-1 text-sm font-semibold">Mode
            <select className={selectCls} value={tax.mode} onChange={(e) => setTax({ ...tax, mode: e.target.value })}>
              <option value="flat">Flat rate</option><option value="stripe_tax">Stripe Tax (enable it in Stripe first)</option>
            </select>
          </label>
          {tax.mode === 'flat' && <TextField label="Rate (%)" inputMode="decimal" value={String(tax.rate_pct ?? '')} onChange={(v) => setTax({ ...tax, rate_pct: v.trim() === '' || Number.isNaN(Number(v)) ? null : Number(v) })} hint="0 to 30" />}
        </fieldset>
        <fieldset className="grid gap-3">
          <legend className="font-semibold mb-1">Shipping methods</legend>
          {methods.map((m, i) => (
            <div key={i} className="grid grid-cols-[1fr_8rem_auto] gap-3 items-end">
              <TextField label="Name" value={m.name ?? ''} onChange={(v) => setM(i, { name: v, id: m.id || v.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `m${i}` })} />
              <TextField label="Price ($)" inputMode="decimal" value={toDollars(m.cents)} onChange={(v) => setM(i, { cents: toCents(v) })} />
              <button type="button" className="min-h-[44px] px-2 text-sm underline text-smoke disabled:opacity-40" disabled={methods.length <= 1} onClick={() => setShip({ ...ship, methods: methods.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <div><button type="button" className="text-sm underline min-h-[44px]" onClick={() => setShip({ ...ship, methods: [...methods, { id: `method-${methods.length + 1}`, name: '', cents: 0 }] })}>+ Add a method</button></div>
        </fieldset>
      </div>
      <SaveRow s={s} disabled={bad} onSave={() => void s.run(async () => {
        const r1 = await saveConfig('hardware_tax', tax);
        if (r1.error) return r1;
        return saveConfig('hardware_shipping', { ...ship, methods: methods.map((m, i) => ({ ...m, id: m.id || `method-${i + 1}` })) });
      })} />
    </Section>
  );
}

// ------------------------------------------------------------------ products and bundles
function ProductRow({ p }: { p: J }) {
  const [f, setF] = useState({ price: toDollars(p.price_cents), stock: String(p.stock_qty), max: String(p.max_per_order), active: !!p.is_active, ph: !!p.is_placeholder });
  const s = useSave();
  const price = toCents(f.price);
  const stock = Number(f.stock), max = Number(f.max);
  const bad = price == null || !Number.isInteger(stock) || stock < 0 || !Number.isInteger(max) || max < 1;
  return (
    <li className="rounded-xl border border-line p-3 grid gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2"><strong>{p.name}</strong><span className="text-xs text-smoke">{p.sku}</span></div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 items-end">
        <TextField label="Price ($)" inputMode="decimal" value={f.price} onChange={(v) => setF({ ...f, price: v })} />
        <TextField label="Stock" inputMode="numeric" value={f.stock} onChange={(v) => setF({ ...f, stock: v })} />
        <TextField label="Max per order" inputMode="numeric" value={f.max} onChange={(v) => setF({ ...f, max: v })} />
        <CheckboxField label="Active" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
        <CheckboxField label="Placeholder" checked={f.ph} onChange={(v) => setF({ ...f, ph: v })} />
      </div>
      <SaveRow s={s} label="Save product" disabled={bad} onSave={() => void s.run(async () =>
        supabase().from('hardware_products').update({ price_cents: price, stock_qty: stock, max_per_order: max, is_active: f.active, is_placeholder: f.ph }).eq('id', p.id))} />
    </li>
  );
}

function BundleRow({ b }: { b: J }) {
  const [f, setF] = useState({ discount: toDollars(b.discount_cents), active: !!b.is_active, ph: !!b.is_placeholder });
  const s = useSave();
  const d = toCents(f.discount);
  return (
    <li className="rounded-xl border border-line p-3 grid gap-3">
      <strong>{b.name}</strong>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 items-end">
        <TextField label="Bundle discount ($)" inputMode="decimal" value={f.discount} onChange={(v) => setF({ ...f, discount: v })} />
        <CheckboxField label="Active" checked={f.active} onChange={(v) => setF({ ...f, active: v })} />
        <CheckboxField label="Placeholder" checked={f.ph} onChange={(v) => setF({ ...f, ph: v })} />
      </div>
      <SaveRow s={s} label="Save bundle" disabled={d == null} onSave={() => void s.run(async () =>
        supabase().from('hardware_bundles').update({ discount_cents: d, is_active: f.active, is_placeholder: f.ph }).eq('id', b.id))} />
    </li>
  );
}

export default function ConfigPage() {
  const [cfg, setCfg] = useState<Record<string, J> | null>(null);
  const [products, setProducts] = useState<J[]>([]);
  const [bundles, setBundles] = useState<J[]>([]);
  const [err, setErr] = useState(false);
  const load = useCallback(async () => {
    const sb = supabase();
    const [c, p, b] = await Promise.all([
      sb.from('app_config').select('key,value'),
      sb.from('hardware_products').select('*').order('sort_order'),
      sb.from('hardware_bundles').select('*').order('sort_order'),
    ]);
    if (c.error || p.error || b.error || !c.data) return setErr(true);
    setCfg(Object.fromEntries(c.data.map((r: J) => [r.key, r.value])));
    setProducts(p.data ?? []); setBundles(b.data ?? []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (err) return <Notice tone="warn">Could not load configuration.</Notice>;
  if (!cfg) return <div aria-busy="true" className="grid gap-3"><SkeletonOrderCard /><SkeletonOrderCard /></div>;
  const missing = ['plans', 'addons', 'online_fee', 'hardware_tax', 'hardware_shipping'].filter((k) => !cfg[k]);
  if (missing.length) return <Notice tone="warn">Missing config rows: {missing.join(', ')}. Run the 081 migration seed.</Notice>;

  return (
    <div className="grid gap-4">
      <h1 className="font-display font-extrabold text-3xl tracking-tight">Pricing and configuration</h1>
      <Notice>Every save is checked by the database and written to the audit log with the before and after values.</Notice>
      <PricingSection cfg={cfg} />
      <HardwareSettings cfg={cfg} />
      <Section title="Hardware products"><ul className="grid gap-3">{products.map((p) => <ProductRow key={p.id} p={p} />)}</ul></Section>
      <Section title="Hardware bundles"><ul className="grid gap-3">{bundles.map((b) => <BundleRow key={b.id} b={b} />)}</ul></Section>
    </div>
  );
}
