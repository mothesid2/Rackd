// Log hygiene: nothing sensitive reaches console output. Use safeLog instead of console.* in functions.

const SENSITIVE_WORDS = new Set([
  'ein', 'ssn', 'password', 'passwd', 'pwd', 'token', 'secret', 'authorization', 'cookie', 'card',
  'cvc', 'cvv', 'routing', 'ciphertext', 'iv', 'apikey', 'dob', 'birth',
]);
const SENSITIVE_SUBSTRINGS = ['apikey', 'api_key', 'servicerole', 'service_role', 'accountnumber', 'account_number'];

// 12-3456789 / 123456789 (EIN-or-SSN shaped), 123-45-6789, and 13-19 digit card-like runs
const VALUE_PATTERNS = [/\b\d{3}-\d{2}-\d{4}\b/g, /\b\d{2}-\d{7}\b/g, /\b\d{9}\b/g, /\b(?:\d[ -]?){13,19}\b/g];

function keyIsSensitive(key: string): boolean {
  const lower = key.toLowerCase();
  if (SENSITIVE_SUBSTRINGS.some((s) => lower.includes(s))) return true;
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return words.some((w) => SENSITIVE_WORDS.has(w));
}

export function redactString(s: string): string {
  return VALUE_PATTERNS.reduce((acc, re) => acc.replace(re, '[redacted]'), s);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[truncated]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = keyIsSensitive(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function safeLog(level: 'info' | 'warn' | 'error', message: string, context?: unknown): void {
  const line = context === undefined ? [redactString(message)] : [redactString(message), JSON.stringify(redact(context))];
  console[level](...line);
}
