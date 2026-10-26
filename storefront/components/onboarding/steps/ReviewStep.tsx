'use client';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, messageFor } from '@/lib/onboarding/api';
import { STEP_TITLES, type LicenseKind } from '@/lib/onboarding/types';
import { btnPrimary, Card, ErrorText, Notice } from '../fields';
import { Turnstile } from '../Turnstile';
import type { StepProps } from './types';

const PERMIT_LABEL: Record<LicenseKind, string> = { tx_ecig: 'E-cigarette permit', tobacco: 'Tobacco permit', sales_tax: 'Sales tax permit', tabc: 'TABC permit' };

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return <div className="grid grid-cols-[9rem_1fr] gap-3 text-sm py-1"><dt className="text-smoke">{k}</dt><dd className="break-words">{v || <span className="text-smoke">—</span>}</dd></div>;
}

function Section({ title, step, ctx, children }: { title: string; step: number; ctx: StepProps['ctx']; children: React.ReactNode }) {
  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-display font-bold text-lg">{title}</h3>
        <button type="button" className="text-sm underline text-red-400 hover:text-white min-h-[44px] px-2" onClick={() => ctx.goTo(step)}>
          Edit<span className="sr-only"> {STEP_TITLES[step - 1]}</span>
        </button>
      </div>
      <dl>{children}</dl>
    </Card>
  );
}

export function ReviewStep({ draft, ctx, onBlocked }: StepProps & { onBlocked: (messages: string[]) => void }) {
  const router = useRouter();
  const a = draft.application;
  const [ts, setTs] = useState('');
  const [tsKey, setTsKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const m = a.mailing_address ?? {};
  const ops = a.operations ?? {};

  async function submit() {
    setBusy(true);
    setErr(null);
    setProblems([]);
    try {
      await ctx.ensureSaved();
      const r = await api.submit(ts);
      if (!r.ok) {
        setProblems(r.errors ?? []);
        onBlocked(r.errors ?? []);
        setTsKey((k) => k + 1);
        return;
      }
      router.push('/get-started/submitted/');
    } catch (e) {
      setErr(messageFor(e));
      setTsKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4">
      <Section title="Account" step={1} ctx={ctx}>
        <Row k="Name" v={a.full_name} /><Row k="Email" v={a.email} /><Row k="Phone" v={a.phone} /><Row k="Role" v={a.contact_role} />
      </Section>
      <Section title="Business" step={2} ctx={ctx}>
        <Row k="Legal name" v={a.legal_name} /><Row k="DBA" v={a.dba} /><Row k="Entity" v={a.entity_type} />
        <Row k="EIN" v={a.ein_set ? `•••••${a.ein_last4}` : ''} /><Row k="Years" v={a.years_in_business} />
        <Row k="Mailing address" v={[m.street, m.city, m.state, m.zip].filter(Boolean).join(', ')} />
      </Section>
      <Section title={`Locations (${draft.locations.length})`} step={3} ctx={ctx}>
        {draft.locations.map((l) => (
          <Row key={l.id} k={l.name} v={<>{[l.street, l.city, l.state, l.zip].filter(Boolean).join(', ')}<br /><span className="text-smoke">{l.licenses.map((x) => PERMIT_LABEL[x.kind]).join(' · ')}</span></>} />
        ))}
      </Section>
      <Section title={`Owners (${draft.owners.length})`} step={4} ctx={ctx}>
        {draft.owners.map((o) => <Row key={o.id} k={o.full_name} v={`${o.ownership_pct}%${o.is_control_person ? ' · control person' : ''}`} />)}
      </Section>
      <Section title="Operations" step={5} ctx={ctx}>
        <Row k="Current POS" v={ops.current_pos} /><Row k="Processor" v={ops.current_processor} />
        <Row k="Registers" v={ops.registers} /><Row k="Employees" v={ops.employees} /><Row k="Products" v={(ops.product_mix ?? []).join(', ')} />
      </Section>
      <Section title="Plan" step={6} ctx={ctx}>
        <Row k="Plan" v={a.plan_model === 'model_a' ? 'Full Rackd POS' : a.plan_model === 'model_b' ? 'Online Storefront only' : ''} />
        <Row k="Add-ons" v={a.addons.join(', ')} />
      </Section>
      <Section title="Hardware" step={7} ctx={ctx}>
        <Row k="Choice" v={a.hardware_selection?.mode === 'bundle' ? `Bundle: ${a.hardware_selection.bundle_slug}` : a.hardware_selection?.mode === 'own' ? 'Bringing own hardware' : 'Decide later'} />
      </Section>

      <Card>
        <h3 className="font-display font-bold text-lg mb-2">Submit</h3>
        <p className="text-sm text-smoke mb-3">After you submit we review your application and permits. You can check the status any time, and we will email you if we need more information.</p>
        {problems.length > 0 && (
          <div role="alert" className="mb-3 rounded-lg border border-red-400/60 bg-red-400/10 p-3 text-sm">
            <p className="font-semibold mb-1">Please fix these before submitting:</p>
            <ul className="list-disc pl-5 grid gap-0.5">{problems.map((p) => <li key={p}>{p}</li>)}</ul>
          </div>
        )}
        <Turnstile action="submit" onToken={setTs} resetKey={tsKey} />
        <ErrorText>{err}</ErrorText>
        <div className="mt-3"><button type="button" className={btnPrimary} onClick={submit} disabled={busy || !ts}>{busy ? 'Submitting…' : 'Submit application'}</button></div>
      </Card>
      <Notice>Owner date of birth and Social Security number are not collected here. If a payment processor needs them later, that happens in a separate secure step with the processor.</Notice>
    </div>
  );
}
