import type { ApplicationDto, Draft, LocationDto, OwnerDto } from '@/lib/onboarding/types';

export interface LegalState {
  typedName: string;
  agree: boolean;
  compliance: boolean;
  sms: boolean;
}

export interface WizardCtx {
  updateApp: (p: Partial<ApplicationDto>) => void;
  setLocations: (l: LocationDto[]) => void;
  setOwners: (o: OwnerDto[]) => void;
  /** Flushes pending autosave; resolves when the server has the latest rows (needed before uploads). */
  ensureSaved: () => Promise<void>;
  /** Error for a field key, only once the user has touched it or tried to continue. */
  err: (key: string) => string | undefined;
  touch: (key: string) => void;
  einInput: string;
  setEinInput: (v: string) => void;
  legal: LegalState;
  setLegal: (p: Partial<LegalState>) => void;
  goTo: (step: number) => void;
  /** Step 1 only: called after the draft is created or the email is verified. */
  reload: (token?: string) => Promise<void>;
}

export interface StepProps {
  draft: Draft;
  ctx: WizardCtx;
}
