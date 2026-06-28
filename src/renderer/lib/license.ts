/**
 * Renderer-side license helpers. Talk to main ONLY through `window.api`.
 *
 * NOTE: targets the (forthcoming) Vite/React renderer. `useLicense()` imports
 * React, which isn't installed for the current vanilla-HTML renderer — this is
 * scaffolding for when the React renderer lands. The non-hook helpers
 * (getLicenseStatus / isFeatureEnabled / assertWritable) work anywhere.
 */
import { useEffect, useState } from 'react';

export type BannerLevel = 'none' | 'warning' | 'error';

export interface LicenseState {
  mode: 'full' | 'read_only';
  readOnly: boolean;
  reason: string;
  tier: string | null;
  features: string[];
  banner: { level: BannerLevel; message: string };
  expires_at: string | null;
  last_checked_at: string | null;
  cache_age_hours: number | null;
}

interface LicenseApi {
  licenseStatus(): Promise<{ success: boolean; status?: LicenseState; error?: string }>;
  licenseRefresh(): Promise<{ success: boolean; status?: LicenseState; error?: string }>;
  licenseAssertWritable(action: string): Promise<{ ok: true }>;
  on(channel: string, cb: (...args: unknown[]) => void): void;
  off(channel: string, cb: (...args: unknown[]) => void): void;
}
const api = (window as unknown as { api: LicenseApi }).api;

// Module-level cache so isFeatureEnabled() is synchronous after the first load.
let cached: LicenseState | null = null;

export async function getLicenseStatus(): Promise<LicenseState | null> {
  const r = await api.licenseStatus();
  cached = r.status ?? null;
  return cached;
}

export async function refreshLicense(): Promise<LicenseState | null> {
  const r = await api.licenseRefresh();
  cached = r.status ?? null;
  return cached;
}

/** Check a feature flag against the cached license features array. */
export function isFeatureEnabled(feature: string): boolean {
  return cached?.features?.includes(feature) ?? false;
}

/**
 * Call before a write action. Returns true if allowed; if blocked, surfaces the
 * lockdown banner (via a `rackd:lockdown` window event) and returns false —
 * never throws into the user's flow.
 */
export async function assertWritable(action: string): Promise<boolean> {
  try {
    await api.licenseAssertWritable(action);
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    window.dispatchEvent(new CustomEvent('rackd:lockdown', { detail: { action, message } }));
    return false;
  }
}

/** React hook: current license state, refreshed on mount and on sync:status. */
export function useLicense(): LicenseState | null {
  const [state, setState] = useState<LicenseState | null>(cached);
  useEffect(() => {
    let active = true;
    void getLicenseStatus().then((s) => active && setState(s));
    const onStatus = () => void getLicenseStatus().then((s) => active && setState(s));
    api.on('sync:status', onStatus);
    return () => {
      active = false;
      api.off('sync:status', onStatus);
    };
  }, []);
  return state;
}
