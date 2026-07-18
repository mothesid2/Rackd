// Public runtime config. Anon key is RLS-protected; Stripe key is publishable.
export const SUPABASE_URL =
  process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://zougcsomgqnfumqkwuoj.supabase.co';
export const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';
export const STRIPE_PUBLISHABLE_KEY = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY || '';
export const FUNCTIONS_URL = `${SUPABASE_URL.replace(/\/$/, '')}/functions/v1`;

// Online order fee (item 8): 5% on top of item price, itemized at checkout. This
// mirrors the server (reserve_online_order) — kept here only for display.
export const ONLINE_FEE_RATE = 0.05;

export const fmt = (n: number) =>
  '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
