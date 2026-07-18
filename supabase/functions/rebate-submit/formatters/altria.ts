import type { Formatter } from './index.ts';
import { generic } from './generic.ts';

// Altria (PM) — Marlboro/Copenhagen/etc. scan-data program.
// TODO(certification): replace format()/filename() with Altria's confirmed fixed
// column spec + naming convention once received. Currently delegates to the
// generic CSV so submissions can be exercised end-to-end before certification.
export const altria: Formatter = {
  filename: generic.filename,
  format: generic.format,
};
