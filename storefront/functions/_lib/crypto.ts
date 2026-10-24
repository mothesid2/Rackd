// Application-level encryption for the business EIN (AES-256-GCM, key from env).
//
// The plaintext EIN exists only in memory inside the request that receives or decrypts it.
// It is never logged, never returned to a browser, and never written to the database; only
// { ciphertext, iv, last4 } is stored. The application id is bound as additional authenticated
// data, so a ciphertext copied onto another application row will not decrypt.

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface EncryptedEin {
  /** base64(ciphertext || 16-byte GCM tag) */
  ciphertext: string;
  /** base64(12-byte IV) */
  iv: string;
  last4: string;
}

export function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Returns the 9 digits of an EIN (accepts "12-3456789" or "123456789"), or null if invalid. */
export function normalizeEin(input: string): string | null {
  if (typeof input !== 'string') return null;
  const m = /^\s*(\d{2})-?(\d{7})\s*$/.exec(input);
  return m ? m[1] + m[2] : null;
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  let raw: Uint8Array<ArrayBuffer>;
  try {
    raw = b64decode(keyB64.trim());
  } catch {
    throw new Error('EIN_ENCRYPTION_KEY is not valid base64');
  }
  if (raw.length !== 32) throw new Error('EIN_ENCRYPTION_KEY must decode to exactly 32 bytes');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptEin(ein: string, keyB64: string, applicationId: string): Promise<EncryptedEin> {
  const digits = normalizeEin(ein);
  if (!digits) throw new Error('invalid_ein');
  const key = await importKey(keyB64);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(applicationId) }, key, enc.encode(digits)),
  );
  return { ciphertext: b64encode(ct), iv: b64encode(iv), last4: digits.slice(-4) };
}

/** Server-side, platform-admin-only paths. Never call this to build a response for a browser. */
export async function decryptEin(e: Pick<EncryptedEin, 'ciphertext' | 'iv'>, keyB64: string, applicationId: string): Promise<string> {
  const key = await importKey(keyB64);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(e.iv), additionalData: enc.encode(applicationId) },
    key,
    b64decode(e.ciphertext),
  );
  const digits = dec.decode(pt);
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}
