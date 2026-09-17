import Link from 'next/link';

export const metadata = { title: 'Terms of Service — Rackd' };

const SECTIONS = [
  { id: 'acceptance', title: 'Acceptance of terms' },
  { id: 'age', title: 'Age requirement' },
  { id: 'platform', title: 'Rackd’s role vs. the store’s role' },
  { id: 'account', title: 'Your account' },
  { id: 'ordering', title: 'Placing an order' },
  { id: 'payment', title: 'Payment and the online order fee' },
  { id: 'pickup', title: 'Pickup, ID check, and no-shows' },
  { id: 'cancellations', title: 'Cancellations and refunds' },
  { id: 'conduct', title: 'Acceptable use' },
  { id: 'liability', title: 'Disclaimers and limitation of liability' },
  { id: 'changes', title: 'Changes to these terms' },
  { id: 'law', title: 'Governing law' },
  { id: 'contact', title: 'Contact' },
];

export default function Terms() {
  return (
    <div>
      <div className="flex flex-col items-start gap-2 mb-1">
        <span className="eyebrow text-accent block">Legal</span>

      </div>

      <h1 className="font-display font-extrabold text-3xl tracking-tight mb-2">Terms of Service</h1>

      <p className="text-sm text-smoke mb-8 tabular-nums">
        Effective <time dateTime="2026-01-01">January 1, 2026</time> &middot; Last updated <time dateTime="2026-01-01">January 1, 2026</time>
      </p>

      <nav aria-label="Sections" className="bg-white rounded-2xl border border-black/10 shadow-tag p-4 mb-8">
        <div className="text-xs font-semibold uppercase tracking-wide text-smoke mb-2">On this page</div>

        <ol className="grid sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">
          {SECTIONS.map((s, i) => (
            <li key={s.id}>
              <a href={`#${s.id}`} className="text-ink hover:text-accent transition-colors">
                <span className="tabular-nums text-smoke mr-1.5">{String(i + 1).padStart(2, '0')}</span>

                {s.title}
              </a>

            </li>

          ))}
        </ol>

      </nav>

      <div className="prose-legal grid gap-8 text-[15px] leading-relaxed text-ink/90">
        <section id="acceptance">
          <h2 className="font-display font-bold text-xl mb-2">1. Acceptance of terms</h2>

          <p>
            Rackd (&ldquo;Rackd,&rdquo; &ldquo;we,&rdquo; &ldquo;us&rdquo;) operates this ordering site so you can reserve
            products from a participating local store and pick them up in person. By creating an account or placing an
            order here, you agree to these Terms of Service. If you don&rsquo;t agree, please don&rsquo;t use this site.
          </p>

        </section>

        <section id="age">
          <h2 className="font-display font-bold text-xl mb-2">2. Age requirement</h2>

          <p>
            This site is restricted to customers <strong>21 years of age or older</strong>. The products offered here

            are age-restricted retail products. You confirm you are 21+ when you create an account, and store staff
            verify a valid government-issued photo ID in person before releasing any order — self-attesting your age
            online does not complete verification on its own.
          </p>

        </section>

        <section id="platform">
          <h2 className="font-display font-bold text-xl mb-2">3. Rackd&rsquo;s role vs. the store&rsquo;s role</h2>

          <p>
            Rackd provides the technology that lets a participating store publish its menu and accept reservations
            online. <strong>The store you order from is the seller of the products and the merchant of record for
            your purchase</strong> — Rackd does not manufacture, stock, or sell the products itself, and does not

            take title to them at any point. Rackd charges a separate online order fee (Section 6) for operating the
            reservation platform; this fee is Rackd&rsquo;s, not the store&rsquo;s, and is itemized separately from
            the store&rsquo;s prices at checkout.
          </p>

          <p className="mt-2">
            Questions about a specific product, its price, or its availability are the store&rsquo;s to answer —
            Rackd passes through what the store has entered into its own inventory system and doesn&rsquo;t
            independently verify it.
          </p>

        </section>

        <section id="account">
          <h2 className="font-display font-bold text-xl mb-2">4. Your account</h2>

          <p>
            You&rsquo;re responsible for the accuracy of the information on your account and for anything that
            happens under it. Tell us right away if you think someone else has access to your account. We may
            suspend or close an account that provides false age or identity information, or that we reasonably
            believe is being used to violate these terms or the law.
          </p>

        </section>

        <section id="ordering">
          <h2 className="font-display font-bold text-xl mb-2">5. Placing an order</h2>

          <p>
            Placing an order here <strong>reserves</strong> the items at a specific store location — it does not

            create a shipment or delivery. Reserved inventory is deducted at the moment of reservation, which is why
            a reservation can fail if two customers order the last unit of something at nearly the same time; if
            that happens, the affected item is called out before you pay.
          </p>

        </section>

        <section id="payment">
          <h2 className="font-display font-bold text-xl mb-2">6. Payment and the online order fee</h2>

          <p>
            Payment is collected online at the time you reserve your order, processed through Stripe. Your total
            includes the store&rsquo;s price for each item, applicable sales tax, and a 5% online order fee that
            covers the cost of running this reservation platform — each of these is itemized separately before you
            pay, nothing is bundled in silently.
          </p>

        </section>

        <section id="pickup">
          <h2 className="font-display font-bold text-xl mb-2">7. Pickup, ID check, and no-shows</h2>

          <p>
            Orders are <strong>pickup only</strong>, at the store location you ordered from, during that store&rsquo;s

            posted hours. Bring the government-issued photo ID that matches your account — store staff check it
            before handing over an age-restricted order, every time, with no exceptions. If you don&rsquo;t collect
            your order within the window the store communicates to you, the store may cancel it and restock the
            items; see Section 8 for what happens to your payment in that case.
          </p>

        </section>

        <section id="cancellations">
          <h2 className="font-display font-bold text-xl mb-2">8. Cancellations and refunds</h2>

          <p>
            A store can cancel a reservation it can&rsquo;t fulfill — an item turns out to be out of stock, an ID
            doesn&rsquo;t check out, or the order goes unclaimed past the pickup window — and refund the associated
            payment. Refund timing follows your card issuer&rsquo;s normal processing time once the store initiates
            it. Because these are in-person, ID-checked pickups rather than shipped goods, standard shipping-carrier
            remedies (lost-package claims, delivery guarantees) don&rsquo;t apply.
          </p>

        </section>

        <section id="conduct">
          <h2 className="font-display font-bold text-xl mb-2">9. Acceptable use</h2>

          <p>
            Don&rsquo;t use this site to place orders on someone else&rsquo;s behalf without their knowledge, to
            circumvent the age or ID verification described above, to resell age-restricted product to anyone who
            couldn&rsquo;t legally buy it directly, or to interfere with the site&rsquo;s normal operation (scraping
            inventory at high volume, attempting to bypass rate limits, probing for vulnerabilities without
            authorization).
          </p>

        </section>

        <section id="liability">
          <h2 className="font-display font-bold text-xl mb-2">10. Disclaimers and limitation of liability</h2>

          <p>
            This site is provided &ldquo;as is.&rdquo; Product listings, prices, and stock levels are set by each
            store and can change or contain errors; a store will contact you if something you ordered turns out to
            be unavailable. To the fullest extent the law allows, Rackd&rsquo;s liability for any claim relating to
            your use of this site is limited to the online order fee you paid on the order the claim relates to.
            Rackd is not liable for a store&rsquo;s product quality, pricing, or in-person conduct — those are the
            store&rsquo;s responsibility as the seller of record.
          </p>

        </section>

        <section id="changes">
          <h2 className="font-display font-bold text-xl mb-2">11. Changes to these terms</h2>

          <p>
            We may update these terms as the platform changes. We&rsquo;ll update the date at the top of this page
            when we do; continuing to use the site after an update means you accept the revised terms.
          </p>

        </section>

        <section id="law">
          <h2 className="font-display font-bold text-xl mb-2">12. Governing law</h2>

          <p>
            These terms are governed by the laws of the state in which the store you ordered from is located,
            without regard to conflict-of-law rules, since that store is the seller of record for your purchase.
          </p>

        </section>

        <section id="contact">
          <h2 className="font-display font-bold text-xl mb-2">13. Contact</h2>

          <p>
            Questions about these terms:{' '}
            <a href="mailto:support@r4ckd.net" className="text-accent font-semibold hover:underline">
              support@r4ckd.net
            </a>

            . Questions about a specific order or product are best directed to the store you ordered from, using
            the contact information on its pickup confirmation.
          </p>

        </section>

      </div>

      <div className="mt-10 pt-6 border-t border-black/10 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Link href="/privacy" className="text-smoke hover:text-accent transition-colors">Privacy Policy</Link>

        <Link href="/disclaimers" className="text-smoke hover:text-accent transition-colors">Disclaimers</Link>

        <Link href="/accessibility" className="text-smoke hover:text-accent transition-colors">Accessibility Statement</Link>

      </div>

    </div>

  );
}
