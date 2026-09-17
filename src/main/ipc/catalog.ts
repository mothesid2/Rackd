import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';



type Source = 'local' | 'dojo' | 'verus' | 'mclane' | 'coremark';
const SOURCES: Source[] = ['local', 'dojo', 'verus', 'mclane', 'coremark'];

const PRIORITY: Record<string, number> = { local: 0, dojo: 1, verus: 2, mclane: 3, coremark: 4 };

interface CanonRow {
  barcode: string | null;
  product_name: string;
  brand: string | null;
  category: string | null;
  variant_label: string | null;
  suggested_retail_price: number | null;
  unit_cost: number | null;
  raw?: string;
}


const CANON_FIELDS = ['barcode', 'product_name', 'brand', 'category', 'variant_label', 'suggested_retail_price', 'unit_cost'] as const;
type CanonField = (typeof CANON_FIELDS)[number];

const HEADER_ALIASES: Record<CanonField, string[]> = {
  barcode: ['barcode', 'upc', 'upc_code', 'upca', 'gtin', 'ean', 'item_upc', 'scan_code'],
  product_name: ['product_name', 'name', 'description', 'item_description', 'product', 'item_name', 'desc'],
  brand: ['brand', 'manufacturer', 'mfg', 'vendor', 'supplier'],
  category: ['category', 'dept', 'department', 'class', 'product_category'],
  variant_label: ['variant', 'variant_label', 'flavor', 'size', 'pack', 'nicotine', 'strength'],
  suggested_retail_price: ['suggested_retail_price', 'srp', 'retail', 'retail_price', 'msrp', 'list_price', 'price'],
  unit_cost: ['unit_cost', 'cost', 'case_cost', 'wholesale', 'item_cost', 'net_cost'],
};

function norm(h: string): string {
  return String(h || '').toLowerCase().replace(/[\s\-.]+/g, '_').replace(/[^a-z0-9_]/g, '').replace(/_+/g, '_').replace(/^_|_$/g, '');
}


function autoMap(headers: string[]): Partial<Record<CanonField, string>> {
  const map: Partial<Record<CanonField, string>> = {};
  const normalized = headers.map((h) => ({ raw: h, n: norm(h) }));
  for (const field of CANON_FIELDS) {
    const aliases = HEADER_ALIASES[field];
    const hit = normalized.find((h) => aliases.includes(h.n));
    if (hit) map[field] = hit.raw;
  }
  return map;
}

function num(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string | null {
  const s = String(v ?? '').trim();
  return s === '' ? null : s;
}


function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let field = '', row: string[] = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQ = false;
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); if (row.some((f) => f !== '')) rows.push(row); }
  if (!rows.length) return [];
  const headers = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o: Record<string, string> = {};
    headers.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}


function toRawRows(data: unknown, format?: string): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[];
  const text = String(data ?? '');
  if (format === 'json' || (!format && text.trim().startsWith('['))) {
    try { const j = JSON.parse(text); return Array.isArray(j) ? j : []; } catch { return []; }
  }
  return parseCsv(text);
}

function toCanon(raw: Record<string, unknown>, mapping: Partial<Record<CanonField, string>>): CanonRow | null {
  const pick = (f: CanonField) => (mapping[f] ? raw[mapping[f] as string] : undefined);
  const product_name = str(pick('product_name'));
  if (!product_name) return null; 
  return {
    barcode: str(pick('barcode')),
    product_name,
    brand: str(pick('brand')),
    category: str(pick('category')),
    variant_label: str(pick('variant_label')),
    suggested_retail_price: num(pick('suggested_retail_price')),
    unit_cost: num(pick('unit_cost')),
    raw: JSON.stringify(raw),
  };
}

function requireManager(): { ok: true } | { ok: false; error: string } {
  const s = getCurrentSession();
  if (!s || s.role !== 'manager') return { ok: false, error: 'Manager access required' };
  return { ok: true };
}

export function registerCatalogHandlers(): void {
  
  ipcMain.handle('catalog:lookup', (_e, q: { barcode?: string; name?: string; brand?: string }) => {
    try {
      const db = getDb();
      const bc = str(q?.barcode);
      
      if (bc) {
        const rows = db.prepare('SELECT * FROM sku_catalog WHERE barcode = ?').all(bc) as Array<CanonRow & { source: string }>;
        if (rows.length) {
          rows.sort((a, b) => (PRIORITY[a.source] ?? 99) - (PRIORITY[b.source] ?? 99));
          return { success: true, confidence: 'exact', item: rows[0] };
        }
      }
      
      const name = str(q?.name);
      if (name) {
        const like = `%${name.toLowerCase()}%`;
        const rows = db.prepare(
          `SELECT * FROM sku_catalog
             WHERE lower(product_name) LIKE ? OR lower(COALESCE(brand,'')) LIKE ?
             LIMIT 10`
        ).all(like, like) as Array<CanonRow & { source: string }>;
        if (rows.length) {
          rows.sort((a, b) => (PRIORITY[a.source] ?? 99) - (PRIORITY[b.source] ?? 99));
          return { success: true, confidence: 'fuzzy', item: rows[0], candidates: rows };
        }
      }
      return { success: true, confidence: 'not_found', item: null };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('catalog:saveLocal', (_e, item: CanonRow) => {
    const g = requireManager(); if (!g.ok) return { success: false, error: g.error };
    try {
      const db = getDb();
      const name = str(item?.product_name);
      if (!name) return { success: false, error: 'Product name required' };
      db.prepare(`
        INSERT INTO sku_catalog (source, barcode, product_name, brand, category, variant_label, suggested_retail_price, unit_cost, raw)
        VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source, barcode) DO UPDATE SET
          product_name = excluded.product_name, brand = excluded.brand, category = excluded.category,
          variant_label = excluded.variant_label, suggested_retail_price = excluded.suggested_retail_price,
          unit_cost = excluded.unit_cost, updated_at = datetime('now')
      `).run(str(item.barcode), name, str(item.brand), str(item.category), str(item.variant_label),
             num(item.suggested_retail_price), num(item.unit_cost), JSON.stringify(item));
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('catalog:preview', (_e, payload: { data: unknown; format?: string }) => {
    const g = requireManager(); if (!g.ok) return { success: false, error: g.error };
    try {
      const rows = toRawRows(payload?.data, payload?.format);
      const headers = rows.length ? Object.keys(rows[0]) : [];
      return { success: true, row_count: rows.length, headers, suggested_mapping: autoMap(headers), sample: rows.slice(0, 3) };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('catalog:merge', (_e, payload: {
    source: Source; data: unknown; format?: string; mapping?: Partial<Record<CanonField, string>>;
  }) => {
    const g = requireManager(); if (!g.ok) return { success: false, error: g.error };
    try {
      const source = payload?.source;
      if (!SOURCES.includes(source)) return { success: false, error: `Unknown source '${source}'` };
      const db = getDb();
      const rawRows = toRawRows(payload?.data, payload?.format);
      if (!rawRows.length) return { success: false, error: 'No rows found in the file' };
      const mapping = payload?.mapping && Object.keys(payload.mapping).length
        ? payload.mapping
        : autoMap(Object.keys(rawRows[0]));

      let added = 0, updated = 0, skipped = 0;
      const conflict_list: Array<{ barcode: string; incoming: string; existing: string; existing_source: string }> = [];

      const existingBySrc = db.prepare('SELECT * FROM sku_catalog WHERE source = ? AND barcode = ?');
      const existingAny = db.prepare('SELECT product_name, source FROM sku_catalog WHERE barcode = ? AND source != ? ORDER BY 1 LIMIT 1');
      const insert = db.prepare(`
        INSERT INTO sku_catalog (source, barcode, product_name, brand, category, variant_label, suggested_retail_price, unit_cost, raw)
        VALUES (@source, @barcode, @product_name, @brand, @category, @variant_label, @suggested_retail_price, @unit_cost, @raw)`);
      const update = db.prepare(`
        UPDATE sku_catalog SET product_name=@product_name, brand=@brand, category=@category,
          variant_label=@variant_label, suggested_retail_price=@suggested_retail_price,
          unit_cost=@unit_cost, raw=@raw, updated_at=datetime('now')
         WHERE source=@source AND barcode=@barcode`);

      const run = db.transaction(() => {
        for (const raw of rawRows) {
          const c = toCanon(raw, mapping);
          if (!c) { skipped++; continue; }

          
          if (c.barcode) {
            const other = existingAny.get(c.barcode, source) as { product_name: string; source: string } | undefined;
            if (other && other.product_name.trim().toLowerCase() !== c.product_name.trim().toLowerCase()) {
              conflict_list.push({ barcode: c.barcode, incoming: c.product_name, existing: other.product_name, existing_source: other.source });
            }
          }

          if (c.barcode) {
            const prev = existingBySrc.get(source, c.barcode) as (CanonRow & { id: number }) | undefined;
            if (prev) {
              const changed = prev.unit_cost !== c.unit_cost || prev.suggested_retail_price !== c.suggested_retail_price ||
                prev.product_name !== c.product_name || prev.brand !== c.brand;
              if (changed) { update.run({ source, ...c }); updated++; } else skipped++;
              continue;
            }
            insert.run({ source, ...c }); added++;
          } else {
            
            insert.run({ source, ...c }); added++;
          }
        }
      });
      run();

      return { success: true, source, added_count: added, updated_count: updated, skipped_count: skipped, conflict_list };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('catalog:stats', () => {
    try {
      const db = getDb();
      const rows = db.prepare('SELECT source, COUNT(*) AS n FROM sku_catalog GROUP BY source').all() as Array<{ source: string; n: number }>;
      const by: Record<string, number> = {};
      for (const r of rows) by[r.source] = r.n;
      const total = rows.reduce((s, r) => s + r.n, 0);
      return { success: true, total, by_source: by, sources: SOURCES };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('catalog:clearSource', (_e, source: Source) => {
    const g = requireManager(); if (!g.ok) return { success: false, error: g.error };
    try {
      if (!SOURCES.includes(source)) return { success: false, error: 'Unknown source' };
      const info = getDb().prepare('DELETE FROM sku_catalog WHERE source = ?').run(source);
      return { success: true, deleted: info.changes };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
