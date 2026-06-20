import { DateTime } from 'luxon';

export const TZ = 'America/Chicago';

/** Current time as an ISO string in Central Time, e.g. "2024-04-23T16:23:00.000-05:00" */
export function nowCT(): string {
  return DateTime.now().setZone(TZ).toISO() as string;
}

/** Format a stored timestamp string for display: "Apr 23, 2024 4:23 PM" */
export function fmtCT(isoOrSql: string | null | undefined): string {
  if (!isoOrSql) return '—';
  const dt = DateTime.fromISO(isoOrSql, { zone: TZ })
    .isValid
    ? DateTime.fromISO(isoOrSql, { zone: TZ })
    : DateTime.fromSQL(isoOrSql, { zone: TZ });
  return dt.isValid ? dt.toFormat('MMM d, yyyy h:mm a') : isoOrSql;
}

/** Just the date portion: "Apr 23, 2024" */
export function fmtDateCT(isoOrSql: string | null | undefined): string {
  if (!isoOrSql) return '—';
  const dt = DateTime.fromISO(isoOrSql, { zone: TZ }).isValid
    ? DateTime.fromISO(isoOrSql, { zone: TZ })
    : DateTime.fromSQL(isoOrSql, { zone: TZ });
  return dt.isValid ? dt.toFormat('MMM d, yyyy') : isoOrSql;
}

/** Just the time portion: "4:23 PM" */
export function fmtTimeCT(isoOrSql: string | null | undefined): string {
  if (!isoOrSql) return '—';
  const dt = DateTime.fromISO(isoOrSql, { zone: TZ }).isValid
    ? DateTime.fromISO(isoOrSql, { zone: TZ })
    : DateTime.fromSQL(isoOrSql, { zone: TZ });
  return dt.isValid ? dt.toFormat('h:mm a') : isoOrSql;
}

/** Today's date as YYYY-MM-DD in Central Time */
export function todayCT(): string {
  return DateTime.now().setZone(TZ).toISODate() as string;
}

/** Hour integer (0-23) in Central Time for a stored timestamp */
export function hourCT(isoOrSql: string): number {
  const dt = DateTime.fromISO(isoOrSql, { zone: TZ }).isValid
    ? DateTime.fromISO(isoOrSql, { zone: TZ })
    : DateTime.fromSQL(isoOrSql, { zone: TZ });
  return dt.hour;
}
