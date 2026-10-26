import { useMemo, useRef, useState } from 'react';
import { messageFor, type StorefrontApi } from './api';
import { sourceFor } from './inventory';
import type { ItemInput, ItemStatus, Permissions, PosProduct, Settings, StorefrontItem } from './types';
import { btnGhost, btnPrimary, Field, input, ListSkeleton, Modal, Notice, StatusChips, Tooltip, useResource, useToast } from './ui';
import { compressImage, CSV_TEMPLATE, csvToItemRows, money, moveItem } from './util';

interface Props { api: StorefrontApi; location: string; perms: Permissions; settings: Settings | null; reloadSettings: () => void }

const EMPTY: ItemInput = { name: '', brand: '', flavor: '', size: '', price: 0, qty: null, category: '', image_url: '' };

export function Items({ api, location, perms, settings }: Props) {
  const toast = useToast();
  const src = sourceFor(settings?.inventory_mode);
  const res = useResource(() => api.items(location), [location, settings?.inventory_mode]);
  const [q, setQ] = useState('');
  const [statusF, setStatusF] = useState<'all' | ItemStatus>('all');
  const [catF, setCatF] = useState('');
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [edit, setEdit] = useState<StorefrontItem | 'new' | null>(null);
  const [picker, setPicker] = useState(false);
  const [importing, setImporting] = useState(false);
  const dragId = useRef<string | null>(null);

  const items = res.data ?? [];
  const cats = useMemo(() => [...new Set(items.map((i) => i.category).filter(Boolean) as string[])].sort(), [items]);
  const shown = items.filter((i) =>
    (statusF === 'all' || i.status === statusF) && (!catF || i.category === catF) &&
    (!q.trim() || `${i.name ?? ''} ${i.brand ?? ''} ${i.flavor ?? ''}`.toLowerCase().includes(q.trim().toLowerCase())));
  const canEdit = perms.items_edit;
  const reason = canEdit ? undefined : 'You do not have permission to edit items.';

  /** Optimistic: update the screen first, roll back (with a toast) if the server says no. */
  async function optimistic(apply: (l: StorefrontItem[]) => StorefrontItem[], call: () => Promise<unknown>) {
    const before = res.data;
    res.setData((p) => (p ? apply(p) : p));
    try { await call(); }
    catch (e) { res.setData(before); toast(messageFor(e), 'error'); }
  }
  const setStatus = (id: string, status: ItemStatus) =>
    optimistic((l) => l.map((i) => (i.id === id ? { ...i, status } : i)), () => api.setStatus([id], status));
  const bulk = async (status: ItemStatus) => {
    const ids = [...sel];
    await optimistic((l) => l.map((i) => (sel.has(i.id) ? { ...i, status } : i)), () => api.setStatus(ids, status));
    setSel(new Set());
  };
  const reorder = (from: number, to: number) => {
    const ids = shown.map((i) => i.id);
    const moved = moveItem(ids, from, to);
    if (moved === ids) return;
    const rank = new Map(moved.map((id, n) => [id, n]));
    void optimistic((l) => [...l].sort((a, b) => (rank.get(a.id) ?? 1e9) - (rank.get(b.id) ?? 1e9)), () => api.reorder(location, moved));
  };
  const remove = (i: StorefrontItem) => {
    if (!confirm(`Delete "${i.name}"? This cannot be undone.`)) return;
    void optimistic((l) => l.filter((x) => x.id !== i.id), () => api.deleteItem(i.id));
  };
  const dup = async (i: StorefrontItem) => { try { await api.duplicate(i.id); toast('Copied. The copy is hidden until you make it available.'); void res.reload(); } catch (e) { toast(messageFor(e), 'error'); } };

  if (res.loading && !res.data) return <ListSkeleton />;
  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs rounded-full border border-line px-2.5 py-1 text-smoke">{src.label}</span>
        <span className="flex-1" />
        {src.canPickFromPos && <button className={btnPrimary} disabled={!canEdit} onClick={() => setPicker(true)}>Add from my POS</button>}
        {src.canCreate && <button className={btnPrimary} disabled={!canEdit} onClick={() => setEdit('new')}>+ Add item</button>}
        {src.canImportCsv && <button className={btnGhost} disabled={!canEdit} onClick={() => setImporting(true)}>Import CSV</button>}
      </div>
      {!canEdit && <Notice>You can view items but not change them.</Notice>}
      {res.error && <Notice tone="error">{res.error}</Notice>}
      {settings?.inventory_mode === 'pos_sync' && <Notice>Price, name and quantity come from your POS and update by themselves. You choose what customers see.</Notice>}

      <div className="grid sm:grid-cols-[1fr_auto_auto] gap-2">
        <label className="sr-only" htmlFor="sf-q">Search items</label>
        <input id="sf-q" type="search" placeholder="Search name, brand, flavor" value={q} onChange={(e) => setQ(e.target.value)} className={input} />
        <label className="sr-only" htmlFor="sf-st">Filter by status</label>
        <select id="sf-st" value={statusF} onChange={(e) => setStatusF(e.target.value as typeof statusF)} className={input}>
          <option value="all">All statuses</option><option value="available">Available</option><option value="sold_out">Sold out</option><option value="hidden">Hidden</option>
        </select>
        <label className="sr-only" htmlFor="sf-cat">Filter by category</label>
        <select id="sf-cat" value={catF} onChange={(e) => setCatF(e.target.value)} className={input}>
          <option value="">All categories</option>{cats.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>

      {sel.size > 0 && (
        <div role="region" aria-label="Bulk actions" className="sticky top-0 z-10 flex flex-wrap items-center gap-2 rounded-xl border border-ember/60 bg-char p-3">
          <strong className="text-sm">{sel.size} selected</strong>
          <button className={btnGhost} disabled={!canEdit} onClick={() => bulk('available')}>Make available</button>
          <button className={btnGhost} disabled={!canEdit} onClick={() => bulk('sold_out')}>Mark sold out</button>
          <button className={btnGhost} disabled={!canEdit} onClick={() => bulk('hidden')}>Hide</button>
          <button className="text-sm underline text-smoke min-h-[44px] px-2" onClick={() => setSel(new Set())}>Clear</button>
        </div>
      )}

      {shown.length === 0 ? (
        <div className="rounded-2xl border border-line p-8 text-center text-smoke">
          {items.length === 0 ? (src.canCreate ? 'No items yet. Add your first item to start taking reservations.' : 'No items yet. Use “Add from my POS” to choose what customers can reserve.') : 'No items match these filters.'}
        </div>
      ) : (
        <ul className="grid gap-2" aria-label="Items">
          <li className="flex items-center gap-2 px-1 text-xs text-smoke">
            <label className="inline-flex items-center gap-2 min-h-[44px]"><input type="checkbox" className="w-5 h-5 accent-[#e0293d]" aria-label="Select all shown"
              checked={shown.length > 0 && shown.every((i) => sel.has(i.id))} onChange={(e) => setSel(e.target.checked ? new Set(shown.map((i) => i.id)) : new Set())} />Select all</label>
          </li>
          {shown.map((i, idx) => (
            <li key={i.id} draggable={canEdit && !q && statusF === 'all' && !catF}
              onDragStart={() => { dragId.current = i.id; }} onDragOver={(e) => e.preventDefault()}
              onDrop={() => { const from = shown.findIndex((x) => x.id === dragId.current); if (from >= 0) reorder(from, idx); dragId.current = null; }}
              className={`rounded-2xl border border-line bg-paper p-3 grid gap-2 sm:grid-cols-[auto_3.5rem_1fr_auto] sm:items-center ${i.status === 'hidden' ? 'opacity-70' : ''}`}>
              <input type="checkbox" className="w-5 h-5 accent-[#e0293d]" aria-label={`Select ${i.name}`} checked={sel.has(i.id)}
                onChange={(e) => setSel((s) => { const n = new Set(s); if (e.target.checked) n.add(i.id); else n.delete(i.id); return n; })} />
              {i.image_url ? <img src={i.image_url} alt="" className="w-14 h-14 rounded-lg object-cover" loading="lazy" /> : <div className="w-14 h-14 rounded-lg bg-steel" aria-hidden="true" />}
              <div className="min-w-0">
                <div className="font-semibold truncate">{i.name ?? 'Unnamed'}{i.pos_missing && <span className="ml-2 text-xs text-amber-300">not in POS</span>}</div>
                <div className="text-xs text-smoke truncate">{[i.brand, i.flavor, i.size, i.category].filter(Boolean).join(' · ') || '—'}</div>
                <div className="text-sm mt-0.5">{i.price != null ? money(i.price) : '—'} <span className="text-smoke text-xs">· {src.quantityNote(i)}{i.available != null && i.qty != null && i.available !== i.qty ? ` · ${i.available} free` : ''}</span></div>
              </div>
              <div className="flex flex-wrap items-center gap-1 sm:justify-end">
                <StatusChips value={i.status} onChange={(s) => setStatus(i.id, s)} disabled={!canEdit} disabledReason={reason} />
                <div className="flex gap-1">
                  <button className="min-h-[44px] min-w-[44px] text-smoke hover:text-ink disabled:opacity-40" aria-label={`Move ${i.name} up`} disabled={!canEdit || idx === 0 || !!q || statusF !== 'all' || !!catF} onClick={() => reorder(idx, idx - 1)}>↑</button>
                  <button className="min-h-[44px] min-w-[44px] text-smoke hover:text-ink disabled:opacity-40" aria-label={`Move ${i.name} down`} disabled={!canEdit || idx === shown.length - 1 || !!q || statusF !== 'all' || !!catF} onClick={() => reorder(idx, idx + 1)}>↓</button>
                  <button className="min-h-[44px] px-2 text-sm underline text-smoke hover:text-ink disabled:opacity-40" disabled={!canEdit} onClick={() => setEdit(i)}>Edit</button>
                  {src.canDuplicate(i) && <button className="min-h-[44px] px-2 text-sm underline text-smoke hover:text-ink disabled:opacity-40" disabled={!canEdit} onClick={() => dup(i)}>Copy</button>}
                  <button className="min-h-[44px] px-2 text-sm underline text-smoke hover:text-ink disabled:opacity-40" disabled={!canEdit} onClick={() => remove(i)}>{i.source === 'pos' ? 'Remove' : 'Delete'}</button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {edit && <ItemForm key={edit === 'new' ? 'new' : edit.id} api={api} location={location} item={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void res.reload(); }} />}
      {picker && <PosPicker api={api} location={location} onClose={() => setPicker(false)} onAdded={() => void res.reload()} />}
      {importing && <CsvImport api={api} location={location} onClose={() => setImporting(false)} onDone={() => void res.reload()} />}
    </div>
  );
}

function ItemForm({ api, location, item, onClose, onSaved }: { api: StorefrontApi; location: string; item: StorefrontItem | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const readOnlyPos = item?.source === 'pos';
  const src = sourceFor(item?.source === 'pos' ? 'pos_sync' : 'curated');
  const [f, setF] = useState<ItemInput>(item ? { name: item.name ?? '', brand: item.brand ?? '', flavor: item.flavor ?? '', size: item.size ?? '', price: item.price ?? 0, qty: item.qty, category: item.category ?? '', image_url: item.image_url ?? '' } : EMPTY);
  const [priceText, setPriceText] = useState(item?.price != null ? String(item.price) : '');
  const [qtyText, setQtyText] = useState(item?.qty != null ? String(item.qty) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = (p: Partial<ItemInput>) => setF((x) => ({ ...x, ...p }));

  async function photo(file: File | undefined) {
    if (!file) return;
    try { setBusy(true); const blob = await compressImage(file); set({ image_url: await api.uploadImage(location, blob) }); }
    catch (e) { setErr(e instanceof Error && e.message === 'unsupported_image' ? 'Use a JPG, PNG or WebP photo.' : messageFor(e)); }
    finally { setBusy(false); }
  }
  async function save() {
    const price = Number(priceText); const qty = qtyText.trim() === '' ? null : Number(qtyText);
    const input: ItemInput = { ...f, price, qty };
    if (!readOnlyPos) { const v = src.validate(input); if (v) return setErr(v); }
    setBusy(true); setErr(null);
    try {
      if (!item) await api.createItem(location, input);
      else if (readOnlyPos) await api.updateItem(item.id, { category: f.category || null, image_url: f.image_url || null } as never);
      else await api.updateItem(item.id, { name: input.name.trim(), brand: input.brand || null, flavor: input.flavor || null, size: input.size || null, price, qty, category: input.category || null, image_url: input.image_url || null });
      toast('Saved.'); onSaved();
    } catch (e) { setErr(messageFor(e)); } finally { setBusy(false); }
  }
  return (
    <Modal open title={item ? 'Edit item' : 'Add item'} onClose={onClose} wide>
      {readOnlyPos && <Notice>Name, price and quantity come from your POS. You can change the photo and category.</Notice>}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="sm:col-span-2"><Field label="Name">{(id) => <input id={id} className={input} value={f.name} disabled={readOnlyPos} onChange={(e) => set({ name: e.target.value })} maxLength={120} />}</Field></div>
        <Field label="Brand">{(id) => <input id={id} className={input} value={f.brand ?? ''} disabled={readOnlyPos} onChange={(e) => set({ brand: e.target.value })} />}</Field>
        <Field label="Flavor">{(id) => <input id={id} className={input} value={f.flavor ?? ''} disabled={readOnlyPos} onChange={(e) => set({ flavor: e.target.value })} />}</Field>
        <Field label="Size">{(id) => <input id={id} className={input} value={f.size ?? ''} disabled={readOnlyPos} onChange={(e) => set({ size: e.target.value })} />}</Field>
        <Field label="Category" hint="Vape and tobacco categories always require an ID check at pickup.">{(id) => <input id={id} className={input} value={f.category ?? ''} onChange={(e) => set({ category: e.target.value })} />}</Field>
        <Field label="Price ($)">{(id) => <input id={id} className={input} inputMode="decimal" value={priceText} disabled={readOnlyPos} onChange={(e) => setPriceText(e.target.value)} />}</Field>
        <Field label="Quantity on hand" hint="Leave blank for unlimited.">{(id) => <input id={id} className={input} inputMode="numeric" value={readOnlyPos ? String(item?.qty ?? '') : qtyText} disabled={readOnlyPos} onChange={(e) => setQtyText(e.target.value)} />}</Field>
        <div className="sm:col-span-2">
          <Field label="Photo" hint="Photos are shrunk on your device before upload.">{(id) => <input id={id} type="file" accept="image/jpeg,image/png,image/webp" onChange={(e) => void photo(e.target.files?.[0])} className="text-sm" />}</Field>
          {f.image_url && <img src={f.image_url} alt="" className="mt-2 w-20 h-20 rounded-lg object-cover" />}
        </div>
      </div>
      {err && <Notice tone="error">{err}</Notice>}
      <div className="flex justify-end gap-2"><button className={btnGhost} onClick={onClose}>Cancel</button><button className={btnPrimary} onClick={save} disabled={busy}>{busy ? 'Saving…' : 'Save'}</button></div>
    </Modal>
  );
}

function PosPicker({ api, location, onClose, onAdded }: { api: StorefrontApi; location: string; onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState('');
  const res = useResource<PosProduct[]>(() => api.posProducts(location, q), [location, q]);
  const [added, setAdded] = useState<Set<string>>(new Set());
  async function add(p: PosProduct) {
    try { await api.addPosItem(location, p.barcode); setAdded((s) => new Set(s).add(p.barcode)); onAdded(); toast(`Added ${p.name}`); }
    catch (e) { toast(messageFor(e), 'error'); }
  }
  return (
    <Modal open title="Add from my POS" onClose={onClose} wide>
      <label className="sr-only" htmlFor="sf-pos-q">Search your POS inventory</label>
      <input id="sf-pos-q" className={input} type="search" placeholder="Search by name or scan a barcode" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      {res.loading && !res.data ? <ListSkeleton rows={3} /> : (
        <ul className="grid gap-2 max-h-[50vh] overflow-y-auto" aria-label="POS products">
          {(res.data ?? []).map((p) => {
            const done = p.already_added || added.has(p.barcode);
            return (
              <li key={p.barcode} className="flex items-center justify-between gap-3 rounded-xl border border-line p-3">
                <div className="min-w-0"><div className="font-semibold truncate">{p.name}</div><div className="text-xs text-smoke">{money(p.price)} · {p.quantity} in stock · {p.category ?? 'no category'}</div></div>
                <button className={btnGhost} disabled={done} onClick={() => add(p)}>{done ? 'Added' : 'Add'}</button>
              </li>
            );
          })}
          {(res.data ?? []).length === 0 && <li className="text-smoke text-sm p-3">No products found.</li>}
        </ul>
      )}
      <div className="flex justify-end"><button className={btnPrimary} onClick={onClose}>Done</button></div>
    </Modal>
  );
}

function CsvImport({ api, location, onClose, onDone }: { api: StorefrontApi; location: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [result, setResult] = useState<{ inserted: number; errors: { row: number; message: string }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  async function pick(file: File | undefined) {
    if (!file) return;
    if (file.size > 1024 * 1024) return setProblems(['That file is over 1 MB.']);
    const r = csvToItemRows(await file.text());
    setRows(r.rows); setProblems(r.problems); setResult(null);
  }
  async function run() {
    setBusy(true);
    try { const r = await api.importItems(location, rows); setResult(r); toast(`Imported ${r.inserted} item${r.inserted === 1 ? '' : 's'}.`); onDone(); }
    catch (e) { setProblems([messageFor(e)]); } finally { setBusy(false); }
  }
  const template = `data:text/csv;charset=utf-8,${encodeURIComponent(CSV_TEMPLATE)}`;
  return (
    <Modal open title="Import items from CSV" onClose={onClose} wide>
      <p className="text-sm text-smoke">Columns: name, brand, flavor, size, price, qty (name and price are required; leave qty blank for unlimited). <a className="underline" href={template} download="storefront-items-template.csv">Download a template</a>.</p>
      <Field label="CSV file">{(id) => <input id={id} type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} className="text-sm" />}</Field>
      {problems.map((p) => <Notice key={p} tone="error">{p}</Notice>)}
      {rows.length > 0 && !result && <Notice>{rows.length} row{rows.length === 1 ? '' : 's'} ready. Rows with problems are skipped and listed afterwards.</Notice>}
      {result && (
        <div className="grid gap-2"><Notice>{result.inserted} imported.</Notice>
          {result.errors.length > 0 && <ul className="text-sm text-red-300 max-h-40 overflow-y-auto" aria-label="Skipped rows">{result.errors.map((e) => <li key={e.row}>Row {e.row + 1}: {e.message}</li>)}</ul>}
        </div>
      )}
      <div className="flex justify-end gap-2"><button className={btnGhost} onClick={onClose}>{result ? 'Close' : 'Cancel'}</button>{!result && <button className={btnPrimary} disabled={busy || rows.length === 0} onClick={run}>{busy ? 'Importing…' : 'Import'}</button>}</div>
    </Modal>
  );
}

export { Tooltip };
