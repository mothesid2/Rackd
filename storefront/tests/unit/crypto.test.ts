import { describe, expect, it } from 'vitest';
import { b64encode, decryptEin, encryptEin, normalizeEin } from '../../functions/_lib/crypto';

const key = b64encode(crypto.getRandomValues(new Uint8Array(32)));
const otherKey = b64encode(crypto.getRandomValues(new Uint8Array(32)));
const APP = '5b7e2f0a-1111-4222-8333-444455556666';

describe('normalizeEin', () => {
  it('accepts dashed and plain 9-digit EINs', () => {
    expect(normalizeEin('12-3456789')).toBe('123456789');
    expect(normalizeEin(' 123456789 ')).toBe('123456789');
  });
  it.each(['', '12-345678', '1234567890', 'ab-cdefghi', '123-45-6789', '12 3456789'])('rejects %j', (v) => {
    expect(normalizeEin(v)).toBeNull();
  });
});

describe('encryptEin / decryptEin', () => {
  it('round-trips and returns the dashed form', async () => {
    const e = await encryptEin('12-3456789', key, APP);
    expect(await decryptEin(e, key, APP)).toBe('12-3456789');
  });

  it('stores only ciphertext, iv and last4, never the plaintext', async () => {
    const e = await encryptEin('12-3456789', key, APP);
    expect(e.last4).toBe('6789');
    const blob = JSON.stringify(e);
    expect(blob).not.toContain('123456789');
    expect(blob).not.toContain('12-3456789');
    // the DB constraint ein_not_plaintext rejects values of this shape
    expect(e.ciphertext).not.toMatch(/^\d{2}-?\d{7}$/);
    expect(e.ciphertext.length).toBeGreaterThan(20);
  });

  it('uses a fresh IV every time', async () => {
    const a = await encryptEin('12-3456789', key, APP);
    const b = await encryptEin('12-3456789', key, APP);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('fails with the wrong key', async () => {
    const e = await encryptEin('12-3456789', key, APP);
    await expect(decryptEin(e, otherKey, APP)).rejects.toBeDefined();
  });

  it('is bound to the application id (ciphertext copied to another row will not decrypt)', async () => {
    const e = await encryptEin('12-3456789', key, APP);
    await expect(decryptEin(e, key, 'another-application-id')).rejects.toBeDefined();
  });

  it('detects tampering', async () => {
    const e = await encryptEin('12-3456789', key, APP);
    const raw = atob(e.ciphertext);
    const flipped = String.fromCharCode(raw.charCodeAt(0) ^ 1) + raw.slice(1);
    await expect(decryptEin({ ...e, ciphertext: btoa(flipped) }, key, APP)).rejects.toBeDefined();
  });

  it('rejects an invalid EIN before touching the key', async () => {
    await expect(encryptEin('not-an-ein', key, APP)).rejects.toThrow('invalid_ein');
  });

  it('rejects keys that are not 32 bytes of base64', async () => {
    await expect(encryptEin('12-3456789', b64encode(new Uint8Array(16)), APP)).rejects.toThrow('32 bytes');
    await expect(encryptEin('12-3456789', '***not base64***', APP)).rejects.toThrow('base64');
  });
});
