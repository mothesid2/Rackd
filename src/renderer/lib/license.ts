
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


export function isFeatureEnabled(feature: string): boolean {
  return cached?.features?.includes(feature) ?? false;
}


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
