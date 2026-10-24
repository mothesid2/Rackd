// Versioned legal text shown in the wizard AND hashed server-side (sha256 of agreementText()) so the
// stored signature proves exactly which words were agreed to. Changing any text requires a new
// version string; the database refuses a changed hash under an existing version (migration 088).
//
// DRAFT: these are working drafts, not reviewed by counsel. Have an attorney review before launch.

export interface LegalSection {
  heading: string;
  body: string;
}

export interface LegalDoc {
  kind: 'terms_of_service' | 'merchant_agreement';
  version: string;
  title: string;
  sections: LegalSection[];
}

export const TERMS_OF_SERVICE: LegalDoc = {
  kind: 'terms_of_service',
  version: '2026-10-draft-1',
  title: 'Rackd Terms of Service',
  sections: [
    { heading: '1. The service', body: 'Rackd provides software for retail shops, including a point of sale, an online reserve-and-pickup storefront, inventory tools and reporting. Rackd is a software provider. It is not the seller of the products your shop sells.' },
    { heading: '2. Your account', body: 'You must provide accurate business information and keep it current. You are responsible for activity under your account and for keeping your credentials secure.' },
    { heading: '3. Eligibility and compliance', body: 'You represent that your business is lawfully organized and holds every license and permit required to sell the products you list, and that those permits are current. You agree to maintain them and to tell Rackd promptly if one lapses or is revoked. Rackd may suspend features for a location whose permits are expired.' },
    { heading: '4. Age-restricted products', body: 'You are solely responsible for verifying that every customer is at least 21 years old, in person, with valid government photo identification, and for complying with all federal, state and local laws that apply to your products and your sales. Rackd tools support, but do not replace, your own compliance obligations.' },
    { heading: '5. Fees', body: 'Subscription, add-on, hardware and online-order fees are as shown to you when you choose a plan and may change with notice. The online order fee is paid by the customer at checkout. Rackd charges you only for Rackd services and hardware.' },
    { heading: '6. Payments for your products', body: 'Payments for the products your shop sells are handled between you, your customers and your payment processor. Rackd does not process vape or tobacco product payments through its own card account.' },
    { heading: '7. Data', body: 'You own your business data. You grant Rackd permission to process it to provide the service. We protect sensitive information such as tax identifiers using encryption and limit who can see it.' },
    { heading: '8. Termination', body: 'You may stop using Rackd at any time. Rackd may suspend or end service for violations of these terms or the law.' },
    { heading: '9. Disclaimers and liability', body: 'The service is provided as is. To the extent permitted by law, Rackd is not liable for indirect or consequential damages, and its total liability is limited to the fees you paid in the prior twelve months.' },
  ],
};

export const MERCHANT_AGREEMENT: LegalDoc = {
  kind: 'merchant_agreement',
  version: '2026-10-draft-1',
  title: 'Rackd Platform and Merchant Agreement',
  sections: [
    { heading: '1. Parties and scope', body: 'This agreement is between Rackd and the business named in your application (the Merchant). It covers the Merchant’s use of the Rackd point of sale, online storefront and related services at every location listed in the application.' },
    { heading: '2. Representations', body: 'The Merchant represents that the information in the application is true and complete, that each listed owner is identified, and that each location holds a current Texas e-cigarette retailer permit and sales tax permit, plus any tobacco or TABC permit it lists.' },
    { heading: '3. Storefront and fulfilment', body: 'Online orders are reservations for in-store pickup. The Merchant is responsible for the products it lists, for accurate inventory and pricing, for checking identification at pickup, and for refusing any sale it is not legally permitted to make.' },
    { heading: '4. Online order fee', body: 'The Merchant’s storefront may show an online order fee that is paid by the customer. The fee type and amount are set in the Merchant’s plan configuration.' },
    { heading: '5. Hardware', body: 'Hardware ordered from Rackd is subject to the prices, shipping terms and return policy shown at checkout. Hardware is charged through Rackd’s own payment account.' },
    { heading: '6. Compliance cooperation', body: 'The Merchant will give Rackd reasonable proof of licensing on request, will keep permits current, and will cooperate with Rackd’s and its payment partners’ reviews. Rackd may decline or suspend a location that cannot show current permits.' },
    { heading: '7. Term', body: 'This agreement runs month to month and may be ended by either party with written notice.' },
  ],
};

export function agreementText(doc: LegalDoc): string {
  return `${doc.title}\nVersion ${doc.version}\n\n${doc.sections.map((s) => `${s.heading}\n${s.body}`).join('\n\n')}`;
}

// SMS: its own checkbox, never pre-checked, never required, informational only.
export const SMS_CONSENT_VERSION = 'sms-2026-10-1';
export const SMS_CONSENT_TEXT =
  'Rackd may text me informational messages about my Rackd account and application, such as status updates, requests for information and service notices. Message frequency varies. Message and data rates may apply. Reply STOP to unsubscribe at any time or HELP for help. Consent is not a condition of applying or buying. These messages are not marketing.';

export const COMPLIANCE_VERSION = 'ack-2026-10-1';
export const COMPLIANCE_TEXT =
  'I understand that my shop is responsible for verifying that every customer is 21 or older with valid government photo ID, and for complying with all federal, state and local laws that apply to the products it sells.';
