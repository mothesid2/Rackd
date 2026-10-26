// Small pure helpers (unit tested).

/** Minimal RFC-4180 CSV parser: quotes, escaped quotes, commas and newlines inside quotes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQ = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQ) {
      if (c === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim() !== '')) rows.push(row);
  return rows;
}

export const CSV_COLUMNS = ['name', 'brand', 'flavor', 'size', 'price', 'qty'] as const;

/** Header row is matched case-insensitively and in any order; unknown columns are ignored. Returns objects for sf_import_items. */
export function csvToItemRows(text: string): { rows: Record<string, string>[]; problems: string[] } {
  const table = parseCsv(text);
  if (table.length === 0) return { rows: [], problems: ['The file is empty.'] };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const idx = Object.fromEntries(CSV_COLUMNS.map((c) => [c, header.indexOf(c)])) as Record<(typeof CSV_COLUMNS)[number], number>;
  const problems: string[] = [];
  if (idx.name < 0) problems.push('Missing a "name" column.');
  if (idx.price < 0) problems.push('Missing a "price" column.');
  if (problems.length) return { rows: [], problems };
  const rows = table.slice(1).map((r) => Object.fromEntries(CSV_COLUMNS.map((c) => [c, idx[c] >= 0 ? (r[idx[c]] ?? '').trim().replace(/^\$/, '') : ''])));
  if (rows.length > 500) problems.push('At most 500 rows can be imported at once.');
  return { rows: rows.slice(0, 500), problems };
}

export const CSV_TEMPLATE = 'name,brand,flavor,size,price,qty\nMango Ice 60ml,Acme,Mango,60ml,19.99,12\n';

/** Neutralise spreadsheet formulas when exporting user-controlled text to CSV. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export const toCsv = (rows: unknown[][]): string => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** Largest size that fits max x max while keeping the aspect ratio (never upscales). */
export function fitWithin(w: number, h: number, max: number): { w: number; h: number } {
  if (w <= max && h <= max) return { w, h };
  const s = max / Math.max(w, h);
  return { w: Math.max(1, Math.round(w * s)), h: Math.max(1, Math.round(h * s)) };
}

/** Client-side photo compression: downscale to 900px and re-encode as JPEG so uploads stay small on phones. */
export async function compressImage(file: File, max = 900, quality = 0.82): Promise<Blob> {
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error('unsupported_image');
  const bmp = await createImageBitmap(file);
  const { w, h } = fitWithin(bmp.width, bmp.height, max);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas_unavailable');
  ctx.fillStyle = '#fff';                       // flatten transparency (PNG) instead of rendering black
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode_failed'))), 'image/jpeg', quality));
}

export const money = (n: number) => n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/** "42 min left", "5 min over", "1 h 5 min left". */
export function holdLabel(expiresAt: string, now = Date.now()): { text: string; overdue: boolean; urgent: boolean } {
  const mins = Math.round((Date.parse(expiresAt) - now) / 60000);
  const abs = Math.abs(mins);
  const body = abs >= 60 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${abs} min`;
  return mins < 0 ? { text: `${body} over`, overdue: true, urgent: true } : { text: `${body} left`, overdue: false, urgent: mins <= 10 };
}

/** "Cora C." style names only: the board never shows more of a customer than first name and last initial. */
export const shortName = (n: string | null | undefined) => (n && n.trim() ? n.trim() : 'Customer');

/** A permission-gated action is shown disabled (with the reason) rather than hidden when it matters to understand why. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list;
  const copy = list.slice();
  const [x] = copy.splice(from, 1);
  copy.splice(to, 0, x);
  return copy;
}
