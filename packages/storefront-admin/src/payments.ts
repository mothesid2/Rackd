// Payment providers for reservations. Pay-at-pickup is the only live one: no card is ever charged for tobacco or vape
// products by this module. Prepay is a visible-but-disabled stub until a compliant processor is connected.

export interface PaymentProvider {
  id: 'pay_at_pickup' | 'prepay_card';
  label: string;
  /** True only when the provider can really take money. */
  available(): boolean;
  /** Why it is unavailable (shown in a tooltip). */
  unavailableReason(): string | null;
  /** Called when a reservation is placed. Pay-at-pickup records nothing; prepay would authorise a charge. */
  prepare(reservationId: string): Promise<void>;
}

export class NotConfiguredError extends Error {
  constructor() { super('not_configured'); this.name = 'NotConfiguredError'; }
}

export const PayAtPickupProvider: PaymentProvider = {
  id: 'pay_at_pickup', label: 'Pay at pickup',
  available: () => true, unavailableReason: () => null,
  prepare: async () => undefined,
};

export function createPrepayProvider(processorConnected = false): PaymentProvider {
  return {
    id: 'prepay_card', label: 'Prepay by card',
    available: () => processorConnected,
    unavailableReason: () => (processorConnected ? null : 'Card prepay is not available yet. It turns on once a payment processor is connected.'),
    async prepare() { throw new NotConfiguredError(); },     // deliberately inert: no code path charges a card
  };
}

export const PrepayProvider = createPrepayProvider(false);
