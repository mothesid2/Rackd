import Anthropic from '@anthropic-ai/sdk';
import { loadEnv } from '../supabase/env';


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
