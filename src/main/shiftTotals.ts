import type Database from 'better-sqlite3';
import { getDb } from './db/schema';
import { nowCT, businessDayStart } from './utils/time';




export function currentCashFloat(db: Database.Database = getDb()): number {
  const raw = (db.prepare("SELECT value FROM settings WHERE key = 'cash_float'").get() as { value: string } | undefined)?.value;
  return parseFloat(raw || '200') || 200;
}

interface ShiftRow {
  id: number;
  opened_at: string;
  [key: string]: unknown;
}

function findOpenRow(cashierId: number, db: Database.Database): ShiftRow | undefined {
  return db.prepare(
    `SELECT * FROM shift_totals WHERE cashier_id = ? AND closed_at IS NULL ORDER BY opened_at DESC LIMIT 1`
  ).get(cashierId) as ShiftRow | undefined;
}


export function findCurrentOpenShift<T extends ShiftRow = ShiftRow>(cashierId: number, db: Database.Database = getDb()): T | undefined {
  const row = findOpenRow(cashierId, db);
  if (!row) return undefined;
  const dayStart = businessDayStart(db);
  if (row.opened_at < dayStart) return undefined; 
  return row as T;
}


export function getOrOpenCurrentShift(cashierId: number, db: Database.Database = getDb(), startingCash?: number): number {
  const row = findOpenRow(cashierId, db);
  if (row) {
    const dayStart = businessDayStart(db);
    if (row.opened_at >= dayStart) return row.id;
    db.prepare(`UPDATE shift_totals SET closed_at = ? WHERE id = ?`).run(nowCT(), row.id);
  }
  const result = startingCash != null
    ? db.prepare(`INSERT INTO shift_totals (cashier_id, opened_at, starting_cash) VALUES (?, ?, ?)`).run(cashierId, nowCT(), startingCash)
    : db.prepare(`INSERT INTO shift_totals (cashier_id, opened_at) VALUES (?, ?)`).run(cashierId, nowCT());
  return Number(result.lastInsertRowid);
}
