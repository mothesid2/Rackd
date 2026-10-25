'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, ApiError, clearToken, currentToken, messageFor } from '@/lib/onboarding/api';
import { STEP_TITLES, type ApplicationDto, type Draft, type LocationDto, type OwnerDto } from '@/lib/onboarding/types';
import {
  validateAccount, validateAgreements, validateBusiness, validateLocations, validateOperations,
  validateOwners, validatePlan, type Errors,
} from '@/lib/onboarding/validate';
import { SkeletonOrderCard } from '../ui/Skeleton';
import { btnGhost, btnPrimary, ErrorText, Notice } from './fields';
import { AccountCreate, AccountStep } from './steps/AccountStep';
import { AgreementsStep } from './steps/AgreementsStep';
import { BusinessStep } from './steps/BusinessStep';
import { HardwareStep } from './steps/HardwareStep';
import { LocationsStep, newLocation } from './steps/LocationsStep';
import { OperationsStep } from './steps/OperationsStep';
import { newOwner, OwnersStep } from './steps/OwnersStep';
import { PlanStep } from './steps/PlanStep';
import { ReviewStep } from './steps/ReviewStep';
import type { LegalState, WizardCtx } from './steps/types';

const SAVEABLE = [
  'full_name', 'phone', 'contact_role', 'legal_name', 'dba', 'entity_type', 'years_in_business', 'business_email',
  'business_phone', 'website', 'mailing_address', 'location_count', 'operations', 'plan_model', 'addons',
  'hardware_selection', 'current_step',
] as const;

type SaveState = 'idle' | 'saving' | 'saved' | 'error';
interface Dirty { patch: Record<string, true>; locations: boolean; owners: boolean }
const clean = (): Dirty => ({ patch: {}, locations: false, owners: false });

export default function Wizard() {
  const router = useRouter();
  const [phase, setPhase] = useState<'loading' | 'new' | 'ready' | 'error'>('loading');
  const [draft, setDraft] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const [step, setStep] = useState(1);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  const [navErr, setNavErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const [attempted, setAttempted] = useState(false);
  const [einInput, setEinInputState] = useState('');
  const einRef = useRef('');
  const [legal, setLegalState] = useState<LegalState>({ typedName: '', agree: false, compliance: false, sms: false });
  const [devCode, setDevCode] = useState<string | undefined>();
  const dirty = useRef<Dirty>(clean());
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const chain = useRef<Promise<void>>(Promise.resolve());
  const heading = useRef<HTMLHeadingElement>(null);
  const maxRef = useRef(1); // furthest step reached, so stepping back does not lock later steps

  const setDraftBoth = useCallback((fn: (d: Draft) => Draft) => {
    const next = fn(draftRef.current as Draft);
    draftRef.current = next;
    setDraft(next);
  }, []);

  // ------------------------------------------------------------ loading
  const load = useCallback(async (initial: boolean) => {
    if (!currentToken()) { setPhase('new'); return; }
    try {
      const d = await api.get();
      if (!['draft', 'needs_info'].includes(d.application.status)) { router.replace('/get-started/submitted/'); return; }
      draftRef.current = d;
      maxRef.current = Math.max(maxRef.current, d.application.current_step);
      setDraft(d);
      setLegalState({
        typedName: d.signatures[0]?.typed_name ?? '',
        agree: d.signatures.length >= 2,
        compliance: !!d.application.compliance_ack_at,
        sms: d.sms_consent?.consented ?? false,
      });
      if (initial) setStep(d.application.email_verified_at ? Math.min(Math.max(d.application.current_step, 1), 9) : 1);
      setPhase('ready');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) { clearToken(); setPhase('new'); return; }
      setPhase('error');
    }
  }, [router]);

  useEffect(() => { void load(true); }, [load]);

  // ------------------------------------------------------------ autosave
  const flush = useCallback((): Promise<void> => {
    chain.current = chain.current.catch(() => undefined).then(async () => {
      const d = dirty.current;
      const cur = draftRef.current;
      const ein = einRef.current.trim();
      const keys = Object.keys(d.patch);
      if (!cur || (!keys.length && !d.locations && !d.owners && !ein)) return;
      dirty.current = clean();
      const parts: Parameters<typeof api.save>[0] = {};
      if (keys.length) parts.patch = Object.fromEntries(keys.map((k) => [k, (cur.application as unknown as Record<string, unknown>)[k]]));
      if (d.locations) parts.locations = cur.locations;
      if (d.owners) parts.owners = cur.owners;
      if (ein) parts.ein = ein;
      setSaveState('saving');
      try {
        await api.save(parts);
        setSaveMsg(null);
        setSaveState('saved');
        if (ein) {
          const digits = ein.replace(/\D/g, '');
          if (einRef.current.trim() === ein) { einRef.current = ''; setEinInputState(''); }
          setDraftBoth((x) => ({ ...x, application: { ...x.application, ein_set: true, ein_last4: digits.slice(-4) } }));
        }
      } catch (e) {
        // put the flags back so the next attempt resends everything
        dirty.current = {
          patch: { ...d.patch, ...dirty.current.patch },
          locations: d.locations || dirty.current.locations,
          owners: d.owners || dirty.current.owners,
        };
        setSaveState('error');
        setSaveMsg(messageFor(e));
        throw e;
      }
    });
    return chain.current;
  }, [setDraftBoth]);

  const schedule = useCallback((ms = 1200) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { flush().catch(() => schedule(6000)); }, ms);
  }, [flush]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    const onHide = () => { if (document.visibilityState === 'hidden') flush().catch(() => undefined); };
    const onUnload = (e: BeforeUnloadEvent) => {
      const d = dirty.current;
      if (Object.keys(d.patch).length || d.locations || d.owners || einRef.current.trim()) { e.preventDefault(); e.returnValue = ''; }
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('beforeunload', onUnload);
    return () => { document.removeEventListener('visibilitychange', onHide); window.removeEventListener('beforeunload', onUnload); };
  }, [flush]);

  // ------------------------------------------------------------ mutations
  const updateApp = useCallback((p: Partial<ApplicationDto>) => {
    setDraftBoth((d) => ({ ...d, application: { ...d.application, ...p } }));
    for (const k of Object.keys(p)) if ((SAVEABLE as readonly string[]).includes(k)) dirty.current.patch[k] = true;
    schedule();
  }, [schedule, setDraftBoth]);

  const setLocations = useCallback((l: LocationDto[] | ((prev: LocationDto[]) => LocationDto[])) => {
    setDraftBoth((d) => ({ ...d, locations: typeof l === 'function' ? l(d.locations) : l }));
    dirty.current.locations = true;
    schedule();
  }, [schedule, setDraftBoth]);

  const setOwners = useCallback((o: OwnerDto[] | ((prev: OwnerDto[]) => OwnerDto[])) => {
    setDraftBoth((d) => ({ ...d, owners: typeof o === 'function' ? o(d.owners) : o }));
    dirty.current.owners = true;
    schedule();
  }, [schedule, setDraftBoth]);

  const setEinInput = useCallback((v: string) => { einRef.current = v; setEinInputState(v); schedule(2500); }, [schedule]);
  const setLegal = useCallback((p: Partial<LegalState>) => setLegalState((s) => ({ ...s, ...p })), []);

  // ------------------------------------------------------------ validation
  const errors: Errors = useMemo(() => {
    if (!draft) return {};
    const a = draft.application;
    switch (step) {
      case 1: return validateAccount(a);
      case 2: return validateBusiness(a, einInput);
      case 3: return validateLocations(draft.locations);
      case 4: return validateOwners(draft.owners);
      case 5: return validateOperations(a.operations ?? {});
      case 6: return validatePlan(a);
      case 8: return validateAgreements(legal);
      default: return {};
    }
  }, [draft, step, einInput, legal]);

  const err = useCallback((key: string) => (attempted || touched[key] ? errors[key] : undefined), [attempted, touched, errors]);
  const touch = useCallback((key: string) => setTouched((t) => (t[key] ? t : { ...t, [key]: true })), []);

  // ------------------------------------------------------------ navigation
  const goTo = useCallback((n: number) => {
    setAttempted(false);
    setTouched({});
    setNavErr(null);
    setStep(n);
    maxRef.current = Math.max(maxRef.current, n);
    updateApp({ current_step: n });
    schedule(0); // save the new step immediately so "resume" lands here even if the tab closes right away
    window.scrollTo({ top: 0 });
  }, [updateApp, schedule]);

  useEffect(() => { heading.current?.focus(); }, [step, phase]);

  // first card on empty repeatable steps
  useEffect(() => {
    if (!draft) return;
    if (step === 3 && draft.locations.length === 0) setLocations([newLocation(1)]);
    if (step === 4 && draft.owners.length === 0) {
      const o = newOwner(true);
      if (draft.application.contact_role === 'owner') o.full_name = draft.application.full_name;
      setOwners([o]);
    }
  }, [step, draft, setLocations, setOwners]);

  async function next() {
    if (!draft || busy) return;
    setAttempted(true);
    setNavErr(null);
    if (step === 1 && !draft.application.email_verified_at) return;
    if (Object.keys(errors).length) {
      setNavErr(`Please fix ${Object.keys(errors).length === 1 ? 'the highlighted field' : 'the highlighted fields'} to continue.`);
      setTimeout(() => (document.querySelector('[aria-invalid="true"]') as HTMLElement | null)?.focus(), 0);
      return;
    }
    setBusy(true);
    try {
      if (step === 8) {
        await api.agreements({ typed_name: legal.typedName.trim(), agree: legal.agree, compliance_ack: legal.compliance, sms_consent: legal.sms });
      }
      await flush();
      goTo(step + 1);
    } catch (e) {
      setNavErr(messageFor(e));
    } finally {
      setBusy(false);
    }
  }

  async function back() {
    if (busy) return;
    setBusy(true);
    try { await flush(); } catch { /* the autosave retry keeps trying; going back is still fine */ }
    setBusy(false);
    goTo(step - 1);
  }

  const ctx: WizardCtx = {
    updateApp, setLocations, setOwners, ensureSaved: flush, err, touch, einInput, setEinInput,
    legal, setLegal, goTo, reload: async () => { await load(false); },
  };

  // ------------------------------------------------------------ render
  if (phase === 'loading') return <div className="grid gap-3" aria-busy="true" aria-label="Loading your application"><SkeletonOrderCard /><SkeletonOrderCard /></div>;
  if (phase === 'error') {
    return (
      <div className="grid gap-3">
        <Notice tone="warn">We could not load your application. Check your connection and try again.</Notice>
        <div><button className={btnPrimary} onClick={() => { setPhase('loading'); void load(true); }}>Try again</button></div>
      </div>
    );
  }

  const maxReached = Math.max(maxRef.current, step);
  const title = STEP_TITLES[step - 1];
  const verified = !!draft?.application.email_verified_at;

  return (
    <div>
      <div className="mb-5">
        <p className="eyebrow text-red-400">Apply to Rackd</p>
        <h1 className="font-display font-extrabold text-3xl tracking-tight">Get started</h1>
      </div>

      {phase === 'ready' && draft && (
        <nav aria-label="Application progress" className="mb-6">
          <div
            role="progressbar" aria-label="Application progress" aria-valuemin={1} aria-valuemax={9} aria-valuenow={step}
            aria-valuetext={`Step ${step} of 9: ${title}`}
            className="h-2 rounded-full bg-steel overflow-hidden"
          >
            <div className="h-full bg-accent transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${(step / 9) * 100}%` }} />
          </div>
          <p className="mt-2 text-sm text-smoke sm:hidden">Step {step} of 9 · {title}</p>
          <ol className="hidden sm:flex gap-1 mt-3 text-xs">
            {STEP_TITLES.map((t, i) => {
              const n = i + 1;
              const canJump = verified && n <= maxReached && n !== step;
              return (
                <li key={t} className="flex-1">
                  <button
                    type="button" disabled={!canJump} aria-current={n === step ? 'step' : undefined}
                    onClick={() => void (async () => { try { await flush(); } catch { /* retried */ } goTo(n); })()}
                    className={`w-full min-h-[44px] rounded-md px-1 text-center transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ember ${
                      n === step ? 'text-ink font-bold border-b-2 border-ember' : canJump ? 'text-smoke hover:text-ink' : 'text-smoke/50'}`}
                  >
                    <span className="tabular-nums">{n}</span> {t}
                  </button>
                </li>
              );
            })}
          </ol>
        </nav>
      )}

      <h2 ref={heading} tabIndex={-1} className="font-display font-bold text-2xl mb-4 focus:outline-none">{phase === 'new' ? 'Create your account' : title}</h2>

      {phase === 'new' && (
        <AccountCreate onCreated={(_t, code) => { setDevCode(code); setPhase('loading'); void load(true); }} />
      )}

      {phase === 'ready' && draft && (
        <>
          {draft.application.status === 'needs_info' && draft.application.info_request && (
            <div className="mb-4"><Notice tone="warn"><strong>We need more information:</strong> {draft.application.info_request}</Notice></div>
          )}
          {step === 1 && <AccountStep draft={draft} ctx={ctx} devCode={devCode} />}
          {step === 2 && <BusinessStep draft={draft} ctx={ctx} />}
          {step === 3 && <LocationsStep draft={draft} ctx={ctx} />}
          {step === 4 && <OwnersStep draft={draft} ctx={ctx} />}
          {step === 5 && <OperationsStep draft={draft} ctx={ctx} />}
          {step === 6 && <PlanStep draft={draft} ctx={ctx} />}
          {step === 7 && <HardwareStep draft={draft} ctx={ctx} />}
          {step === 8 && <AgreementsStep draft={draft} ctx={ctx} />}
          {step === 9 && <ReviewStep draft={draft} ctx={ctx} onBlocked={() => undefined} />}

          <div className="mt-6" aria-live="polite">
            <ErrorText>{navErr}</ErrorText>
          </div>

          {!(step === 1 && !verified) && step < 9 && (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {step > 1 && <button type="button" className={btnGhost} onClick={back} disabled={busy}>Back</button>}
              <button type="button" className={btnPrimary} onClick={next} disabled={busy}>
                {busy ? 'Saving…' : step === 8 ? 'Sign and review' : 'Next'}
              </button>
              <span className="text-xs text-smoke ml-auto" role="status" aria-live="polite">
                {saveState === 'saving' && 'Saving…'}
                {saveState === 'saved' && 'All changes saved'}
                {saveState === 'error' && <span className="text-red-400">{saveMsg ?? 'Could not save.'} Retrying…</span>}
              </span>
            </div>
          )}
          {step === 9 && (
            <div className="mt-4"><button type="button" className={btnGhost} onClick={back}>Back</button></div>
          )}
        </>
      )}
    </div>
  );
}
