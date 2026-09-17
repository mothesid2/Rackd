import Link from 'next/link';

export const metadata = { title: 'Accessibility Statement — Rackd' };

export default function Accessibility() {
  return (
    <div>
      <div className="flex flex-col items-start gap-2 mb-1">
        <span className="eyebrow text-accent block">Legal</span>

      </div>

      <h1 className="font-display font-extrabold text-3xl tracking-tight mb-2">Accessibility Statement</h1>

      <p className="text-sm text-smoke mb-8">
        Effective <time dateTime="2026-01-01">January 1, 2026</time>

      </p>

      <div className="grid gap-6 text-[15px] leading-relaxed text-ink/90">
        <section>
          <h2 className="font-display font-bold text-lg mb-2">Our commitment</h2>

          <p>
            We want anyone to be able to browse a store&rsquo;s menu, reserve an order, and manage their account
            here, regardless of ability. We build against the{' '}
            <a href="https://www.w3.org/WAI/standards-guidelines/wcag/" target="_blank" rel="noreferrer" className="text-accent font-semibold hover:underline">
              Web Content Accessibility Guidelines (WCAG) 2.1, level AA
            </a>{' '}

            as our working standard, and treat accessibility as an ongoing practice rather than a box we check once.
          </p>

        </section>

        <section>
          <h2 className="font-display font-bold text-lg mb-2">What we&rsquo;ve done</h2>

          <p className="mb-2">Concretely, on this site:</p>

          <ul className="list-disc pl-5 grid gap-1.5">
            <li>Pinch-to-zoom and browser text resizing are left enabled everywhere, including on mobile — nothing on this site locks the viewport to block enlarging text (WCAG 1.4.4, Resize Text).</li>

            <li>Text and status colors (including stock-availability badges) are checked against their backgrounds for the WCAG AA contrast floor of 4.5:1, not just picked for brand appearance.</li>

            <li>Interactive controls carry visible labels or <code>aria-label</code>s for screen readers, not icon-only buttons with no accessible name.</li>
            <li>The site is built with real HTML structure — headings, landmarks, and form labels — rather than div soup styled to look interactive.</li>

          </ul>

        </section>

        <section>
          <h2 className="font-display font-bold text-lg mb-2">Known limitations</h2>

          <p>
            We haven&rsquo;t run a full third-party WCAG audit of every screen on this site, and a site this size can
            always have gaps we haven&rsquo;t found yet. If something doesn&rsquo;t work with the assistive
            technology you use, we want to know specifically what happened, not just that &ldquo;it&rsquo;s
            broken&rdquo; — see below.
          </p>

        </section>

        <section>
          <h2 className="font-display font-bold text-lg mb-2">Reporting a problem</h2>

          <p>
            Tell us what page you were on, what you were trying to do, and what assistive technology or browser
            settings you were using, and we&rsquo;ll look into it:{' '}
            <a href="mailto:support@r4ckd.net" className="text-accent font-semibold hover:underline">support@r4ckd.net</a>.

            We can&rsquo;t promise a fix by any particular date, but every report gets read by a person, not
            filtered out.
          </p>

        </section>

        <section>
          <h2 className="font-display font-bold text-lg mb-2">Scope</h2>

          <p>
            This statement covers the Rackd ordering site you&rsquo;re on now. Each participating store manages its
            own product photos, names, and descriptions, so image alt text quality for a specific product can vary
            by store — flag a specific one to us and we&rsquo;ll follow up with that store directly.
          </p>

        </section>

      </div>

      <div className="mt-10 pt-6 border-t border-black/10 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Link href="/terms" className="text-smoke hover:text-accent transition-colors">Terms of Service</Link>

        <Link href="/privacy" className="text-smoke hover:text-accent transition-colors">Privacy Policy</Link>

        <Link href="/disclaimers" className="text-smoke hover:text-accent transition-colors">Disclaimers</Link>

      </div>

    </div>

  );
}
