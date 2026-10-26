'use client';
import { useId, useRef, useState } from 'react';
import { messageFor, uploadDocument } from '@/lib/onboarding/api';
import type { DocumentDto } from '@/lib/onboarding/types';
import { btnGhost, ErrorText } from './fields';

/**
 * Document picker. The row it attaches to (location or owner) must exist on the server first, so the
 * wizard's ensureSaved() runs before the upload starts.
 */
export function FileUpload(props: {
  label: string;
  kind: string;
  locationId?: string;
  ownerId?: string;
  doc?: DocumentDto | null;
  docId?: string | null;
  ensureSaved: () => Promise<void>;
  onUploaded: (docId: string, name: string) => void;
  error?: string;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [name, setName] = useState<string | null>(null);

  async function onPick(file: File | undefined) {
    if (!file) return;
    setErr(null);
    setBusy(true);
    try {
      await props.ensureSaved();
      const docId = await uploadDocument(file, { kind: props.kind, location_id: props.locationId, owner_id: props.ownerId });
      setName(file.name);
      props.onUploaded(docId, file.name);
    } catch (e) {
      setErr(messageFor(e));
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  }

  const has = !!props.docId;
  const shown = name ?? props.doc?.original_name ?? (has ? 'Uploaded file' : null);
  const problem = err ?? props.error;

  return (
    <div>
      <span id={`${id}-label`} className="block text-sm font-semibold mb-1">{props.label}</span>
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          id={id}
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          className="sr-only"
          aria-labelledby={`${id}-label`}
          aria-describedby={problem ? `${id}-err` : `${id}-hint`}
          onChange={(e) => void onPick(e.target.files?.[0])}
        />
        <label htmlFor={id} className={`${btnGhost} cursor-pointer ${busy ? 'opacity-60 pointer-events-none' : ''}`}>
          {busy ? 'Uploading…' : has ? 'Replace file' : 'Choose file'}
        </label>
        {has && shown && <span className="text-sm text-green-400 break-all" aria-live="polite">✓ {shown}</span>}
      </div>
      <p id={`${id}-hint`} className="mt-1 text-xs text-smoke">PDF, JPG or PNG, up to 10 MB.</p>
      <ErrorText id={`${id}-err`}>{problem}</ErrorText>
    </div>
  );
}
