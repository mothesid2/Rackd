import Link from 'next/link';

export const metadata = { title: 'Disclaimers — Rackd' };

export default function Disclaimers() {
  return (
    <div>
      <div className="flex flex-col items-start gap-2 mb-1">
        <span className="eyebrow text-accent block">Legal</span>

      </div>

      <h1 className="font-display font-extrabold text-3xl tracking-tight mb-2">Disclaimers</h1>

      <p className="text-sm text-smoke mb-8">
        Effective <time dateTime="2026-01-01">January 1, 2026</time>

      </p>

      <div className="grid gap-6">
        <div className="bg-white rounded-2xl border border-black/10 shadow-tag p-5">
          <h2 className="font-display font-bold text-lg mb-2">Age-restricted products</h2>

          <p className="text-[15px] leading-relaxed text-ink/90">
            Everything offered through this site is restricted to buyers 21 and older. Nothing on this site is
            marketed to, or intended for, anyone under 21. Vapor and nicotine products are not risk-free — nicotine
            is an addictive chemical. If you don&rsquo;t currently use nicotine products, don&rsquo;t start.
          </p>

        </div>

        <div className="bg-white rounded-2xl border border-black/10 shadow-tag p-5">
          <h2 className="font-display font-bold text-lg mb-2">No medical or health claims</h2>

          <p className="text-[15px] leading-relaxed text-ink/90">
            Nothing on this site is a medical claim, a cessation aid, or a substitute for advice from a doctor or
            pharmacist. Product descriptions come from the manufacturer or the store carrying the item; Rackd
            doesn&rsquo;t evaluate or endorse health, safety, or efficacy claims about any product listed here.
          </p>

        </div>

        <div className="bg-white rounded-2xl border border-black/10 shadow-tag p-5">
          <h2 className="font-display font-bold text-lg mb-2">Pricing, availability &amp; product data</h2>

          <p className="text-[15px] leading-relaxed text-ink/90">
            Each store manages its own prices, descriptions, images, and stock counts. Rackd displays what a store
            has entered and doesn&rsquo;t independently verify it — occasional mismatches (a photo that doesn&rsquo;t
            match a new package design, a price that changed in-store before the online listing caught up) are the
            store&rsquo;s to correct, not evidence of intentional misrepresentation by either party. Reserving an
            item online is not a guarantee of the exact final packaging or batch you&rsquo;ll receive.
          </p>

        </div>

        <div className="bg-white rounded-2xl border border-black/10 shadow-tag p-5">
          <h2 className="font-display font-bold text-lg mb-2">Rackd is a platform, not the seller</h2>

          <p className="text-[15px] leading-relaxed text-ink/90">
            Rackd operates the technology behind this ordering site. The store you select is the seller of record
            for anything you order — Rackd doesn&rsquo;t hold, ship, or take title to inventory. See{' '}
            <Link href="/terms#platform" className="text-accent font-semibold hover:underline">Terms of Service &sect; 3</Link> for

            how that split works, including for payments and refunds.
          </p>

        </div>

        <div className="bg-white rounded-2xl border border-black/10 shadow-tag p-5">
          <h2 className="font-display font-bold text-lg mb-2">External links</h2>

          <p className="text-[15px] leading-relaxed text-ink/90">
            Where this site links out (a manufacturer&rsquo;s site, a map to a store, a payment processor), that
            destination has its own terms and privacy practices that Rackd doesn&rsquo;t control.
          </p>

        </div>

      </div>

      <div className="mt-10 pt-6 border-t border-black/10 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Link href="/terms" className="text-smoke hover:text-accent transition-colors">Terms of Service</Link>

        <Link href="/privacy" className="text-smoke hover:text-accent transition-colors">Privacy Policy</Link>

        <Link href="/accessibility" className="text-smoke hover:text-accent transition-colors">Accessibility Statement</Link>

      </div>

    </div>

  );
}
