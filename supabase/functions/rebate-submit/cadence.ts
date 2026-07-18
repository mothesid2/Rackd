// Cadence math: given a manufacturer's report schedule, decide whether a report
// is due and what period it covers. All date-only, UTC (store-timezone nuances
// are ignored at the day granularity we submit on).
//
//   Altria: batch ends Sat (6), due Tue (2) the following week.
//   RJR:    batch ends Sun (0), due Wed (3) the following week.

export interface Cadence {
  batch_end_dow: number | null; // 0=Sun … 6=Sat
  due_dow: number | null;
  due_offset_weeks: number;
}

function dateOnly(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
}
function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
// The date <= `from` whose weekday is `dow`, going back `weeksAgo` extra weeks.
function recentDow(from: Date, dow: number, weeksAgo: number): Date {
  const back = (from.getUTCDay() - dow + 7) % 7;
  return addDays(from, -(back + weeksAgo * 7));
}
// Days from a batch-end to its due date (next `due_dow` strictly after the end,
// then extra whole weeks per due_offset_weeks; offset 1 = that first occurrence).
function daysToDue(endDow: number, dueDow: number, offsetWeeks: number): number {
  const first = ((dueDow - endDow + 7) % 7) || 7;
  return first + Math.max(0, offsetWeeks - 1) * 7;
}

/**
 * The most recent batch period whose due date is on or before `today` — i.e. the
 * report that should have been submitted by now. Returns null if the cadence is
 * unconfigured (e.g. ITG pre-certification). Looks back a few weeks so a missed
 * run still catches up.
 */
export function dueNow(c: Cadence, today: Date): { start: string; end: string; dueDate: string } | null {
  if (c.batch_end_dow == null || c.due_dow == null) return null;
  const t = dateOnly(today);
  const offset = c.due_offset_weeks || 1;
  for (let w = 0; w < 5; w++) {
    const end = recentDow(t, c.batch_end_dow, w);
    const due = addDays(end, daysToDue(c.batch_end_dow, c.due_dow, offset));
    if (due.getTime() <= t.getTime()) {
      return { start: iso(addDays(end, -6)), end: iso(end), dueDate: iso(due) };
    }
  }
  return null;
}
