import { afterEach, describe, expect, it, vi } from 'vitest';
import { appBaseUrl, ConfigError, flags, requireEnv } from '../../functions/_lib/env';
import { redact, redactString, safeLog } from '../../functions/_lib/redact';
import { clientIp, hashIp, looksLikeToken, randomToken, sha256Hex, timingSafeEqual } from '../../functions/_lib/token';

describe('flags', () => {
  it('default to false when unset', () => {
    expect(flags({})).toEqual({ stripeLive: false, processorConnected: false, smsEnabled: false });
  });
  it('only the exact string "true" enables a flag', () => {
    for (const v of ['1', 'yes', 'on', 'TRUE1', 'false', '', ' ', 'truee']) {
      expect(flags({ STRIPE_LIVE_ENABLED: v, SMS_ENABLED: v, PAYMENT_PROCESSOR_CONNECTED: v })).toEqual({
        stripeLive: false, processorConnected: false, smsEnabled: false,
      });
    }
    expect(flags({ STRIPE_LIVE_ENABLED: ' True ' }).stripeLive).toBe(true);
    expect(flags({ SMS_ENABLED: 'true' }).smsEnabled).toBe(true);
    expect(flags({ PAYMENT_PROCESSOR_CONNECTED: 'TRUE' }).processorConnected).toBe(true);
  });
  it('flags are independent', () => {
    expect(flags({ SMS_ENABLED: 'true' })).toEqual({ stripeLive: false, processorConnected: false, smsEnabled: true });
  });
});

describe('requireEnv / appBaseUrl', () => {
  it('names missing variables but never values', () => {
    try {
      requireEnv({ SUPABASE_URL: 'https://x', EIN_ENCRYPTION_KEY: '  ' }, ['SUPABASE_URL', 'EIN_ENCRYPTION_KEY', 'TURNSTILE_SECRET_KEY']);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).missing).toEqual(['EIN_ENCRYPTION_KEY', 'TURNSTILE_SECRET_KEY']);
    }
  });
  it('defaults and trims the base URL', () => {
    expect(appBaseUrl({})).toBe('https://r4ckd.net');
    expect(appBaseUrl({ APP_BASE_URL: 'https://staging.r4ckd.net//' })).toBe('https://staging.r4ckd.net');
  });
});

describe('tokens', () => {
  it('randomToken is 64 hex chars and unique', () => {
    const a = randomToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(looksLikeToken(a)).toBe(true);
    expect(randomToken()).not.toBe(a);
  });
  it('looksLikeToken rejects junk', () => {
    for (const v of ['', 'abc', 'g'.repeat(64), 'A'.repeat(64), null, 5, undefined]) expect(looksLikeToken(v)).toBe(false);
  });
  it('sha256Hex matches the known vector', async () => {
    expect(await sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
  it('timingSafeEqual', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
  it('hashIp is salted, stable, and not the IP', async () => {
    const a = await hashIp('203.0.113.9', 'salt1');
    expect(a).toBe(await hashIp('203.0.113.9', 'salt1'));
    expect(a).not.toBe(await hashIp('203.0.113.9', 'salt2'));
    expect(a).not.toContain('203');
    expect(a).toHaveLength(32);
  });
  it('clientIp prefers CF-Connecting-IP', () => {
    const h = (o: Record<string, string>) => new Request('https://r4ckd.net', { headers: o });
    expect(clientIp(h({ 'CF-Connecting-IP': '1.2.3.4', 'X-Forwarded-For': '9.9.9.9' }))).toBe('1.2.3.4');
    expect(clientIp(h({ 'X-Forwarded-For': '9.9.9.9, 8.8.8.8' }))).toBe('9.9.9.9');
    expect(clientIp(h({}))).toBe('unknown');
  });
});

describe('redact', () => {
  it('redacts sensitive keys at any depth, including camelCase', () => {
    const out = redact({
      ein: '12-3456789', ein_ciphertext: 'abc', einLast4: '6789', resumeToken: 'x', apiKey: 'k',
      nested: { password: 'p', Authorization: 'Bearer z', safe: 'ok', list: [{ ssn: '1' }] },
      full_name: 'Alice',
    }) as Record<string, any>;
    expect(out.ein).toBe('[redacted]');
    expect(out.ein_ciphertext).toBe('[redacted]');
    expect(out.einLast4).toBe('[redacted]');
    expect(out.resumeToken).toBe('[redacted]');
    expect(out.apiKey).toBe('[redacted]');
    expect(out.nested.password).toBe('[redacted]');
    expect(out.nested.Authorization).toBe('[redacted]');
    expect(out.nested.list[0].ssn).toBe('[redacted]');
    expect(out.nested.safe).toBe('ok');
    expect(out.full_name).toBe('Alice');
  });
  it('does not over-redact innocent words that merely contain "ein"', () => {
    const out = redact({ protein: 'whey', being: 'x', reinvite: 'y' }) as Record<string, string>;
    expect(out).toEqual({ protein: 'whey', being: 'x', reinvite: 'y' });
  });
  it('redacts EIN, SSN and card-shaped values inside strings', () => {
    expect(redactString('ein 12-3456789 ok')).toBe('ein [redacted] ok');
    expect(redactString('ssn 123-45-6789')).toBe('ssn [redacted]');
    expect(redactString('raw 123456789')).toBe('raw [redacted]');
    expect(redactString('card 4242 4242 4242 4242')).toBe('card [redacted]');
    expect(redactString('call 5125550100')).toBe('call 5125550100');
  });
  it('redacts values inside Error messages', () => {
    expect(redact(new Error('bad ein 12-3456789'))).toEqual({ name: 'Error', message: 'bad ein [redacted]' });
  });
});

describe('safeLog', () => {
  afterEach(() => vi.restoreAllMocks());
  it('never prints sensitive context', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    safeLog('error', 'failed for 12-3456789', { ein: '12-3456789', note: 'x', token: 'abc' });
    const printed = spy.mock.calls.flat().join(' ');
    expect(printed).not.toContain('3456789');
    expect(printed).not.toContain('abc');
    expect(printed).toContain('"note":"x"');
  });
});
