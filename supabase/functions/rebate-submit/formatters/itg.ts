import type { Formatter } from './index.ts';
import { generic } from './generic.ts';

// ITG Brands — Winston/Kool/etc. Cadence + file spec TBD during certification.
// TODO(certification): replace with ITG's confirmed file spec + naming.
export const itg: Formatter = {
  filename: generic.filename,
  format: generic.format,
};
