'use client';
import { Suspense, useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase';
import { useCart } from '@/lib/cart';
import { fmt } from '@/lib/config';

interface MenuItem { barcode: string; name: string; category: string | null; price: number; available: number; stock_status: 'in' | 'low' | 'out'; image_url: string | null }

// A static export can't pre-render a dynamic /store/[id] path, so the store is a
// static /store route that reads ?id=<location> at runtime (client-side).
export default function StorePage() {
  return (
    <Suspense fallback={<p className="text-smoke">Loading…</p>}>
      <StoreInner />
    </Suspense>
  );
}

function StoreInner() {
  const search = useSearchParams();
  const router = useRouter();
  const locationId = String(search.get('id') || '');
  const cart = useCart();

  const [storeName, setStoreName] = useState('');
  const [menu, setMenu] = useState<MenuItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    if (!locationId) { setLoading(false); return; }
    const [{ data: loc }, { data: items }] = await Promise.all([
      supabase().from('locations').select('name, tenant_id').eq('id', locationId).maybeSingle(),
      supabase().rpc('storefront_menu', { p_location: locationId }),
    ]);
    if (loc) { setStoreName(loc.name); cart.setStore(loc.tenant_id, locationId); }
    setMenu((items as MenuItem[]) || []);
    setLoading(false);
  }, [locationId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    load();
    const t = setInterval(load, 25000); // poll for near-real-time stock (see 033 note)
    return () => clearInterval(t);
  }, [load]);

  const qtyInCart = (b: string) => cart.lines.find((l) => l.barcode === b)?.qty || 0;

  return (
    <div>
      <div className="flex flex-col items-start gap-2 mb-1">
        <button onClick={() => router.push('/')} className="inline-flex items-center gap-1 text-sm text-smoke hover:text-ink transition-colors">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
          All shops
        </button>
        <span className="eyebrow text-accent block">Reserve for pickup</span>
      </div>
      <h1 className="font-display font-extrabold text-3xl tracking-tight mb-5 mt-1">{storeName || 'Menu'}</h1>

      {loading ? (
        <div className="grid gap-3">{[0, 1, 2].map((i) => <div key={i} className="h-[76px] rounded-2xl bg-black/[0.04] animate-pulse" />)}</div>
      ) : menu.length === 0 ? (
        <div className="rounded-2xl border border-black/10 bg-white p-8 text-center text-smoke">Nothing available online right now — check back soon.</div>
      ) : (
        <div className="grid gap-3">
          {menu.map((it) => {
            const inCart = qtyInCart(it.barcode);
            const canAdd = it.stock_status !== 'out' && inCart < it.available;
            const out = it.stock_status === 'out';
            return (
              <div key={it.barcode} className={`bg-white rounded-2xl border border-black/10 shadow-tag p-4 flex items-center gap-3 ${out ? 'opacity-60' : ''}`}>
                {it.image_url ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={it.image_url} alt="" className="w-14 h-14 rounded-xl object-cover bg-black/5 shrink-0" />
                ) : (
                  <div className="w-14 h-14 rounded-xl bg-black/[0.04] grid place-items-center shrink-0 text-black/20" aria-hidden="true">
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.7"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">{it.name}</div>
                  {it.category && <div className="text-xs text-smoke mt-0.5">{it.category}</div>}
                  <div className="mt-1.5 flex items-center gap-2.5">
                    <span className="price text-accent text-lg">{fmt(it.price)}</span>
                    <StockPill status={it.stock_status} />
                  </div>
                </div>
                {inCart > 0 ? (
                  <div className="flex items-center gap-1.5">
                    <button aria-label="Remove one" className="w-9 h-9 rounded-xl border border-black/15 text-lg leading-none hover:border-accent hover:text-accent transition-colors" onClick={() => cart.setQty(it.barcode, inCart - 1)}>−</button>
                    <span className="w-6 text-center font-semibold tabular-nums">{inCart}</span>
                    <button aria-label="Add one" className="w-9 h-9 rounded-xl border border-black/15 text-lg leading-none hover:border-accent hover:text-accent transition-colors disabled:opacity-30 disabled:hover:border-black/15 disabled:hover:text-ink" disabled={!canAdd} onClick={() => cart.setQty(it.barcode, inCart + 1)}>+</button>
                  </div>
                ) : (
                  <button className="px-4 py-2.5 rounded-xl bg-ink text-white text-sm font-semibold hover:bg-char transition-colors disabled:opacity-30"
                    disabled={out}
                    onClick={() => cart.add({ barcode: it.barcode, name: it.name, price: it.price })}>Add</button>
                )}
              </div>
            );
          })}
        </div>
      )}

      {cart.count > 0 && (
        <div className="fixed bottom-0 inset-x-0 z-20 bg-char text-white shadow-[0_-8px_30px_-12px_rgba(0,0,0,0.5)]">
          <div className="max-w-3xl mx-auto px-4 py-3 flex items-center gap-4">
            <div className="flex-1">
              <span className="price text-lg">{fmt(cart.subtotal)}</span>
              <span className="text-white/60 text-sm"> · {cart.count} item{cart.count !== 1 ? 's' : ''}</span>
            </div>
            <button onClick={() => router.push('/checkout')} className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-accent hover:bg-ember transition-colors font-semibold">
              Checkout
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function StockPill({ status }: { status: 'in' | 'low' | 'out' }) {
  const map = {
    in: { t: 'In stock', c: 'bg-green-600/10 text-green-700' },
    low: { t: 'Low stock', c: 'bg-amber-500/15 text-amber-700' },
    out: { t: 'Out of stock', c: 'bg-red-600/10 text-red-700' },
  } as const;
  const s = map[status];
  return <span className={`inline-block rounded-full px-2 py-0.5 text-[11px] font-semibold ${s.c}`}>{s.t}</span>;
}
