'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';

interface Loc { id: string; name: string; tenant_id: string }

export default function Home() {
  const [locs, setLocs] = useState<Loc[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase().from('locations').select('id, name, tenant_id').eq('is_storefront_enabled', true).order('name')
      .then(({ data }) => { setLocs((data as Loc[]) || []); setLoading(false); });
  }, []);

  return (
    <div>
      {/* Hero — the thesis: order ahead, skip the line. */}
      <section className="relative overflow-hidden rounded-3xl bg-char text-white px-6 py-10 sm:px-9 sm:py-12 mb-8">
        <div
          className="pointer-events-none absolute -right-16 -top-24 w-80 h-80 rounded-full blur-3xl"
          style={{ background: 'radial-gradient(circle, rgba(176,29,46,0.55), rgba(176,29,46,0) 70%)' }}
        />
        <div className="relative">
          <span className="eyebrow text-ember">Order ahead · Pickup in store</span>
          <h1 className="font-display font-extrabold text-4xl sm:text-5xl leading-[0.98] tracking-[-0.01em] mt-3 text-balance">
            Skip the counter.<br />Grab it off the rack.
          </h1>
          <p className="mt-4 text-white/70 max-w-md text-[15px] leading-relaxed">
            Reserve what you want from your local shop, pay online, and pick it up ready at the register. 21+ with valid ID.
          </p>
          <a href="#stores" className="mt-6 inline-flex items-center gap-2 rounded-full bg-accent hover:bg-ember transition-colors font-semibold text-white pl-5 pr-6 py-3">
            <span className="text-lg leading-none">+</span> Start a new order
          </a>
        </div>
      </section>

      <div id="stores" className="flex items-baseline justify-between mb-4">
        <h2 className="font-display font-extrabold text-2xl tracking-tight">Pick your shop</h2>
        <span className="text-sm text-smoke">{locs.length ? `${locs.length} nearby` : ''}</span>
      </div>

      {loading ? (
        <div className="grid gap-3">
          {[0, 1].map((i) => <div key={i} className="h-20 rounded-2xl bg-black/[0.04] animate-pulse" />)}
        </div>
      ) : locs.length === 0 ? (
        <div className="rounded-2xl border border-black/10 bg-white p-8 text-center">
          <div className="font-display font-bold text-lg">No shops online yet</div>
          <p className="text-sm text-smoke mt-1">Check back soon — stores are coming online for pickup ordering.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {locs.map((l) => (
            <Link
              key={l.id}
              href={`/store?id=${l.id}&t=${l.tenant_id}`}
              className="tap group flex items-center gap-4 bg-white rounded-2xl border border-black/10 shadow-tag p-4 hover:border-accent/40"
            >
              <span className="grid place-items-center w-11 h-11 rounded-xl bg-accent/10 text-accent shrink-0" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" /></svg>
              </span>
              <div className="min-w-0 flex-1">
                <div className="font-semibold truncate">{l.name}</div>
                <div className="text-sm text-smoke">Browse the menu &amp; reserve for pickup</div>
              </div>
              <span className="text-accent group-hover:translate-x-0.5 transition-transform" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
