'use client';
import { Suspense, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { api, messageFor, setToken } from '@/lib/onboarding/api';
import { btnPrimary, Card, Notice } from '@/components/onboarding/fields';

function Resume() {
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return; // links are single-use; never redeem twice (React strict mode)
    ran.current = true;
    const magic = params.get('token') ?? '';
    if (!/^[0-9a-f]{64}$/.test(magic)) { setError('This link is not valid.'); return; }
    api.resume(magic)
      .then((r) => { setToken(r.resume_token); router.replace('/get-started/'); })
      .catch((e) => setError(messageFor(e) === 'Your session expired. Use the link we emailed you to continue.'
        ? 'This link has already been used or has expired.' : messageFor(e)));
  }, [params, router]);

  if (!error) return <p role="status" className="text-smoke">Opening your application…</p>;
  return (
    <Card>
      <h1 className="font-display font-bold text-2xl mb-2">We could not open that link</h1>
      <Notice tone="warn">{error}</Notice>
      <p className="text-sm text-smoke mt-3">Request a fresh link from the start page by choosing “Already started? Email me a link”.</p>
      <Link href="/get-started/" className={`${btnPrimary} mt-4`}>Go to the start page</Link>
    </Card>
  );
}

export default function ResumePage() {
  return <Suspense fallback={<p role="status" className="text-smoke">Opening your application…</p>}><Resume /></Suspense>;
}
