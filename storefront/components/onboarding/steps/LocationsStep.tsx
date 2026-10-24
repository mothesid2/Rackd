'use client';
import { daysUntil } from '@/lib/onboarding/validate';
import { DAYS, type Day, type DocumentDto, type Hours, type LicenseDto, type LicenseKind, type LocationDto } from '@/lib/onboarding/types';
import { btnGhost, btnPrimary, Card, CheckboxField, Notice, SectionTitle, TextField } from '../fields';
import { FileUpload } from '../FileUpload';
import type { StepProps } from './types';

const DAY_LABEL: Record<Day, string> = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const DOC_KIND: Record<LicenseKind, string> = { tx_ecig: 'license_tx_ecig', tobacco: 'license_tobacco', sales_tax: 'license_sales_tax', tabc: 'license_tabc' };

const defaultHours = (): Hours =>
  Object.fromEntries(DAYS.map((d) => [d, { open: '10:00', close: '21:00', closed: false }])) as Hours;

export const newLocation = (n: number): LocationDto => ({
  id: crypto.randomUUID(), name: n === 1 ? 'Main location' : `Location ${n}`,
  street: '', city: '', state: 'TX', zip: '', phone: '', hours: defaultHours(),
  licenses: [
    { kind: 'tx_ecig', number: '', expiry: '', document_id: null },
    { kind: 'sales_tax', number: '', expiry: null, document_id: null },
  ],
});

function ExpiryNote({ date }: { date: string | null }) {
  if (!date) return null;
  const d = daysUntil(date);
  if (d < 0) return null; // the field error already says expired
  if (d <= 30) return <p className="mt-1 text-xs text-amber-300">Expires in {d} day{d === 1 ? '' : 's'}. We will email you before it lapses.</p>;
  return null;
}

export function LocationsStep({ draft, ctx }: StepProps) {
  const locs = draft.locations;
  const docs = new Map<string, DocumentDto>(draft.documents.map((d) => [d.id, d]));
  const replace = (id: string, fn: (l: LocationDto) => LocationDto) => ctx.setLocations(locs.map((l) => (l.id === id ? fn(l) : l)));

  return (
    <div className="grid gap-4">
      <Notice tone="warn">All permits must be <strong>current</strong>. Expired permits cannot be accepted, and we will email you before any permit expires.</Notice>
      {ctx.err('locations') && <p role="alert" className="text-sm text-red-400">{ctx.err('locations')}</p>}

      {locs.map((l, idx) => {
        const p = `loc.${l.id}`;
        const lic = (kind: LicenseKind) => l.licenses.find((x) => x.kind === kind);
        const setLic = (kind: LicenseKind, patch: Partial<LicenseDto>) =>
          replace(l.id, (cur) => ({
            ...cur,
            licenses: cur.licenses.some((x) => x.kind === kind)
              ? cur.licenses.map((x) => (x.kind === kind ? { ...x, ...patch } : x))
              : [...cur.licenses, { kind, number: '', expiry: '', document_id: null, ...patch }],
          }));
        const toggleOptional = (kind: LicenseKind, on: boolean) =>
          replace(l.id, (cur) => ({
            ...cur,
            licenses: on
              ? [...cur.licenses, { kind, number: '', expiry: '', document_id: null }]
              : cur.licenses.filter((x) => x.kind !== kind),
          }));
        const setHours = (d: Day, patch: Partial<Hours[Day]>) =>
          replace(l.id, (cur) => ({ ...cur, hours: { ...defaultHours(), ...cur.hours, [d]: { ...(cur.hours[d] ?? defaultHours()[d]), ...patch } } }));

        const permit = (kind: LicenseKind, label: string, opts: { expiry: boolean; optional?: boolean }) => {
          const cur = lic(kind);
          if (opts.optional && !cur) {
            return <CheckboxField key={kind} label={`This location has a ${label}`} checked={false} onChange={(v) => toggleOptional(kind, v)} />;
          }
          return (
            <div key={kind} className="rounded-xl border border-line p-3 grid gap-3">
              <div className="flex items-center justify-between gap-2">
                <h5 className="font-semibold text-sm">{label}{opts.optional ? ' (optional)' : ' *'}</h5>
                {opts.optional && <button type="button" className="text-xs underline text-smoke min-h-[44px] px-2" onClick={() => toggleOptional(kind, false)}>Remove</button>}
              </div>
              <div className="grid sm:grid-cols-2 gap-3">
                <TextField label="Permit number" required value={cur?.number ?? ''} onChange={(v) => setLic(kind, { number: v })} onBlur={() => ctx.touch(`${p}.${kind}.number`)} error={ctx.err(`${p}.${kind}.number`)} />
                {opts.expiry && (
                  <div>
                    <TextField label="Expiry date" type="date" required value={cur?.expiry ?? ''} onChange={(v) => setLic(kind, { expiry: v })} onBlur={() => ctx.touch(`${p}.${kind}.expiry`)} error={ctx.err(`${p}.${kind}.expiry`)} />
                    <ExpiryNote date={cur?.expiry ?? null} />
                  </div>
                )}
              </div>
              <FileUpload
                label="Copy of permit" kind={DOC_KIND[kind]} locationId={l.id}
                docId={cur?.document_id} doc={cur?.document_id ? docs.get(cur.document_id) : null}
                ensureSaved={ctx.ensureSaved}
                onUploaded={(docId) => setLic(kind, { document_id: docId })}
                error={ctx.err(`${p}.${kind}.document`)}
              />
            </div>
          );
        };

        return (
          <Card key={l.id}>
            <div className="flex items-center justify-between gap-3 mb-3">
              <SectionTitle>{l.name || `Location ${idx + 1}`}</SectionTitle>
              {locs.length > 1 && (
                <button type="button" className="text-sm underline text-smoke hover:text-ink min-h-[44px] px-2"
                  onClick={() => { if (confirm(`Remove "${l.name}"? Its permits and uploads will be removed too.`)) ctx.setLocations(locs.filter((x) => x.id !== l.id)); }}>
                  Remove location
                </button>
              )}
            </div>

            <div className="grid sm:grid-cols-6 gap-4">
              <div className="sm:col-span-3"><TextField label="Location name" required value={l.name} onChange={(v) => replace(l.id, (c) => ({ ...c, name: v }))} onBlur={() => ctx.touch(`${p}.name`)} error={ctx.err(`${p}.name`)} /></div>
              <div className="sm:col-span-3"><TextField label="Store phone" type="tel" inputMode="tel" required value={l.phone ?? ''} onChange={(v) => replace(l.id, (c) => ({ ...c, phone: v }))} onBlur={() => ctx.touch(`${p}.phone`)} error={ctx.err(`${p}.phone`)} /></div>
              <div className="sm:col-span-6"><TextField label="Street address" required autoComplete="off" value={l.street ?? ''} onChange={(v) => replace(l.id, (c) => ({ ...c, street: v }))} onBlur={() => ctx.touch(`${p}.street`)} error={ctx.err(`${p}.street`)} /></div>
              <div className="sm:col-span-3"><TextField label="City" required value={l.city ?? ''} onChange={(v) => replace(l.id, (c) => ({ ...c, city: v }))} onBlur={() => ctx.touch(`${p}.city`)} error={ctx.err(`${p}.city`)} /></div>
              <div className="sm:col-span-1"><TextField label="State" required maxLength={2} value={l.state ?? ''} onChange={(v) => replace(l.id, (c) => ({ ...c, state: v.toUpperCase().slice(0, 2) }))} onBlur={() => ctx.touch(`${p}.state`)} error={ctx.err(`${p}.state`)} /></div>
              <div className="sm:col-span-2"><TextField label="ZIP" required inputMode="numeric" maxLength={10} value={l.zip ?? ''} onChange={(v) => replace(l.id, (c) => ({ ...c, zip: v }))} onBlur={() => ctx.touch(`${p}.zip`)} error={ctx.err(`${p}.zip`)} /></div>
            </div>

            <fieldset className="mt-5">
              <legend className="font-semibold text-sm mb-2">Store hours</legend>
              <div className="grid gap-2">
                {DAYS.map((d) => {
                  const h = { ...defaultHours()[d], ...(l.hours[d] ?? {}) };
                  return (
                    <div key={d} className="grid grid-cols-[5.5rem_1fr] sm:grid-cols-[7rem_auto_1fr] items-center gap-x-3 gap-y-1">
                      <span className="text-sm">{DAY_LABEL[d]}</span>
                      <label className="flex items-center gap-2 text-sm min-h-[44px]">
                        <input type="checkbox" className="w-5 h-5 accent-[#e0293d]" checked={h.closed} onChange={(e) => setHours(d, { closed: e.target.checked })} /> Closed
                      </label>
                      {!h.closed && (
                        <div className="col-span-2 sm:col-span-1 flex items-center gap-2">
                          <input aria-label={`${DAY_LABEL[d]} opens`} type="time" className="min-h-[44px] rounded-lg bg-steel border border-line px-2 text-ink" value={h.open} onChange={(e) => setHours(d, { open: e.target.value })} />
                          <span aria-hidden="true">to</span>
                          <input aria-label={`${DAY_LABEL[d]} closes`} type="time" className="min-h-[44px] rounded-lg bg-steel border border-line px-2 text-ink" value={h.close} onChange={(e) => setHours(d, { close: e.target.value })} />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </fieldset>

            <div className="mt-5 grid gap-3">
              <h4 className="font-semibold text-sm">Licenses for this location</h4>
              {permit('tx_ecig', 'Texas E-Cigarette Retailer Permit', { expiry: true })}
              {permit('sales_tax', 'Sales tax permit', { expiry: false })}
              {permit('tobacco', 'Tobacco / cigarette permit', { expiry: true, optional: true })}
              {permit('tabc', 'TABC permit (liquor)', { expiry: true, optional: true })}
            </div>
          </Card>
        );
      })}

      <div>
        <button type="button" className={locs.length ? btnGhost : btnPrimary} onClick={() => ctx.setLocations([...locs, newLocation(locs.length + 1)])}>
          + Add {locs.length ? 'another ' : 'a '}location
        </button>
      </div>
    </div>
  );
}
