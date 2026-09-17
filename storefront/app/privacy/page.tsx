import Link from 'next/link';

export const metadata = { title: 'Privacy Policy — Rackd' };

const SECTIONS = [
  { id: 'overview', title: 'Overview' },
  { id: 'collect', title: 'What we collect' },
  { id: 'use', title: 'How we use it' },
  { id: 'share', title: 'Who we share it with' },
  { id: 'retention', title: 'How long we keep it' },
  { id: 'rights', title: 'Your choices and rights' },
  { id: 'security', title: 'Security' },
  { id: 'children', title: 'Age' },
  { id: 'changes', title: 'Changes to this policy' },
  { id: 'contact', title: 'Contact' },
];

export default function Privacy() {
  return (
    <div>
      <div className="flex flex-col items-start gap-2 mb-1">
        <span className="eyebrow text-accent block">Legal</span>

      </div>

      <h1 className="font-display font-extrabold text-3xl tracking-tight mb-2">Privacy Policy</h1>

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

      <div className="grid gap-8 text-[15px] leading-relaxed text-ink/90">
        <section id="overview">
          <h2 className="font-display font-bold text-xl mb-2">1. Overview</h2>

          <p>
            This policy covers the personal information Rackd collects when you create an account and place an
            order on this site, and what happens to it. It doesn&rsquo;t cover the participating store&rsquo;s own
            handling of information once you&rsquo;re standing in front of their counter — see{' '}
            <Link href="/terms#platform" className="text-accent font-semibold hover:underline">Terms of Service &sect; 3</Link>{' '}

            for how Rackd&rsquo;s role and the store&rsquo;s role split.
          </p>

        </section>

        <section id="collect">
          <h2 className="font-display font-bold text-xl mb-2">2. What we collect</h2>

          <p className="mb-2">Only what&rsquo;s actually needed to run an account and a pickup order:</p>

          <ul className="list-disc pl-5 grid gap-1.5">
            <li><strong>Account info:</strong> name, email and/or phone number, and — if you sign up with Apple or Google — the name/email your provider shares with us.</li>

            <li><strong>Age verification:</strong> the date of birth you self-attest at signup, and whether a store later confirmed 21+ in person. We don&rsquo;t collect or store a copy of your photo ID — that check happens visually at pickup and isn&rsquo;t recorded here.</li>
            <li><strong>Order data:</strong> what you reserved, which store, and its status (reserved, ready, picked up, cancelled).</li>
            <li><strong>Payment:</strong> handled entirely by Stripe — Rackd never receives or stores your card number. We keep a reference to the Stripe customer and payment records tied to your account so receipts and refunds work.</li>
            <li><strong>SMS/marketing consent:</strong> whether you opted in to order-status texts and/or promotional texts, and the phone number consent applies to — see the checkboxes on your{' '}
              <Link href="/account" className="text-accent font-semibold hover:underline">Account</Link> page, which is where you set these, not this policy.

            </li>

            <li><strong>Basic technical data:</strong> standard web request data (IP address, browser) that our hosting and rate-limiting infrastructure sees automatically, the way any web server does.</li>
          </ul>

          <p className="mt-2 text-smoke text-sm">We don&rsquo;t run any analytics or ad-tracking scripts on this site.</p>

        </section>

        <section id="use">
          <h2 className="font-display font-bold text-xl mb-2">3. How we use it</h2>

          <ul className="list-disc pl-5 grid gap-1.5">
            <li>To create and secure your account, and to let you sign back in.</li>

            <li>To reserve your order at the store you chose, process payment, and let the store see what to prepare.</li>

            <li>To text or email you about an order — confirmed, ready for pickup — if you opted into those messages.</li>

            <li>To text you promotions or loyalty offers, only if you separately opted into that (declining doesn&rsquo;t affect your ability to order).</li>

            <li>To prevent abuse — the same rate-limiting that stops scripted signup/checkout attempts uses request data described above.</li>

          </ul>

        </section>

        <section id="share">
          <h2 className="font-display font-bold text-xl mb-2">4. Who we share it with</h2>

          <p className="mb-2">
            We don&rsquo;t sell personal information. It&rsquo;s shared only with the vendors that make the site work,
            each only for the purpose below, and with the store you ordered from:
          </p>

          <ul className="list-disc pl-5 grid gap-1.5">
            <li><strong>The store you order from</strong> — your name, order contents, and enough contact info to hand off the order and text you if needed.</li>
            <li><strong>Supabase</strong> — our database, authentication, and file-storage provider. Your account and order records live in Supabase&rsquo;s infrastructure.</li>
            <li><strong>Stripe</strong> — processes your payment and stores your payment method under its own privacy practices; we only hold a reference to it, not the card details.</li>
            <li><strong>Twilio</strong> — sends the order-status and marketing texts you opted into.</li>
            <li><strong>Resend</strong> — sends transactional emails (order confirmations, receipts).</li>
          </ul>

          <p className="mt-2">
            We&rsquo;d share information beyond this list only if the law requires it (a valid subpoena or court
            order) or to investigate fraud or a security incident.
          </p>

        </section>

        <section id="retention">
          <h2 className="font-display font-bold text-xl mb-2">5. How long we keep it</h2>

          <p>
            We keep account and order records as long as your account is active, plus a reasonable period after —
            stores and Rackd both have legitimate reasons to keep sales and age-verification records (tax,
            accounting, and compliance with tobacco/vapor retail record-keeping expectations). If you delete your
            account, we remove what we can while still meeting those obligations for records already tied to
            completed orders.
          </p>

        </section>

        <section id="rights">
          <h2 className="font-display font-bold text-xl mb-2">6. Your choices and rights</h2>

          <ul className="list-disc pl-5 grid gap-1.5">
            <li><strong>Update your info:</strong> your name, phone, and marketing/order-text preferences are all editable directly on your <Link href="/account" className="text-accent font-semibold hover:underline">Account</Link> page.</li>
            <li><strong>Opt out of texts:</strong> uncheck the consent boxes on your Account page, or reply STOP to any text.</li>
            <li><strong>Access, correction, or deletion:</strong> email us (below) from the address or with the phone number on your account so we can verify it&rsquo;s really you, and we&rsquo;ll act on it, subject to the retention needs in Section 5. If you&rsquo;re a California resident, this includes your CCPA rights to know, delete, and correct your information, and we won&rsquo;t discriminate against you for exercising them.</li>
          </ul>

        </section>

        <section id="security">
          <h2 className="font-display font-bold text-xl mb-2">7. Security</h2>

          <p>
            Your account is protected by the password/PIN and login flow you set up, payment details never touch
            our servers (Stripe handles that directly), and our database access is governed by row-level security
            policies that scope what any given request can see. No system is perfectly secure, but we treat account
            and order data as sensitive by design, not as an afterthought.
          </p>

        </section>

        <section id="children">
          <h2 className="font-display font-bold text-xl mb-2">8. Age</h2>

          <p>
            This site is for adults 21 and older. We don&rsquo;t knowingly collect information from anyone under 21;
            see <Link href="/terms#age" className="text-accent font-semibold hover:underline">Terms of Service &sect; 2</Link>.

          </p>

        </section>

        <section id="changes">
          <h2 className="font-display font-bold text-xl mb-2">9. Changes to this policy</h2>

          <p>
            If we change how we handle your information in a meaningful way, we&rsquo;ll update the date at the top
            of this page. Continuing to use the site after that means you accept the update.
          </p>

        </section>

        <section id="contact">
          <h2 className="font-display font-bold text-xl mb-2">10. Contact</h2>

          <p>
            Questions, or a request to access/correct/delete your information:{' '}
            <a href="mailto:support@r4ckd.net" className="text-accent font-semibold hover:underline">support@r4ckd.net</a>.

          </p>

        </section>

      </div>

      <div className="mt-10 pt-6 border-t border-black/10 flex flex-wrap gap-x-6 gap-y-2 text-sm">
        <Link href="/terms" className="text-smoke hover:text-accent transition-colors">Terms of Service</Link>

        <Link href="/disclaimers" className="text-smoke hover:text-accent transition-colors">Disclaimers</Link>

        <Link href="/accessibility" className="text-smoke hover:text-accent transition-colors">Accessibility Statement</Link>

      </div>

    </div>

  );
}
