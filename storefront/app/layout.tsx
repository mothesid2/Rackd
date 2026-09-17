import type { Metadata, Viewport } from 'next';
import { Archivo, Instrument_Sans } from 'next/font/google';
import './globals.css';
import { CartProvider } from '@/lib/cart';
import { AppQueryProvider } from '@/lib/queryClient';
import Link from 'next/link';


const display = Archivo({ subsets: ['latin'], weight: ['600', '700', '800', '900'], variable: '--font-display', display: 'swap' });
const body = Instrument_Sans({ subsets: ['latin'], weight: ['400', '500', '600', '700'], variable: '--font-body', display: 'swap' });

export const metadata: Metadata = {
  title: 'Rackd — Order & Pickup',
  description: 'Order ahead from your local shop and pick it up in store. 21+ only.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#101216' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`}>
      <body>
        {process.env.NEXT_PUBLIC_DEMO === '1' && (
          <div style={{ position: 'fixed', top: 8, right: 10, zIndex: 2147483647, background: '#b01d2e', color: '#fff', font: '700 11px system-ui, sans-serif', letterSpacing: 2, padding: '4px 10px', borderRadius: 6, pointerEvents: 'none', boxShadow: '0 2px 10px rgba(0,0,0,.45)' }}>
            DEMO
          </div>

        )}
        <AppQueryProvider>
        <CartProvider>
          <header className="sticky top-0 z-30 bg-char/90 backdrop-blur-md border-b border-line text-white">
            <div className="max-w-3xl mx-auto flex items-center gap-3 px-4 h-16">
              <Link href="/" className="flex items-center gap-2.5 shrink-0">
                {}
                <img src="/logo-mark.svg" alt="Rackd" className="w-7 h-7" />
                <span className="font-display text-2xl font-extrabold tracking-[0.06em] leading-none">
                  Rack<span className="text-ember">D</span>

                </span>

              </Link>

              <div className="flex-1" />
              <Link href="/orders" className="text-sm text-white/70 hover:text-white transition-colors">Orders</Link>

              <Link href="/account" className="text-sm text-white/70 hover:text-white transition-colors">Account</Link>

              <Link
                href="/"
                className="ml-1 inline-flex items-center gap-1.5 rounded-lg bg-accent hover:bg-ember transition-colors text-white text-sm font-semibold pl-3.5 pr-4 py-2"
              >
                <span className="text-base leading-none">+</span> New Order

              </Link>

            </div>

          </header>


          <main className="max-w-3xl mx-auto px-4 py-6 pb-28">{children}</main>


          <footer className="mt-10 border-t border-line">
            <div className="max-w-3xl mx-auto px-4 py-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-smoke">
              {}
              <img src="/logo-mark.svg" alt="" className="w-5 h-5 opacity-70" />
              <span>Must be 21+ with valid ID. Pickup only — bring your ID to collect your order.</span>

              <span className="flex-1" />
              <a href="mailto:support@r4ckd.net" className="font-semibold text-ink hover:text-ember transition-colors">
                Contact us: support@r4ckd.net
              </a>

            </div>

            <div className="max-w-3xl mx-auto px-4 pb-8 flex flex-wrap gap-x-4 gap-y-1 text-xs text-smoke">
              <Link href="/terms" className="hover:text-ember transition-colors">Terms of Service</Link>

              <Link href="/privacy" className="hover:text-ember transition-colors">Privacy Policy</Link>

              <Link href="/disclaimers" className="hover:text-ember transition-colors">Disclaimers</Link>

              <Link href="/accessibility" className="hover:text-ember transition-colors">Accessibility Statement</Link>

            </div>

          </footer>

        </CartProvider>

        </AppQueryProvider>

      </body>

    </html>

  );
}
