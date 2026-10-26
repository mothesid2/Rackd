'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cartCount, useCart } from '@/lib/hardware/cart';
import { useTestMode } from '@/lib/hardware/api';
import { stockStatus, type Product } from '@/lib/hardware/pricing';
import { Notice } from '../onboarding/fields';

export function HardwareNav() {
  const cart = useCart();
  const path = usePathname() ?? '';
  const n = cartCount(cart);
  const link = (href: string, label: ReactNode, match: (p: string) => boolean) => (
    <Link href={href} aria-current={match(path) ? 'page' : undefined}
      className={`min-h-[44px] inline-flex items-center px-3 text-sm border-b-2 transition-colors ${match(path) ? 'border-ember text-ink font-semibold' : 'border-transparent text-smoke hover:text-ink'}`}>
      {label}
    </Link>
  );
  return (
    <nav aria-label="Hardware store" className="flex flex-wrap items-center gap-x-1 border-b border-line mb-5 -mx-1">
      {link('/hardware/', 'Catalog', (p) => p === '/hardware/' || p === '/hardware' || p.startsWith('/hardware/product') || p.startsWith('/hardware/build'))}
      {link('/hardware/compatibility/', 'Bring your own', (p) => p.startsWith('/hardware/compatibility'))}
      <span className="flex-1" />
      {link('/hardware/cart/', <>Cart{n > 0 && <span className="ml-1.5 rounded-full bg-accent text-white text-xs px-2 py-0.5 tabular-nums" aria-label={`${n} items`}>{n}</span>}</>, (p) => p.startsWith('/hardware/cart'))}
    </nav>
  );
}

/** Visible while STRIPE_LIVE_ENABLED=false (and while the mode is still unknown). */
export function TestModeBanner() {
  const test = useTestMode();
  if (test === false) return null;
  return (
    <div className="mb-4">
      <Notice tone="dev"><strong>Test mode.</strong> Payments on this page are not real. Use Stripe test cards only; no money moves and nothing ships.</Notice>
    </div>
  );
}

export function PlaceholderBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return <div className="mb-4"><Notice tone="warn"><strong>Placeholder catalog.</strong> Prices, stock and specifications are not final.</Notice></div>;
}

export function StockBadge({ product }: { product: Pick<Product, 'stock_qty'> }) {
  const s = stockStatus(product);
  const cls = s.tone === 'ok' ? 'text-green-400' : s.tone === 'low' ? 'text-amber-300' : 'text-red-400';
  return <span className={`text-xs font-semibold ${cls}`}>{s.tone === 'out' ? '✕ ' : '● '}{s.label}</span>;
}

/** Product photo. Real images come from products.images; until then a neutral placeholder is drawn. */
export function ProductImage({ src, alt, className = '' }: { src?: string; alt: string; className?: string }) {
  if (src) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} className={`object-cover ${className}`} loading="lazy" />;
  }
  return (
    <div role="img" aria-label={`${alt} (no photo yet)`} className={`flex items-center justify-center bg-steel text-smoke ${className}`}>
      <svg width="40%" viewBox="0 0 64 48" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
        <rect x="6" y="6" width="52" height="30" rx="3" /><path d="M22 44h20M32 36v8" />
      </svg>
    </div>
  );
}

export function Gallery({ images, name }: { images: string[]; name: string }) {
  const [i, setI] = useState(0);
  const list = images.length ? images : [''];
  return (
    <div>
      <ProductImage src={list[i] || undefined} alt={name} className="w-full aspect-square rounded-2xl border border-line" />
      {list.length > 1 && (
        <ul className="mt-3 flex gap-2 overflow-x-auto" aria-label="Product photos">
          {list.map((src, idx) => (
            <li key={idx}>
              <button type="button" onClick={() => setI(idx)} aria-label={`Show photo ${idx + 1}`} aria-pressed={idx === i}
                className={`block w-16 h-16 rounded-lg overflow-hidden border-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-ember ${idx === i ? 'border-ember' : 'border-line'}`}>
                <ProductImage src={src} alt={`${name} photo ${idx + 1}`} className="w-full h-full" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function QtyStepper({ value, max, onChange, label }: { value: number; max: number; onChange: (n: number) => void; label: string }) {
  const btn = 'w-11 h-11 rounded-lg border border-line hover:border-smoke text-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ember disabled:opacity-40';
  return (
    <div className="inline-flex items-center gap-1" role="group" aria-label={label}>
      <button type="button" className={btn} onClick={() => onChange(value - 1)} aria-label="Decrease quantity" disabled={value <= 0}>−</button>
      <span className="w-10 text-center tabular-nums" aria-live="polite">{value}</span>
      <button type="button" className={btn} onClick={() => onChange(value + 1)} aria-label="Increase quantity" disabled={value >= max}>+</button>
    </div>
  );
}

export function CatalogError() {
  return <Notice tone="warn">We could not load the hardware catalog right now. Please refresh and try again.</Notice>;
}
