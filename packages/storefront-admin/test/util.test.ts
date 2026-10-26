import { describe, expect, it } from 'vitest';
import { ApiError, messageFor, toApiError } from '../src/api';
import { CuratedInventorySource, isRestrictedCategory, PosInventorySource, sourceFor } from '../src/inventory';
import { csvCell, csvToItemRows, fitWithin, holdLabel, moveItem, parseCsv, toCsv } from '../src/util';
import type { StorefrontItem } from '../src/types';

const item = (over: Partial<StorefrontItem> = {}): StorefrontItem => ({
  id: 'i1', source: 'curated', pos_product_id: null, name: 'A', brand: null, flavor: null, size: null, price: 1, image_url: null, category: null,
  status: 'available', qty: null, available: null, sort_order: 1, read_only: false, pos_missing: false, updated_at: '', ...over,
});

describe('CSV', () => {
  it('parses quotes, escaped quotes, embedded commas/newlines, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n"line1\nline2",z\r\n')).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['line1\nline2', 'z']]);
  });
  it('skips blank lines', () => {
    expect(parseCsv('a,b\n\n,\nc,d\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });
  it('maps columns by header in any order, ignores extras, strips a leading $', () => {
    const r = csvToItemRows('Price,Name,Extra,QTY,Brand\n$12.50,Mango,zzz,4,Acme\n9,Mint,,,');
    expect(r.problems).toEqual([]);
    expect(r.rows[0]).toMatchObject({ name: 'Mango', price: '12.50', qty: '4', brand: 'Acme', flavor: '' });
    expect(r.rows[1]).toMatchObject({ name: 'Mint', price: '9', qty: '' });
  });
  it('reports missing required columns and empty files', () => {
    expect(csvToItemRows('').problems).toEqual(['The file is empty.']);
    expect(csvToItemRows('name\nA').problems).toEqual(['Missing a "price" column.']);
    expect(csvToItemRows('price\n1').problems).toEqual(['Missing a "name" column.']);
  });
  it('caps imports at 500 rows', () => {
    const big = 'name,price\n' + Array.from({ length: 600 }, (_, i) => `x${i},1`).join('\n');
    const r = csvToItemRows(big);
    expect(r.rows).toHaveLength(500);
    expect(r.problems[0]).toContain('500');
  });
  it('exports safely: quotes cells and defuses spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "x"')).toBe('"say ""x"""');
    expect(csvCell('=HYPERLINK("http://evil")')).toBe('"\'=HYPERLINK(""http://evil"")"');
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell(null)).toBe('');
    expect(toCsv([['a', 1], ['b', 2]])).toBe('a,1\r\nb,2\r\n');
  });
});

describe('helpers', () => {
  it('fitWithin never upscales and keeps the aspect ratio', () => {
    expect(fitWithin(400, 300, 900)).toEqual({ w: 400, h: 300 });
    expect(fitWithin(1800, 900, 900)).toEqual({ w: 900, h: 450 });
    expect(fitWithin(900, 3600, 900)).toEqual({ w: 225, h: 900 });
  });
  it('hold labels count down and flag overdue/urgent', () => {
    const now = Date.parse('2026-10-26T12:00:00Z');
    expect(holdLabel('2026-10-26T12:42:00Z', now)).toEqual({ text: '42 min left', overdue: false, urgent: false });
    expect(holdLabel('2026-10-26T13:05:00Z', now).text).toBe('1 h 5 min left');
    expect(holdLabel('2026-10-26T12:08:00Z', now).urgent).toBe(true);
    expect(holdLabel('2026-10-26T11:55:00Z', now)).toEqual({ text: '5 min over', overdue: true, urgent: true });
  });
  it('moveItem reorders and ignores out-of-range moves', () => {
    expect(moveItem([1, 2, 3], 0, 2)).toEqual([2, 3, 1]);
    expect(moveItem([1, 2, 3], 2, 0)).toEqual([3, 1, 2]);
    const same = [1, 2, 3];
    expect(moveItem(same, 1, 1)).toBe(same);
    expect(moveItem(same, 0, 9)).toBe(same);
  });
});

describe('inventory sources', () => {
  it('POS sync: price, quantity and name are read-only; visibility is editable; no free-form creation or CSV', () => {
    const s = PosInventorySource;
    for (const f of ['price', 'qty', 'name', 'brand', 'flavor', 'size'] as const) expect(s.canEdit(item({ source: 'pos' }), f)).toBe(false);
    for (const f of ['status', 'sort_order', 'image_url'] as const) expect(s.canEdit(item({ source: 'pos' }), f)).toBe(true);
    expect([s.canCreate, s.canImportCsv, s.canPickFromPos, s.canDuplicate(item())]).toEqual([false, false, true, false]);
    expect(s.quantityNote(item({ pos_missing: true }))).toBe('No longer in your POS');
  });
  it('curated: everything editable, CSV allowed, quantity optional', () => {
    const s = CuratedInventorySource;
    for (const f of ['price', 'qty', 'name', 'status'] as const) expect(s.canEdit(item(), f)).toBe(true);
    expect([s.canCreate, s.canImportCsv, s.canPickFromPos]).toEqual([true, true, false]);
    expect(s.quantityNote(item({ qty: null }))).toBe('Unlimited');
    expect(s.quantityNote(item({ qty: 3 }))).toBe('3 on hand');
  });
  it('curated validation', () => {
    const v = CuratedInventorySource.validate;
    expect(v({ name: 'A', price: 1 })).toBeNull();
    expect(v({ name: ' ', price: 1 })).toContain('name');
    expect(v({ name: 'A', price: -1 })).toContain('price');
    expect(v({ name: 'A', price: 100000 })).toContain('price');
    expect(v({ name: 'A', price: 1, qty: 1.5 })).toContain('whole number');
    expect(v({ name: 'A', price: 1, qty: null })).toBeNull();
  });
  it('mode selects the source; restricted categories are recognised', () => {
    expect(sourceFor('pos_sync')).toBe(PosInventorySource);
    expect(sourceFor('curated')).toBe(CuratedInventorySource);
    expect(sourceFor(undefined)).toBe(CuratedInventorySource);
    for (const c of ['Vape', 'e-liquid', 'Tobacco', 'Disposables', 'Nicotine pouches']) expect(isRestrictedCategory(c)).toBe(true);
    for (const c of ['Glass', 'Accessories', null, '']) expect(isRestrictedCategory(c)).toBe(false);
  });
});

describe('error mapping', () => {
  it('turns database slugs into codes and friendly messages', () => {
    expect(toApiError({ message: 'id_check_required' }).code).toBe('id_check_required');
    expect(toApiError({ message: 'invalid_transition: new -> ready' }).code).toBe('invalid_transition');
    expect(toApiError({ message: 'new row violates row-level security policy' }).code).toBe('forbidden');
    expect(toApiError({ code: '42501', message: 'x' }).code).toBe('forbidden');
    expect(messageFor(new ApiError('id_check_required'))).toContain('ID');
    expect(messageFor(new ApiError('something_new'))).toBe('Something went wrong. Please try again.');
    expect(messageFor(new Error('boom'))).toBe('Something went wrong. Please try again.');
  });
});
