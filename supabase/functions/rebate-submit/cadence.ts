


export interface Cadence {
  batch_end_dow: number | null; 
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

function recentDow(from: Date, dow: number, weeksAgo: number): Date {
  const back = (from.getUTCDay() - dow + 7) % 7;
  return addDays(from, -(back + weeksAgo * 7));
}

function daysToDue(endDow: number, dueDow: number, offsetWeeks: number): number {
  const first = ((dueDow - endDow + 7) % 7) || 7;
  return first + Math.max(0, offsetWeeks - 1) * 7;
}


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
