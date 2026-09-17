'use client';
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { supabase } from '@/lib/supabase';
import { Reveal, RevealGroup, RevealItem } from '@/components/Reveal';
import { SmokeHero } from '@/components/SmokeHero';

interface Loc { id: string; name: string; tenant_id: string; address: string | null; zip: string | null; logo_url: string | null; show_logo: boolean }


const zipCache = new Map<string, { lat: number; lng: number } | null>();
async function geocodeZip(zip: string): Promise<{ lat: number; lng: number } | null> {
  const z = (zip || '').trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  if (zipCache.has(z)) return zipCache.get(z)!;
  try {
    const res = await fetch(`https://api.zippopotam.us/us/${z}`);
    if (!res.ok) { zipCache.set(z, null); return null; }
    const j = await res.json();
    const p = j?.places?.[0];
    const coord = p ? { lat: parseFloat(p.latitude), lng: parseFloat(p.longitude) } : null;
    zipCache.set(z, coord);
    return coord;
  } catch { zipCache.set(z, null); return null; }
}
function milesBetween(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 3958.8, toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

export default function Home() {
  const [locs, setLocs] = useState<Loc[]>([]);
  const [loading, setLoading] = useState(true);
  const [origin, setOrigin] = useState<{ lat: number; lng: number } | null>(null);
  const [dist, setDist] = useState<Record<string, number>>({});
  const [zipInput, setZipInput] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    supabase().from('locations').select('id, name, tenant_id, address, zip, logo_url, show_logo').eq('is_storefront_enabled', true).order('name')
      .then(({ data }) => { setLocs((data as Loc[]) || []); setLoading(false); });
  }, []);

  
  async function sortFrom(from: { lat: number; lng: number }, label: string) {
    setBusy(true); setNote(null);
    const entries = await Promise.all(locs.map(async (l) => {
      const c = l.zip ? await geocodeZip(l.zip) : null;
      return [l.id, c ? milesBetween(from, c) : Number.POSITIVE_INFINITY] as const;
    }));
    setDist(Object.fromEntries(entries));
    setOrigin(from);
    setNote(`Sorted by distance from ${label}`);
    setBusy(false);
  }

  function useMyLocation() {
    setNote(null);
    if (!('geolocation' in navigator)) { setNote('Location isn’t available — enter a ZIP instead.'); return; }
    setBusy(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => sortFrom({ lat: pos.coords.latitude, lng: pos.coords.longitude }, 'your location'),
      () => { setBusy(false); setNote('Location permission denied — enter a ZIP instead.'); },
      { timeout: 8000 }
    );
  }
  async function useZip() {
    const c = await geocodeZip(zipInput);
    if (!c) { setNote('Couldn’t find that ZIP — check it and try again.'); return; }
    sortFrom(c, zipInput.trim().slice(0, 5));
  }
  function clearSort() { setOrigin(null); setDist({}); setNote(null); setZipInput(''); }

  
  const sorted = useMemo(() => {
    if (!origin) return locs;
    return [...locs].sort((a, b) => (dist[a.id] ?? Infinity) - (dist[b.id] ?? Infinity));
  }, [locs, origin, dist]);

  
  const ordered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return sorted;
    return sorted.filter((l) =>
      l.name.toLowerCase().includes(needle) ||
      (l.zip || '').toLowerCase().includes(needle) ||
      (l.address || '').toLowerCase().includes(needle)
    );
  }, [sorted, q]);

  return (
    <div>
      {}
      <section className="relative -mx-4 px-4 pt-8 pb-12 sm:pt-14 sm:pb-16">
        {}
        <div
          className="ember-glow pointer-events-none absolute -right-40 -top-48 w-[44rem] h-[44rem] rounded-full blur-[100px]"
          style={{ background: 'radial-gradient(circle, rgba(224,41,61,0.4), rgba(224,41,61,0) 42%)' }}
        />

        {}
        <SmokeHero className="pointer-events-none absolute inset-0 w-full h-full" />
        <div className="relative max-w-3xl mx-auto">
          <Reveal direction="down"><span className="eyebrow text-ember block">Order ahead · Pickup in store</span></Reveal>
          <Reveal delay={0.09}>
            <h1 className="font-display font-extrabold text-[13vw] leading-[0.94] tracking-[-0.02em] mt-3 text-balance sm:text-6xl">
              Skip the counter.<br /><span className="text-ember">Grab it off the rack.</span>

            </h1>

          </Reveal>

          <Reveal delay={0.18}>
            <p className="mt-5 text-smoke max-w-md text-base leading-relaxed">
              Reserve what you want from your local shop, pay online, and pick it up ready at the register.
            </p>

          </Reveal>

          <Reveal delay={0.26}>
            <motion.a
              href="#stores"
              whileHover={{ boxShadow: '0 0 0 6px rgba(176,29,46,0.18)' }}
              whileTap={{ scale: 0.97 }}
              className="mt-7 inline-flex items-center gap-2 rounded-lg bg-accent hover:bg-ember transition-colors font-semibold text-white pl-5 pr-6 py-3.5"
            >
              <span className="text-lg leading-none">+</span> Start a new order

            </motion.a>

          </Reveal>


          {}
          <Reveal delay={0.34} className="mt-9 flex flex-wrap gap-x-6 gap-y-2.5 text-[13px] text-smoke">
            <>
              <span className="inline-flex items-center gap-1.5">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60 shrink-0"><path d="M12 2 3 6v6c0 5 3.8 8.7 9 10 5.2-1.3 9-5 9-10V6l-9-4Z" /></svg>

                21+ only, valid ID required at pickup
              </span>

              <span className="inline-flex items-center gap-1.5">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60 shrink-0"><path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1V9.5Z" /></svg>

                In-store pickup only — no shipping
              </span>

              <span className="inline-flex items-center gap-1.5">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="opacity-60 shrink-0"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18" /></svg>

                Pay online, nothing charged until reserved
              </span>

            </>

          </Reveal>

        </div>

      </section>


      <Reveal className="mb-3 mt-2">
        <div id="stores" className="scroll-mt-20">
          <span className="eyebrow text-accent">Get started</span>

          <div className="flex items-baseline justify-between mt-1.5">
            <h2 className="font-display font-extrabold text-2xl tracking-tight">Pick your shop</h2>

            <span className="text-sm text-smoke">{locs.length ? `${locs.length} ${locs.length === 1 ? 'store' : 'stores'}` : ''}</span>

          </div>

          <span className="line-draw block h-px w-full bg-line mt-3" />
        </div>

      </Reveal>


      {}
      {locs.length > 1 && (
        <Reveal className="mb-3">
          <div className="inline-flex items-center gap-2 rounded-lg border border-line bg-paper px-3.5 py-2.5 w-full sm:w-80 focus-within:border-accent/50 transition-colors">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" className="text-smoke shrink-0"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.35-4.35" /></svg>

            <input
              value={q} onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, ZIP, or address"
              className="w-full text-sm outline-none bg-transparent placeholder:text-smoke/70"
              aria-label="Search shops by name, ZIP, or address"
            />
          </div>

        </Reveal>

      )}

      {}
      {locs.length > 1 && (
        <Reveal className="mb-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-smoke mb-1.5">Sort by location (closest)</div>

          <div className="flex flex-wrap items-center gap-2">
            <button onClick={useMyLocation} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-paper px-3.5 py-2 text-sm font-semibold hover:border-accent transition-colors disabled:opacity-50">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 21s7-6.5 7-12a7 7 0 1 0-14 0c0 5.5 7 12 7 12z" /><circle cx="12" cy="9" r="2.5" /></svg>

              Near me
            </button>

            <div className="inline-flex items-center rounded-lg border border-line bg-paper overflow-hidden focus-within:border-accent/50 transition-colors">
              <input value={zipInput} onChange={(e) => setZipInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') useZip(); }} inputMode="numeric" maxLength={5} placeholder="ZIP" className="w-20 px-3 py-2 text-sm outline-none bg-transparent placeholder:text-smoke/70" />
              <button onClick={useZip} disabled={busy} className="px-3 py-2 text-sm font-semibold text-ember disabled:opacity-50">Sort</button>

            </div>

            {origin && <button onClick={clearSort} className="text-sm text-smoke underline underline-offset-2 hover:text-ink transition-colors">Reset</button>}

          </div>

        </Reveal>

      )}
      {note && <p className="text-xs text-smoke mb-3 -mt-1">{note}</p>}

      {q.trim() && <p className="text-xs text-smoke mb-3 -mt-1">{ordered.length} match{ordered.length === 1 ? '' : 'es'} for "{q.trim()}"</p>}


      {loading ? (
        <div className="grid gap-3">{[0, 1].map((i) => <div key={i} className="h-20 rounded-lg skel" />)}</div>

      ) : locs.length === 0 ? (
        <Reveal className="rounded-lg border border-line bg-paper p-8 text-center">
          <>
            <div className="font-display font-bold text-lg">No shops online yet</div>

            <p className="text-sm text-smoke mt-1">Check back soon — stores are coming online for pickup ordering.</p>

          </>

        </Reveal>

      ) : ordered.length === 0 ? (
        <Reveal className="rounded-lg border border-line bg-paper p-8 text-center">
          <>
            <div className="font-display font-bold text-lg">No shops match "{q.trim()}"</div>

            <p className="text-sm text-smoke mt-1">Try a different name, ZIP, or address.</p>

          </>

        </Reveal>

      ) : (
        <RevealGroup className="grid gap-3" stagger={0.06}>
          {ordered.map((l) => {
            const mi = dist[l.id];
            return (
              <RevealItem key={l.id}>
                <motion.div whileHover={{ y: -3, boxShadow: '0 14px 32px -14px rgba(176,29,46,0.35)' }} whileTap={{ scale: 0.98 }}>
                  <Link
                    href={`/store?id=${l.id}&t=${l.tenant_id}`}
                    className="group flex items-center gap-4 bg-paper rounded-lg border border-line p-4 hover:border-accent/40 transition-colors"
                  >
                    {l.show_logo && l.logo_url ? (
                      
                      <img src={l.logo_url} alt="" loading="lazy" decoding="async" width={44} height={44} className="w-11 h-11 rounded-xl object-cover bg-steel shrink-0" />
                    ) : (
                      <span className="grid place-items-center w-11 h-11 rounded-xl bg-accent/10 text-ember shrink-0" aria-hidden="true">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" /><path d="M3 6h18" /><path d="M16 10a4 4 0 0 1-8 0" /></svg>

                      </span>

                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-semibold truncate">{l.name}</div>

                      {l.address && <div className="text-sm text-smoke truncate">{l.address}</div>}

                    </div>

                    {origin && mi != null && isFinite(mi) && <span className="text-xs font-semibold text-smoke shrink-0">{mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi</span>}

                    <span className="text-ember group-hover:translate-x-0.5 transition-transform" aria-hidden="true">
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>

                    </span>

                  </Link>

                </motion.div>

              </RevealItem>

            );
          })}
        </RevealGroup>

      )}
    </div>

  );
}
