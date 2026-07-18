import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from '../supabase/env';

/**
 * Anthropic client for Rackd's AI features. Reads ANTHROPIC_API_KEY from the
 * environment (via the same .env loader used for Supabase). Returns null when no
 * key is configured, so the app runs perfectly well without AI — every caller
 * must handle the null case.
 *
 * SECURITY: the key is only read in the MAIN process and never exposed to the
 * renderer. Do NOT ship a real key inside client builds (.env is not packaged) —
 * for production, proxy AI calls through your own backend rather than embedding
 * an org-scoped key on each register.
 */
let cached: Anthropic | null | undefined;

export function getAnthropic(): Anthropic | null {
  if (cached !== undefined) return cached;
  loadEnv();
  const apiKey = process.env.ANTHROPIC_API_KEY;
  cached = apiKey ? new Anthropic({ apiKey }) : null;
  return cached;
}

export function isAIConfigured(): boolean {
  return getAnthropic() !== null;
}
