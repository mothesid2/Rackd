'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { api, ApiError, currentToken, messageFor } from '@/lib/onboarding/api';
import type { AppStatus, StatusDto } from '@/lib/onboarding/types';
import { btnPrimary, Card, ErrorText, Notice } from '@/components/onboarding/fields';
import { FileUpload } from '@/components/onboarding/FileUpload';
import { Turnstile } from '@/components/onboarding/Turnstile';
import { SkeletonOrderCard } from '@/components/ui/Skeleton';

const COPY: Record<AppStatus, { title: string; body: string }> = {
  draft: { title: 'Your application is not submitted yet', body: 'Pick up where you left off to finish and submit it.' },
  submitted: { title: 'We received your application', body: 'Our team will review it soon. We will email you if we need anything else. You do not need to do anything right now.' },
  in_review: { title: 'Your application is being reviewed', body: 'A member of our team is checking your details and permits. We will email you as soon as there is news.' },
  needs_info: { title: 'We need a little more information', body: 'Please see the request below, send what we asked for, then let us know you are done.' },
  approved: { title: 'You are approved', body: 'Welcome to Rackd. Check your email for an invitation to set up your login.' },
  rejected: { title: 'We could not approve this application', body: 'The reason is below. If you think this is a mistake, reply to any email from us or write to support@r4ckd.net.' },
  activated: { title: 'Your account is active', body: 'You have signed in for the first time. Your shop is set up on Rackd.' },
};

const EVENT_LABEL: Record<string, string> = {
  submitted: 'Application received', info_provided: 'You sent the requested information', status_in_review: 'Review started',
  status_needs_info: 'We asked for more information', status_rejected: 'Application declined', approved: 'Application approved', activated: 'Account activated',
};

export default function SubmittedPage() {
  const [state, setState] = useState<'loading' | 'none' | 'error' | 'ready'>('loading');
  const [s, setS] = useState<StatusDto | null>(null);

  const load = useCallback(async () => {
    if (!currentToken()) return setState('none');
    try {
      setS(await api.status());
      setState('ready');
    } catch (e) {
      setState(e instanceof ApiError && e.status === 401 ? 'none' : 'error');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (state === 'loading') return <div className="grid gap-3" aria-busy="true"><SkeletonOrderCard /><SkeletonOrderCard /></div>;
  if (state === 'none') {
    return (
      <Card>
        <h1 className="font-display font-bold text-2xl mb-2">Check your application status</h1>
        <p className="text-sm text-smoke mb-4">Open the link in the email we sent you, or request a new one from the start page.</p>
        <Link href="/get-started/" className={btnPrimary}>Go to the start page</Link>
      </Card>
    );
  }
  if (state === 'error' || !s) {
    return (
      <div className="grid gap-3">
        <Notice tone="warn">We could not load your status right now.</Notice>
        <div><button className={btnPrimary} onClick={() => { setState('loading'); void load(); }}>Try again</button></div>
      </div>
    );
  }

  const copy = COPY[s.status];
  return (
    <div className="grid gap-4">
      <div>
        <p className="eyebrow text-red-400">Application status</p>
        <h1 className="font-display font-extrabold text-3xl tracking-tight" tabIndex={-1}>{copy.title}</h1>
        {s.legal_name && <p className="text-smoke mt-1">{s.legal_name}</p>}
      </div>
      <Card>
        <p className="text-[15px] leading-relaxed" role="status">{copy.body}</p>
        {s.status === 'rejected' && s.reject_reason && <div className="mt-3"><Notice tone="warn"><strong>Reason:</strong> {s.reject_reason}</Notice></div>}
        {s.status === 'draft' && <Link href="/get-started/" className={`${btnPrimary} mt-4`}>Continue application</Link>}
      </Card>

      {s.status === 'needs_info' && <InfoRequest s={s} onDone={load} />}

      {s.events.length > 0 && (
        <Card>
          <h2 className="font-display font-bold text-lg mb-2">Timeline</h2>
          <ol className="grid gap-2 text-sm">
            {s.events.map((e, i) => (
              <li key={i} className="flex flex-wrap gap-x-3">
                <time className="text-smoke tabular-nums" dateTime={e.at}>{new Date(e.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</time>
                <span>{EVENT_LABEL[e.type] ?? e.type}{e.message && e.type.startsWith('status_') ? `: ${e.message}` : ''}</span>
              </li>
            ))}
          </ol>
        </Card>
      )}
    </div>
  );
}

function InfoRequest({ s, onDone }: { s: StatusDto; onDone: () => void }) {
  const [files, setFiles] = useState<string[]>([]);
  const [ts, setTs] = useState('');
  const [tsKey, setTsKey] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [slot, setSlot] = useState(0); // remount the picker so several files can be added

  async function done() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api.submit(ts);
      if (!r.ok) {
        setErr(`Some details still need attention: ${(r.errors ?? []).join(' ')}`);
        setTsKey((k) => k + 1);
        return;
      }
      onDone();
    } catch (e) {
      setErr(messageFor(e));
      setTsKey((k) => k + 1);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <h2 className="font-display font-bold text-lg mb-2">What we need</h2>
      <p className="text-[15px] leading-relaxed mb-4 whitespace-pre-wrap">{s.info_request}</p>
      <FileUpload
        key={slot} label="Upload a document" kind="requested_info"
        ensureSaved={async () => undefined}
        docId={null}
        onUploaded={(_id, name) => { setFiles((f) => [...f, name]); setSlot((n) => n + 1); }}
      />
      {files.length > 0 && (
        <ul className="mt-3 text-sm text-green-400 grid gap-0.5" aria-label="Files you sent">
          {files.map((f, i) => <li key={i}>✓ {f}</li>)}
        </ul>
      )}
      <p className="mt-4 text-sm text-smoke">Need to correct something in your application instead? <Link href="/get-started/" className="underline">Edit your application</Link>, then come back here.</p>
      <div className="mt-4"><Turnstile action="submit" onToken={setTs} resetKey={tsKey} /></div>
      <ErrorText>{err}</ErrorText>
      <button className={`${btnPrimary} mt-3`} disabled={busy || !ts} onClick={done}>{busy ? 'Sending…' : 'I have sent everything'}</button>
    </Card>
  );
}
