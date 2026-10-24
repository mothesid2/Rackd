'use client';
import {
  COMPLIANCE_TEXT, MERCHANT_AGREEMENT, SMS_CONSENT_TEXT, TERMS_OF_SERVICE, type LegalDoc,
} from '@/lib/onboarding/legal';
import { Card, CheckboxField, Notice, TextField } from '../fields';
import type { StepProps } from './types';

function DocView({ doc }: { doc: LegalDoc }) {
  return (
    <details className="rounded-xl border border-line bg-steel/50">
      <summary className="cursor-pointer min-h-[44px] flex items-center px-4 font-semibold text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-ember rounded-xl">
        {doc.title} <span className="ml-2 text-xs text-smoke font-normal">version {doc.version}</span>
      </summary>
      <div className="px-4 pb-4 max-h-72 overflow-y-auto text-sm leading-relaxed grid gap-3" tabIndex={0} aria-label={`${doc.title} text`}>
        {doc.sections.map((s) => (
          <div key={s.heading}><div className="font-semibold">{s.heading}</div><p className="text-ink/90">{s.body}</p></div>
        ))}
      </div>
    </details>
  );
}

export function AgreementsStep({ ctx }: StepProps) {
  const { legal } = ctx;
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  return (
    <div className="grid gap-4">
      <Notice tone="warn">These documents are working drafts pending legal review.</Notice>
      <Card>
        <h3 className="font-display font-bold text-lg mb-3">Read and sign</h3>
        <div className="grid gap-3">
          <DocView doc={TERMS_OF_SERVICE} />
          <DocView doc={MERCHANT_AGREEMENT} />
        </div>
        <div className="mt-4 grid gap-1">
          <CheckboxField
            label="I have read and agree to the Terms of Service and the Platform / Merchant Agreement."
            checked={legal.agree} onChange={(v) => { ctx.setLegal({ agree: v }); ctx.touch('agree'); }} error={ctx.err('agree')} />
          <CheckboxField
            label={COMPLIANCE_TEXT}
            checked={legal.compliance} onChange={(v) => { ctx.setLegal({ compliance: v }); ctx.touch('compliance'); }} error={ctx.err('compliance')} />
        </div>
        <div className="mt-4 grid sm:grid-cols-2 gap-4">
          <TextField label="Type your full legal name to sign" required autoComplete="name" value={legal.typedName}
            onChange={(v) => ctx.setLegal({ typedName: v })} onBlur={() => ctx.touch('typedName')} error={ctx.err('typedName')} />
          <div>
            <div className="text-sm font-semibold mb-1">Date</div>
            <div className="min-h-[44px] flex items-center text-sm">{today}</div>
          </div>
        </div>
        <p className="mt-2 text-xs text-smoke">When you continue we record your typed name, the date and time, your IP address and your browser, along with the exact version of each document.</p>
      </Card>

      <Card>
        <h3 className="font-display font-bold text-lg mb-1">Text messages (optional)</h3>
        <p className="text-sm text-smoke mb-2">This is separate from the agreements above. You can apply without it.</p>
        <CheckboxField label={SMS_CONSENT_TEXT} checked={legal.sms} onChange={(v) => ctx.setLegal({ sms: v })} />
        <p className="text-xs text-smoke mt-2">Text messaging is not turned on yet. Saying yes only records your preference.</p>
      </Card>
    </div>
  );
}
