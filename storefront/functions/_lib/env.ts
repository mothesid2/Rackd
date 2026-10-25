// Shared environment typing and feature flags for Pages Functions.
// Secrets are set in the Cloudflare Pages dashboard; see .env.example for the full list.

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  EIN_ENCRYPTION_KEY: string;
  TURNSTILE_SECRET_KEY: string;
  IP_HASH_SALT?: string;
  RESEND_API_KEY?: string;
  RESEND_FROM?: string;
  ADMIN_NOTIFY_EMAIL?: string;
  APP_BASE_URL?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_LIVE_ENABLED?: string;
  PAYMENT_PROCESSOR_CONNECTED?: string;
  SMS_ENABLED?: string;
  DOC_SCAN_HOOK_URL?: string;
  /** Derives the emailed order-link token. Falls back to EIN_ENCRYPTION_KEY when unset. */
  ORDER_LINK_SECRET?: string;
  /** DEV ONLY: returns the email verification code in the create/send-code response. Ignored when STRIPE_LIVE_ENABLED=true. */
  DEV_RETURN_EMAIL_CODE?: string;
}

export interface Flags {
  /** false = Stripe TEST mode only. Confirm Stripe's restricted-business policy before enabling. */
  stripeLive: boolean;
  /** false = the owner KYC step is a placeholder; no DOB/SSN is ever collected. */
  processorConnected: boolean;
  /** false = Twilio is never called. */
  smsEnabled: boolean;
}

/** Only the exact string "true" (any case, trimmed) enables a flag. Anything else, including unset, is off. */
function on(v: string | undefined): boolean {
  return typeof v === 'string' && v.trim().toLowerCase() === 'true';
}

export function flags(env: Partial<Env>): Flags {
  return {
    stripeLive: on(env.STRIPE_LIVE_ENABLED),
    processorConnected: on(env.PAYMENT_PROCESSOR_CONNECTED),
    smsEnabled: on(env.SMS_ENABLED),
  };
}

export class ConfigError extends Error {
  constructor(public readonly missing: string[]) {
    super(`Missing server configuration: ${missing.join(', ')}`);
    this.name = 'ConfigError';
  }
}

/** Throws a ConfigError naming the missing variables (never their values). */
export function requireEnv<K extends keyof Env>(env: Partial<Env>, keys: K[]): asserts env is Partial<Env> & Record<K, string> {
  const missing = keys.filter((k) => {
    const v = env[k];
    return typeof v !== 'string' || v.trim() === '';
  });
  if (missing.length) throw new ConfigError(missing as string[]);
}

export function appBaseUrl(env: Partial<Env>): string {
  return (env.APP_BASE_URL?.trim() || 'https://r4ckd.net').replace(/\/+$/, '');
}

/** True only for local/staging smoke tests; can never be on once live payments are enabled. */
export function devReturnsEmailCode(env: Partial<Env>): boolean {
  return on(env.DEV_RETURN_EMAIL_CODE) && !flags(env).stripeLive;
}

/** Secret that derives emailed order-link tokens. Throws (naming the variable) rather than using an empty key. */
export function orderLinkSecret(env: Partial<Env>): string {
  const s = env.ORDER_LINK_SECRET?.trim() || env.EIN_ENCRYPTION_KEY?.trim();
  if (!s) throw new ConfigError(['ORDER_LINK_SECRET']);
  return s;
}
