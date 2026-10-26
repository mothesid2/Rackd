'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { adminMessage, adminPost, fmtDate, fmtDateTime } from '@/lib/admin/api';
import { Dl, Modal, PermitBadge, Section, StatusBadge } from '@/components/admin/ui';
import { btnGhost, btnPrimary, Card, ErrorText, Notice } from '@/components/onboarding/fields';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';

type J = Record<string, any>;
interface Detail {
  app: J; locations: J[]; licenses: J[]; owners: J[]; documents: J[]; signatures: J[]; sms: J[]; events: J[]; notes: J[]; run: J | null;
}

const PERMIT: Record<string, string> = { tx_ecig: 'Texas E-Cigarette Retailer Permit', tobacco: 'Tobacco / cigarette permit', sales_tax: 'Sales tax permit', tabc: 'TABC permit' };
const EVENT: Record<string, string> = {
  created: 'Application started', submitted: 'Submitted', info_provided: 'Applicant sent requested information', status_in_review: 'Review started',
  status_needs_info: 'Information requested', status_rejected: 'Rejected', approved: 'Approved and provisioned', activated: 'Owner activated account',
  email_verified: 'Email verified', resumed: 'Resumed from emailed link', document_uploaded: 'Document uploaded',
};

async function load(id: string): Promise<Detail | null> {
  const sb = supabase();
  const [app, locs, lic, own, docs, sig, sms, ev, notes, run] = await Promise.all([
    sb.from('onboarding_applications').select('id,status,full_name,email,email_verified_at,phone,contact_role,legal_name,dba,entity_type,ein_last4,years_in_business,business_email,business_phone,website,mailing_address,location_count,operations,plan_model,addons,hardware_selection,compliance_ack_at,compliance_ack_version,kyc_status,info_request,reject_reason,submitted_at,reviewed_at,provisioned_tenant_id,created_at').eq('id', id).maybeSingle(),
    sb.from('onboarding_locations').select('*').eq('application_id', id).order('sort_order'),
    sb.from('onboarding_licenses').select('*').eq('application_id', id),
    sb.from('onboarding_owners').select('*').eq('application_id', id).order('created_at'),
    sb.from('onboarding_documents').select('id,kind,location_id,owner_id,original_name,mime,size_bytes,scan_status,requested_by_admin,uploaded_at').eq('application_id', id).order('uploaded_at'),
    sb.from('agreement_signatures').select('typed_name,signed_on,signed_at,ip,user_agent,agreement_versions(kind,version,body_sha256)').eq('application_id', id),
    sb.from('sms_consents').select('consented,consent_text_version,consent_text_sha256,ip,created_at').eq('application_id', id).order('created_at', { ascending: false }),
    sb.from('application_events').select('id,type,actor,visible_to_applicant,detail,created_at').eq('application_id', id).order('created_at'),
    sb.from('application_notes').select('id,body,author,created_at').eq('application_id', id).order('created_at'),
    sb.from('provision_runs').select('result,created_at').eq('application_id', id).maybeSingle(),
  ]);
  if (!app.data) return null;
  return { app: app.data, locations: locs.data ?? [], licenses: lic.data ?? [], owners: own.data ?? [], documents: docs.data ?? [], signatures: sig.data ?? [], sms: sms.data ?? [], events: ev.data ?? [], notes: notes.data ?? [], run: run.data ?? null };
}

function FileButton({ doc }: { doc: J | undefined }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!doc) return <span className="text-sm text-red-300">No file uploaded</span>;
  async function open() {
    setBusy(true); setErr(null);
    try {
      const r = await adminPost<{ url: string }>('file-url', { document_id: doc!.id });
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (e) { setErr(adminMessage(e)); } finally { setBusy(false); }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="underline text-red-400 hover:text-white min-h-[44px] px-1 disabled:opacity-50" onClick={open} disabled={busy} aria-label={`View ${doc.original_name ?? 'file'}`}>{busy ? 'Opening…' : 'View file'}</button>
      <span className="text-xs text-smoke">{doc.original_name} · {(doc.size_bytes / 1024).toFixed(0)} KB</span>
      {doc.scan_status !== 'clean' && <span className="text-xs text-amber-300">scan: {doc.scan_status}</span>}
      {err && <ErrorText>{err}</ErrorText>}
    </span>
  );
}

function EinRow({ id, last4 }: { id: string; last4: string | null }) {
  const [ein, setEin] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function reveal() {
    setBusy(true); setErr(null);
    try { setEin((await adminPost<{ ein: string }>('reveal-ein', { application_id: id })).ein); setTimeout(() => setEin(null), 30000); }
    catch (e) { setErr(adminMessage(e)); } finally { setBusy(false); }
  }
  return (
    <span>
      {ein ? <strong className="tabular-nums" aria-live="polite">{ein}</strong> : <span className="tabular-nums">{last4 ? `••-•••${last4}` : 'Not provided'}</span>}{' '}
      {last4 && !ein && <button type="button" className="underline text-red-400 text-sm min-h-[44px] px-1" onClick={reveal} disabled={busy}>{busy ? 'Decrypting…' : 'Reveal (logged)'}</button>}
      {ein && <span className="text-xs text-smoke"> hides again in 30 s</span>}
      {err && <ErrorText>{err}</ErrorText>}
    </span>
  );
}

function Detail() {
  const id = useSearchParams().get('id') ?? '';
  const [d, setD] = useState<Detail | null | undefined>(undefined);
  const [modal, setModal] = useState<null | 'info' | 'reject' | 'approve'>(null);
  const [text, setText] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [approved, setApproved] = useState<J | null>(null);

  const reload = useCallback(async () => setD(await load(id)), [id]);
  useEffect(() => { void reload(); }, [reload]);

  if (d === undefined) return <div aria-busy="true" className="grid gap-3"><SkeletonOrderCard /><SkeletonOrderCard /><SkeletonOrderCard /></div>;
  if (d === null) return <Card><p className="mb-3">Application not found.</p><Link href="/admin/" className={btnGhost}>Back to the queue</Link></Card>;

  const a = d.app;
  const docById = new Map(d.documents.map((x) => [x.id, x]));
  const m = a.mailing_address ?? {};
  const ops = a.operations ?? {};
  const provisioned = d.run?.result as J | undefined;
  const canReview = a.status === 'submitted';
  const canAsk = ['submitted', 'in_review'].includes(a.status);
  const canReject = ['submitted', 'in_review', 'needs_info'].includes(a.status);
  const canApprove = ['submitted', 'in_review'].includes(a.status);
  const anyExpired = d.licenses.some((l) => l.expiry && new Date(l.expiry + 'T00:00:00') < new Date(new Date().toDateString()));

  const close = () => { setModal(null); setText(''); setErr(null); setApproved(null); };

  async function doStatus(to: 'in_review' | 'needs_info' | 'rejected') {
    setBusy(true); setErr(null);
    try {
      const r = await adminPost<{ emailed?: boolean }>('application-status', { application_id: id, to, message: text });
      setFlash(to === 'in_review' ? 'Moved to in review.' : r.emailed ? 'Done. The applicant was emailed.' : 'Done, but the email could not be sent. Contact the applicant another way.');
      close(); await reload();
    } catch (e) { setErr(adminMessage(e)); } finally { setBusy(false); }
  }
  async function doApprove() {
    setBusy(true); setErr(null);
    try { setApproved(await adminPost<J>('approve', { application_id: id })); await reload(); }
    catch (e) { setErr(adminMessage(e)); } finally { setBusy(false); }
  }
  async function resend() {
    setBusy(true);
    try { const r = await adminPost<{ emailed: boolean }>('resend-invite', { application_id: id }); setFlash(r.emailed ? 'New invite emailed to the owner.' : 'A new link was created but the email failed to send.'); }
    catch (e) { setFlash(adminMessage(e)); } finally { setBusy(false); }
  }
  async function addNote() {
    if (!note.trim()) return;
    setBusy(true);
    const { error } = await supabase().rpc('admin_add_note', { p_app: id, p_body: note });
    setBusy(false);
    if (error) return setFlash('Could not save the note.');
    setNote(''); await reload();
  }

  const timeline = [
    ...d.events.filter((e) => e.type !== 'note').map((e) => ({ at: e.created_at, text: EVENT[e.type] ?? e.type, sub: e.detail?.message as string | undefined, who: e.actor as string })),
    ...d.notes.map((n) => ({ at: n.created_at, text: 'Internal note', sub: n.body as string, who: 'admin' })),
  ].sort((x, y) => x.at.localeCompare(y.at));

  return (
    <div className="grid gap-4">
      <div><Link href="/admin/" className="text-sm underline text-smoke">← Applications</Link></div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-display font-extrabold text-3xl tracking-tight">{a.legal_name ?? a.full_name}</h1>
          <p className="text-smoke text-sm mt-1">{a.dba ? `DBA ${a.dba} · ` : ''}Submitted {fmtDate(a.submitted_at)}</p>
        </div>
        <StatusBadge status={a.status} />
      </div>

      {flash && <div role="status"><Notice>{flash}</Notice></div>}
      {anyExpired && <Notice tone="warn"><strong>Expired permit.</strong> At least one permit on this application is past its expiry date.</Notice>}
      {a.status === 'needs_info' && a.info_request && <Notice tone="warn"><strong>Waiting on applicant:</strong> {a.info_request}</Notice>}
      {a.status === 'rejected' && a.reject_reason && <Notice><strong>Rejected:</strong> {a.reject_reason}</Notice>}

      <Card className="flex flex-wrap gap-3 items-center">
        {canReview && <button className={btnGhost} onClick={async () => { setBusy(true); try { await adminPost('application-status', { application_id: id, to: 'in_review' }); setFlash('Moved to in review.'); await reload(); } catch (e) { setFlash(adminMessage(e)); } finally { setBusy(false); } }} disabled={busy}>Start review</button>}
        {canAsk && <button className={btnGhost} onClick={() => { setText(''); setModal('info'); }}>Request info</button>}
        {canApprove && <button className={btnPrimary} onClick={() => setModal('approve')}>Approve…</button>}
        {canReject && <button className={btnGhost} onClick={() => { setText(''); setModal('reject'); }}>Reject…</button>}
        {a.status === 'approved' && <button className={btnGhost} onClick={resend} disabled={busy}>Resend owner invite</button>}
        {!canReview && !canAsk && !canReject && a.status !== 'approved' && <span className="text-sm text-smoke">No actions available for {a.status.replace('_', ' ')} applications.</span>}
      </Card>

      {provisioned && (
        <Section title="Provisioned">
          <Dl rows={[['License key', <code key="k" className="font-bold tracking-wide">{provisioned.license_key}</code>], ['Plan', provisioned.plan_type], ['Features', (provisioned.features ?? []).join(', ')],
            ['Locations', (provisioned.locations ?? []).map((l: J) => l.name).join(', ')], ['Owner invite', provisioned.owner_email]]} />
        </Section>
      )}

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Section title="Contact">
          <Dl rows={[['Name', a.full_name], ['Role', a.contact_role], ['Email', <>{a.email} {a.email_verified_at ? <span className="text-green-400 text-xs">✓ verified</span> : <span className="text-amber-300 text-xs">unverified</span>}</>], ['Phone', a.phone]]} />
        </Section>
        <Section title="Business">
          <Dl rows={[['Legal name', a.legal_name], ['DBA', a.dba], ['Entity', a.entity_type], ['EIN', <EinRow key="e" id={id} last4={a.ein_last4} />], ['Years', a.years_in_business],
            ['Business email', a.business_email], ['Business phone', a.business_phone], ['Website', a.website], ['Mailing', [m.street, m.city, m.state, m.zip].filter(Boolean).join(', ')], ['KYC', `${a.kyc_status} (processor step not connected)`]]} />
        </Section>
      </div>

      <Section title={`Locations (${d.locations.length})`}>
        <div className="grid gap-4">
          {d.locations.map((l) => (
            <div key={l.id} className="rounded-xl border border-line p-3">
              <div className="font-semibold">{l.name}</div>
              <div className="text-sm text-smoke">{[l.street, l.city, l.state, l.zip].filter(Boolean).join(', ')} · {l.phone}</div>
              <ul className="mt-2 grid gap-2">
                {d.licenses.filter((x) => x.location_id === l.id).map((x) => (
                  <li key={x.id} className="grid sm:grid-cols-[14rem_1fr] gap-x-3 gap-y-1 text-sm border-t border-line pt-2">
                    <div><div className="font-medium">{PERMIT[x.kind] ?? x.kind}</div><div className="text-smoke">#{x.number ?? '—'}</div></div>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span>{x.expiry ? `Expires ${fmtDate(x.expiry + 'T00:00:00')}` : 'No expiry date'}</span>
                      <PermitBadge expiry={x.expiry} />
                      <FileButton doc={docById.get(x.document_id)} />
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Section>

      <Section title={`Owners (${d.owners.length})`}>
        <ul className="grid gap-2">
          {d.owners.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 text-sm border-t border-line first:border-0 pt-2 first:pt-0">
              <span><strong>{o.full_name}</strong> · {o.title ?? '—'} · {o.ownership_pct}%{o.is_control_person && <span className="ml-2 text-xs rounded bg-steel px-2 py-0.5">control person</span>}</span>
              <FileButton doc={docById.get(o.id_document_id)} />
            </li>
          ))}
        </ul>
      </Section>

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Section title="Operations and plan">
          <Dl rows={[['Plan', a.plan_model], ['Add-ons', (a.addons ?? []).join(', ')], ['Hardware', a.hardware_selection ? `${a.hardware_selection.mode}${a.hardware_selection.bundle_slug ? ` (${a.hardware_selection.bundle_slug})` : ''}` : null],
            ['Current POS', ops.current_pos], ['Processor', ops.current_processor], ['Monthly sales', ops.monthly_sales_range], ['Card %', ops.card_pct], ['Avg ticket', ops.avg_ticket],
            ['Registers', ops.registers], ['Employees', ops.employees], ['Products', (ops.product_mix ?? []).join(', ')], ['Current costs', [ops.current_software_cost, ops.current_processing_cost].some((x) => x != null) ? `software ${ops.current_software_cost ?? '—'} / processing ${ops.current_processing_cost ?? '—'}` : null]]} />
        </Section>
        <Section title="Agreements and consent">
          <ul className="grid gap-2 text-sm">
            {d.signatures.map((s, i) => (
              <li key={i} className="border-t border-line first:border-0 pt-2 first:pt-0">
                <div className="font-medium">{s.agreement_versions?.kind?.replace('_', ' ')} · v{s.agreement_versions?.version}</div>
                <div className="text-smoke">Signed “{s.typed_name}” on {s.signed_on} ({fmtDateTime(s.signed_at)})</div>
                <div className="text-xs text-smoke break-all">IP {s.ip} · {s.user_agent}</div>
                <div className="text-xs text-smoke break-all">sha256 {s.agreement_versions?.body_sha256}</div>
              </li>
            ))}
            {d.signatures.length === 0 && <li className="text-smoke">Not signed yet.</li>}
            <li className="border-t border-line pt-2"><div className="font-medium">21+ / compliance acknowledgement</div><div className="text-smoke">{a.compliance_ack_at ? `${fmtDateTime(a.compliance_ack_at)} (${a.compliance_ack_version})` : 'Not acknowledged'}</div></li>
            <li className="border-t border-line pt-2"><div className="font-medium">SMS consent</div>
              {d.sms[0] ? <div className="text-smoke">{d.sms[0].consented ? 'Opted in' : 'Did not opt in'} · {d.sms[0].consent_text_version} · {fmtDateTime(d.sms[0].created_at)}<div className="text-xs break-all">IP {d.sms[0].ip}</div></div> : <div className="text-smoke">No record</div>}</li>
          </ul>
        </Section>
      </div>

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <Section title="Internal notes">
          <ul className="grid gap-2 text-sm mb-3">
            {d.notes.map((n) => <li key={n.id} className="border-t border-line first:border-0 pt-2 first:pt-0"><div className="text-xs text-smoke">{fmtDateTime(n.created_at)}</div><div className="whitespace-pre-wrap">{n.body}</div></li>)}
            {d.notes.length === 0 && <li className="text-smoke">No notes yet. Notes are never shown to the applicant.</li>}
          </ul>
          <label htmlFor="note" className="sr-only">New note</label>
          <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} className="w-full rounded-lg bg-steel border border-line px-3 py-2 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ember" placeholder="Add an internal note" />
          <button className={`${btnGhost} mt-2`} onClick={addNote} disabled={busy || !note.trim()}>Add note</button>
        </Section>
        <Section title="Activity">
          <ol className="grid gap-2 text-sm">
            {timeline.map((t, i) => (
              <li key={i} className="border-t border-line first:border-0 pt-2 first:pt-0">
                <div><span className="font-medium">{t.text}</span> <span className="text-xs text-smoke">{fmtDateTime(t.at)}</span></div>
                {t.sub && <div className="text-smoke whitespace-pre-wrap">{t.sub}</div>}
              </li>
            ))}
          </ol>
        </Section>
      </div>

      <Modal open={modal === 'info'} title="Request information" onClose={close}>
        <p className="text-sm text-smoke">The applicant gets an email with this message and a link to upload documents. Status becomes “needs info”.</p>
        <textarea aria-label="What do you need from them?" rows={5} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-lg bg-steel border border-line px-3 py-2 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ember"
          placeholder="Example: Please upload a clearer copy of the sales tax permit for Main St. The expiry date is cut off." />
        <ErrorText>{err}</ErrorText>
        <div className="flex gap-3 justify-end"><button className={btnGhost} onClick={close}>Cancel</button><button className={btnPrimary} onClick={() => doStatus('needs_info')} disabled={busy || text.trim().length < 10}>{busy ? 'Sending…' : 'Send request'}</button></div>
      </Modal>

      <Modal open={modal === 'reject'} title="Reject application" onClose={close}>
        <p className="text-sm text-smoke">The applicant is emailed this reason and sees it on their status page.</p>
        <textarea aria-label="Reason for rejection" rows={4} value={text} onChange={(e) => setText(e.target.value)} className="w-full rounded-lg bg-steel border border-line px-3 py-2 text-ink focus:outline-none focus-visible:ring-2 focus-visible:ring-ember" />
        <ErrorText>{err}</ErrorText>
        <div className="flex gap-3 justify-end"><button className={btnGhost} onClick={close}>Cancel</button><button className={btnPrimary} onClick={() => doStatus('rejected')} disabled={busy || text.trim().length < 10}>{busy ? 'Rejecting…' : 'Reject application'}</button></div>
      </Modal>

      <Modal open={modal === 'approve'} title={approved ? 'Approved' : 'Approve and provision?'} onClose={close}>
        {!approved ? (
          <>
            {anyExpired && <Notice tone="warn">A permit on this application is expired. Approve only if you have confirmed a renewal.</Notice>}
            <p className="text-sm">This creates, once:</p>
            <ul className="text-sm list-disc pl-5 grid gap-1">
              <li>the business <strong>{a.legal_name}</strong> with one activation key</li>
              <li>{d.locations.length} location{d.locations.length === 1 ? '' : 's'} (online storefront stays off until the owner publishes)</li>
              <li>plan <strong>{a.plan_model === 'model_a' ? 'Full POS' : 'Storefront only'}</strong> with feature flags{(a.addons ?? []).length ? ` for ${(a.addons ?? []).join(', ')}` : ''}</li>
              <li>an invite email to <strong>{a.email}</strong> so the owner creates their own password</li>
            </ul>
            <p className="text-xs text-smoke">Safe to click only once: a second click returns the same business and sends nothing.</p>
            <ErrorText>{err}</ErrorText>
            <div className="flex gap-3 justify-end"><button className={btnGhost} onClick={close} disabled={busy}>Cancel</button><button className={btnPrimary} onClick={doApprove} disabled={busy}>{busy ? 'Provisioning…' : 'Approve and provision'}</button></div>
          </>
        ) : (
          <>
            <Notice>{approved.already_provisioned ? 'Already provisioned. Nothing new was created or sent.' : approved.emailed ? 'Provisioned. The owner was emailed their invite.' : 'Provisioned, but the invite email failed. Use “Resend owner invite”.'}</Notice>
            <Dl rows={[['License key', <code key="k" className="font-bold">{approved.license_key}</code>], ['Features', (approved.features ?? []).join(', ')], ['Locations', (approved.locations ?? []).map((l: J) => l.name).join(', ')]]} />
            <div className="flex justify-end"><button className={btnPrimary} onClick={close}>Done</button></div>
          </>
        )}
      </Modal>
    </div>
  );
}

export default function Page() {
  return <Suspense fallback={<div className="skel h-64" aria-busy="true" />}><Detail /></Suspense>;
}
