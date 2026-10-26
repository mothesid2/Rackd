'use client';
import type { DocumentDto, OwnerDto } from '@/lib/onboarding/types';
import { btnGhost, btnPrimary, Card, CheckboxField, Notice, NumberField, SectionTitle, TextField } from '../fields';
import { FileUpload } from '../FileUpload';
import type { StepProps } from './types';

export const newOwner = (first: boolean): OwnerDto => ({
  id: crypto.randomUUID(), full_name: '', title: first ? 'Owner' : '', ownership_pct: first ? 100 : 0,
  is_control_person: first, id_document_id: null,
});

export function OwnersStep({ draft, ctx }: StepProps) {
  const owners = draft.owners;
  const docs = new Map<string, DocumentDto>(draft.documents.map((d) => [d.id, d]));
  const replace = (id: string, fn: (o: OwnerDto) => OwnerDto) => ctx.setOwners((all) => all.map((o) => (o.id === id ? fn(o) : o)));
  const total = owners.reduce((s, o) => s + (Number(o.ownership_pct) || 0), 0);

  return (
    <div className="grid gap-4">
      <Notice>
        List <strong>every owner with 25% or more</strong>, plus one <strong>control person</strong> (someone with significant day-to-day authority, often an owner).
        We ask for a photo ID only. We do not collect dates of birth or Social Security numbers here.
      </Notice>
      {ctx.err('owners') && <p role="alert" className="text-sm text-red-400">{ctx.err('owners')}</p>}
      {ctx.err('control') && <p role="alert" className="text-sm text-red-400">{ctx.err('control')}</p>}
      {ctx.err('total') && <p role="alert" className="text-sm text-red-400">{ctx.err('total')}</p>}

      {owners.map((o, i) => {
        const p = `owner.${o.id}`;
        return (
          <Card key={o.id}>
            <div className="flex items-center justify-between gap-3 mb-3">
              <SectionTitle>{o.full_name || `Owner ${i + 1}`}</SectionTitle>
              {owners.length > 1 && (
                <button type="button" className="text-sm underline text-smoke hover:text-ink min-h-[44px] px-2"
                  onClick={() => { if (confirm(`Remove ${o.full_name || 'this owner'}?`)) ctx.setOwners(owners.filter((x) => x.id !== o.id)); }}>Remove</button>
              )}
            </div>
            <div className="grid sm:grid-cols-3 gap-4">
              <TextField label="Full name" required autoComplete="off" value={o.full_name} onChange={(v) => replace(o.id, (c) => ({ ...c, full_name: v }))} onBlur={() => ctx.touch(`${p}.full_name`)} error={ctx.err(`${p}.full_name`)} />
              <TextField label="Title" value={o.title ?? ''} onChange={(v) => replace(o.id, (c) => ({ ...c, title: v }))} />
              <NumberField label="Ownership %" required value={o.ownership_pct} onChange={(v) => replace(o.id, (c) => ({ ...c, ownership_pct: v ?? 0 }))} onBlur={() => ctx.touch(`${p}.ownership_pct`)} error={ctx.err(`${p}.ownership_pct`)} />
            </div>
            <div className="mt-3">
              <CheckboxField
                label="This person is the control person"
                checked={o.is_control_person}
                onChange={(v) => ctx.setOwners((all) => all.map((x) => ({ ...x, is_control_person: x.id === o.id ? v : v ? false : x.is_control_person })))}
              />
            </div>
            <div className="mt-3">
              <FileUpload
                label={`Photo ID${(Number(o.ownership_pct) >= 25 || o.is_control_person) ? ' *' : ''}`} kind="owner_id" ownerId={o.id}
                docId={o.id_document_id} doc={o.id_document_id ? docs.get(o.id_document_id) : null}
                ensureSaved={ctx.ensureSaved}
                onUploaded={(docId) => replace(o.id, (c) => ({ ...c, id_document_id: docId }))}
                error={ctx.err(`${p}.id`)}
              />
            </div>
          </Card>
        );
      })}

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className={owners.length ? btnGhost : btnPrimary} onClick={() => ctx.setOwners([...owners, newOwner(owners.length === 0)])}>
          + Add {owners.length ? 'another ' : 'an '}owner
        </button>
        {owners.length > 0 && <span className="text-sm text-smoke" aria-live="polite">Listed ownership: {total}%</span>}
      </div>
    </div>
  );
}
