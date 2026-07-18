import type { Formatter } from './index.ts';
import { generic } from './generic.ts';

// RJ Reynolds (RJRT) — Camel/Newport/etc. scan-data program.
// TODO(certification): replace with RJR's confirmed file spec + naming.
export const rjr: Formatter = {
  filename: generic.filename,
  format: generic.format,
};
