import { DateTime } from 'luxon';
import { getDb } from '../db/schema';
import { dayInfo } from '../daySession';

const DEFAULT_TZ = 'America/Chicago';


export function getBusinessTZ(): string {
  try {
    const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'business_timezone'`).get() as { value: string } | undefined;
    return row?.value?.trim() || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ; 
  }
}


export const TZ = DEFAULT_TZ;


export function nowCT(): string {
  return DateTime.now().setZone(getBusinessTZ()).toISO() as string;
}


export function fmtCT(isoOrSql: string | null | undefined): string {
  if (!isoOrSql) return '—';
  const zone = getBusinessTZ();
  const dt = DateTime.fromISO(isoOrSql, { zone })
    .isValid
    ? DateTime.fromISO(isoOrSql, { zone })
    : DateTime.fromSQL(isoOrSql, { zone });
  return dt.isValid ? dt.toFormat('MMM d, yyyy h:mm a') : isoOrSql;
}


export function fmtDateCT(isoOrSql: string | null | undefined): string {
  if (!isoOrSql) return '—';
  const zone = getBusinessTZ();
  const dt = DateTime.fromISO(isoOrSql, { zone }).isValid
    ? DateTime.fromISO(isoOrSql, { zone })
    : DateTime.fromSQL(isoOrSql, { zone });
  return dt.isValid ? dt.toFormat('MMM d, yyyy') : isoOrSql;
}


export function fmtTimeCT(isoOrSql: string | null | undefined): string {
  if (!isoOrSql) return '—';
  const zone = getBusinessTZ();
  const dt = DateTime.fromISO(isoOrSql, { zone }).isValid
    ? DateTime.fromISO(isoOrSql, { zone })
    : DateTime.fromSQL(isoOrSql, { zone });
  return dt.isValid ? dt.toFormat('h:mm a') : isoOrSql;
}


export function todayCT(): string {
  return DateTime.now().setZone(getBusinessTZ()).toISODate() as string;
}


export function hourCT(isoOrSql: string): number {
  const zone = getBusinessTZ();
  const dt = DateTime.fromISO(isoOrSql, { zone }).isValid
    ? DateTime.fromISO(isoOrSql, { zone })
    : DateTime.fromSQL(isoOrSql, { zone });
  return dt.hour;
}


export interface BusinessDayWindow { start: string; end: string | null }

export function currentBusinessDayWindow(db: ReturnType<typeof getDb> = getDb(), now: DateTime = DateTime.now()): BusinessDayWindow {
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  
  const formulaStart = scheduledBusinessDayStart(db, now);
  const info = dayInfo(db);
  if (info.open && info.openedAt) {
    if (info.openedAt <= formulaStart) return { start: info.openedAt, end: null };
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    
    const interveningZ = db.prepare(
      `SELECT 1 FROM z_reports WHERE shift_opened_at >= ? AND generated_at < ? LIMIT 1`
    ).get(formulaStart, info.openedAt);
    return { start: interveningZ ? info.openedAt : formulaStart, end: null };
  }
  
  
  
  
  
  
  
  const last = db.prepare(`SELECT generated_at FROM z_reports ORDER BY id DESC LIMIT 1`).get() as { generated_at: string } | undefined;
  return { start: last?.generated_at || (now.setZone(getBusinessTZ()).startOf('day').toISO() as string), end: null };
}


export function businessDayStart(db: ReturnType<typeof getDb> = getDb()): string {
  return currentBusinessDayWindow(db).start;
}


export function scheduledBusinessDayStart(db: ReturnType<typeof getDb> = getDb(), now: DateTime = DateTime.now()): string {
  const zone = getBusinessTZ();
  const nowZ = now.setZone(zone);
  const raw = (db.prepare(`SELECT value FROM settings WHERE key = 'batch_time'`).get() as { value: string } | undefined)?.value?.trim();
  if (!raw || !/^\d{2}:\d{2}$/.test(raw)) return nowZ.startOf('day').toISO() as string;
  const [h, m] = raw.split(':').map(Number);
  let boundary = nowZ.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (boundary > nowZ) boundary = boundary.minus({ days: 1 });
  return boundary.toISO() as string;
}


export function currentBusinessDate(db: ReturnType<typeof getDb> = getDb(), now: DateTime = DateTime.now()): string {
  return DateTime.fromISO(scheduledBusinessDayStart(db, now)).toISODate() as string;
}


export function businessDayBounds(dateLabel: string, db: ReturnType<typeof getDb> = getDb()): { start: string; end: string } {
  const zone = getBusinessTZ();
  const base = DateTime.fromISO(dateLabel, { zone }).startOf('day');
  const raw = (db.prepare(`SELECT value FROM settings WHERE key = 'batch_time'`).get() as { value: string } | undefined)?.value?.trim();
  if (!raw || !/^\d{2}:\d{2}$/.test(raw)) {
    return { start: base.toISO() as string, end: base.plus({ days: 1 }).toISO() as string };
  }
  const [h, m] = raw.split(':').map(Number);
  const start = base.set({ hour: h, minute: m, second: 0, millisecond: 0 });
  return { start: start.toISO() as string, end: start.plus({ days: 1 }).toISO() as string };
}
