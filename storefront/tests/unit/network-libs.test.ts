import { afterEach, describe, expect, it, vi } from 'vitest';
import { escapeHtml, resumeLinkEmail, sendEmail, verificationCodeEmail } from '../../functions/_lib/email';
import { guardPublic } from '../../functions/_lib/guard';
import { errorResponse, HONEYPOT_FIELD, honeypotTripped, HttpError, json, readJson } from '../../functions/_lib/http';
import { checkRateLimit } from '../../functions/_lib/rateLimit';
import { rpc, SupabaseError } from '../../functions/_lib/supabase';
import { ConfigError } from '../../functions/_lib/env';
import { verifyTurnstile } from '../../functions/_lib/turnstile';

const env = {
  SUPABASE_URL: 'https://proj.supabase.co/',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
  EIN_ENCRYPTION_KEY: 'k',
  RESEND_API_KEY: 're_test',
};
const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.restoreAllMocks());

describe('rpc', () => {
  it('posts to the PostgREST rpc endpoint with the service key', async () => {
    const f = vi.fn(async () => ok(true));
    expect(await rpc(env, 'rate_limit_hit', { p_bucket: 'x' }, f as any)).toBe(true);
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe('https://proj.supabase.co/rest/v1/rpc/rate_limit_hit');
    expect(init.headers.apikey).toBe('service-key');
    expect(JSON.parse(init.body)).toEqual({ p_bucket: 'x' });
  });
  it('surfaces SQLSTATE from PostgREST errors', async () => {
    const f = vi.fn(async () => ok({ code: '28000', message: 'invalid_token' }, 400));
    await expect(rpc(env, 'app_get', {}, f as any)).rejects.toMatchObject({ sqlstate: '28000', dbMessage: 'invalid_token' });
  });
  it('refuses odd function names and missing config', async () => {
    await expect(rpc(env, 'x; drop table y', {}, vi.fn() as any)).rejects.toThrow('invalid rpc name');
    await expect(rpc({}, 'app_get')).rejects.toBeInstanceOf(ConfigError);
  });
});

describe('verifyTurnstile', () => {
  it('passes on success and sends secret, token and ip', async () => {
    const f = vi.fn(async () => ok({ success: true }));
    const r = await verifyTurnstile({ token: 'tok', secret: 'sec', ip: '1.2.3.4', fetchImpl: f as any });
    expect(r.ok).toBe(true);
    const form = (f.mock.calls[0] as any)[1].body as FormData;
    expect(form.get('secret')).toBe('sec');
    expect(form.get('response')).toBe('tok');
    expect(form.get('remoteip')).toBe('1.2.3.4');
  });
  it('fails on rejection with error codes', async () => {
    const f = vi.fn(async () => ok({ success: false, 'error-codes': ['invalid-input-response'] }));
    expect(await verifyTurnstile({ token: 't', secret: 's', fetchImpl: f as any })).toEqual({ ok: false, errors: ['invalid-input-response'] });
  });
  it('fails without calling Cloudflare when the token or secret is missing or oversized', async () => {
    const f = vi.fn();
    expect((await verifyTurnstile({ token: undefined, secret: 's', fetchImpl: f as any })).ok).toBe(false);
    expect((await verifyTurnstile({ token: '', secret: 's', fetchImpl: f as any })).ok).toBe(false);
    expect((await verifyTurnstile({ token: 'x'.repeat(3000), secret: 's', fetchImpl: f as any })).ok).toBe(false);
    expect((await verifyTurnstile({ token: 't', secret: undefined, fetchImpl: f as any })).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it('fails closed on network error and non-200', async () => {
    expect((await verifyTurnstile({ token: 't', secret: 's', fetchImpl: (async () => { throw new Error('down'); }) as any })).errors).toEqual(['network-error']);
    expect((await verifyTurnstile({ token: 't', secret: 's', fetchImpl: (async () => ok({}, 500)) as any })).ok).toBe(false);
  });
  it('rejects an action mismatch', async () => {
    const f = vi.fn(async () => ok({ success: true, action: 'login' }));
    expect((await verifyTurnstile({ token: 't', secret: 's', action: 'submit', fetchImpl: f as any })).errors).toEqual(['action-mismatch']);
  });
});

describe('checkRateLimit', () => {
  it('returns the database verdict', async () => {
    expect(await checkRateLimit(env, 'b', { windowSeconds: 60, max: 2 }, (async () => ok(true)) as any)).toBe(true);
    expect(await checkRateLimit(env, 'b', { windowSeconds: 60, max: 2 }, (async () => ok(false)) as any)).toBe(false);
  });
  it('fails closed when the database errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await checkRateLimit(env, 'b', { windowSeconds: 60, max: 2 }, (async () => ok({ code: 'XX', message: 'boom' }, 500)) as any)).toBe(false);
    expect(await checkRateLimit({}, 'b', { windowSeconds: 60, max: 2 })).toBe(false);
  });
});

describe('sendEmail', () => {
  it('skips (does not throw) without an API key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const f = vi.fn();
    expect(await sendEmail({}, { to: 'a@b.co', subject: 's', html: '<p>x</p>' }, f as any)).toEqual({ sent: false, reason: 'no_api_key' });
    expect(f).not.toHaveBeenCalled();
  });
  it('posts to Resend with bearer auth, default sender and a text fallback', async () => {
    const f = vi.fn(async () => ok({ id: 'em_1' }));
    const r = await sendEmail(env, { to: 'a@b.co', subject: 'Hi', html: '<p>Hello <b>there</b></p>' }, f as any);
    expect(r).toEqual({ sent: true, id: 'em_1' });
    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.headers.Authorization).toBe('Bearer re_test');
    const body = JSON.parse(init.body);
    expect(body.from).toBe('Rackd <onboarding@resend.dev>');
    expect(body.text).toBe('Hello there');
  });
  it('rejects bad recipients and header injection', async () => {
    const f = vi.fn();
    for (const msg of [
      { to: 'not-an-email', subject: 's', html: 'x' },
      { to: 'a@b.co\nBcc: x@y.co', subject: 's', html: 'x' },
      { to: 'a@b.co', subject: 'hi\r\nBcc: x@y.co', html: 'x' },
      { to: 'a@b.co', subject: '  ', html: 'x' },
    ]) expect((await sendEmail(env, msg, f as any)).reason).toBe('invalid_message');
    expect(f).not.toHaveBeenCalled();
  });
  it('reports provider and network failures without logging the message', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const msg = { to: 'secret-person@b.co', subject: 's', html: '<p>code 123456</p>' };
    expect((await sendEmail(env, msg, (async () => ok({}, 422)) as any)).reason).toBe('provider_error');
    expect((await sendEmail(env, msg, (async () => { throw new Error('x'); }) as any)).reason).toBe('network_error');
    const printed = spy.mock.calls.flat().join(' ');
    expect(printed).not.toContain('secret-person');
    expect(printed).not.toContain('123456');
  });
  it('escapes HTML and builds links from APP_BASE_URL', () => {
    expect(escapeHtml(`<script>"&'`)).toBe('&lt;script&gt;&quot;&amp;&#39;');
    const t = resumeLinkEmail({ APP_BASE_URL: 'https://r4ckd.net' }, '<b>Eve</b> Smith', 'a'.repeat(64));
    expect(t.html).toContain('https://r4ckd.net/get-started/resume?token=' + 'a'.repeat(64));
    expect(t.html).not.toContain('<b>Eve</b>');
    expect(verificationCodeEmail('042913').html).toContain('042913');
  });
});

describe('http helpers', () => {
  const req = (body: string, headers: Record<string, string> = {}) => new Request('https://r4ckd.net/api/x', { method: 'POST', body, headers });
  it('readJson parses objects and rejects arrays, junk and oversized bodies', async () => {
    expect(await readJson(req('{"a":1}'))).toEqual({ a: 1 });
    await expect(readJson(req('[1]'))).rejects.toMatchObject({ status: 400 });
    await expect(readJson(req('nope'))).rejects.toMatchObject({ status: 400, code: 'invalid_json' });
    await expect(readJson(req('{"a":"' + 'x'.repeat(2000) + '"}'), 100)).rejects.toMatchObject({ status: 413 });
    await expect(readJson(req('{}', { 'Content-Length': '999999' }), 100)).rejects.toMatchObject({ status: 413 });
  });
  it('detects a filled honeypot', () => {
    expect(honeypotTripped({})).toBe(false);
    expect(honeypotTripped({ [HONEYPOT_FIELD]: '' })).toBe(false);
    expect(honeypotTripped({ [HONEYPOT_FIELD]: '  ' })).toBe(false);
    expect(honeypotTripped({ [HONEYPOT_FIELD]: 'x' })).toBe(true);
    expect(honeypotTripped({ [HONEYPOT_FIELD]: true })).toBe(true);
  });
  it('errorResponse maps known failures and hides internals', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = async (e: unknown) => { const r = errorResponse(e); return [r.status, await r.json()]; };
    expect(await body(new HttpError(429, 'rate_limited'))).toEqual([429, { error: 'rate_limited' }]);
    expect(await body(new SupabaseError(400, '28000', 'invalid_token'))).toEqual([401, { error: 'invalid_token' }]);
    expect(await body(new SupabaseError(403, '42501', 'permission denied for table x'))).toEqual([403, { error: 'forbidden' }]);
    expect(await body(new SupabaseError(400, 'P0001', 'email_invalid'))).toEqual([400, { error: 'email_invalid' }]);
    expect(await body(new SupabaseError(400, 'P0001', 'invalid_transition: submitted -> approved'))).toEqual([400, { error: 'invalid_transition' }]);
    expect(await body(new SupabaseError(400, 'P0001', 'Some raw sentence with SQL select * from x'))).toEqual([500, { error: 'internal_error' }]);
    expect(await body(new SupabaseError(500, 'XX000', 'secret detail'))).toEqual([500, { error: 'internal_error' }]);
    expect(await body(new ConfigError(['EIN_ENCRYPTION_KEY']))).toEqual([503, { error: 'server_not_configured' }]);
    expect(await body(new Error('kaboom 12-3456789'))).toEqual([500, { error: 'internal_error' }]);
  });
  it('json sets no-store', () => {
    expect(json({ a: 1 }).headers.get('Cache-Control')).toBe('no-store');
  });
});

describe('guardPublic', () => {
  const post = (body: object) => new Request('https://r4ckd.net/api/x', { method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.7' }, body: JSON.stringify(body) });
  const opts = (fetchImpl: any, turnstile = true) => ({ bucket: 'create', limit: { windowSeconds: 60, max: 3 }, turnstile: turnstile ? { action: 'create' } : undefined, fetchImpl });
  // routes the two upstream calls by URL
  const upstream = (rate: boolean, ts: boolean) => vi.fn(async (url: string) =>
    url.includes('rate_limit_hit') ? ok(rate) : ok({ success: ts }));

  it('passes when honeypot is empty, rate limit allows and Turnstile succeeds', async () => {
    const f = upstream(true, true);
    const r = await guardPublic(post({}), env, { turnstileToken: 't', [HONEYPOT_FIELD]: '' }, opts(f));
    expect(r.ip).toBe('203.0.113.7');
    expect(r.ipHash).toHaveLength(32);
    const rlBody = JSON.parse((f.mock.calls.find((c) => String(c[0]).includes('rate_limit')) as any)[1].body);
    expect(rlBody.p_bucket).toBe('create:' + r.ipHash);
    expect(rlBody.p_bucket).not.toContain('203.0.113.7');
  });
  it('blocks a tripped honeypot before any network call', async () => {
    const f = upstream(true, true);
    await expect(guardPublic(post({}), env, { [HONEYPOT_FIELD]: 'bot' }, opts(f))).rejects.toMatchObject({ status: 400 });
    expect(f).not.toHaveBeenCalled();
  });
  it('returns 429 when rate limited, without spending a Turnstile verification', async () => {
    const f = upstream(false, true);
    await expect(guardPublic(post({}), env, { turnstileToken: 't' }, opts(f))).rejects.toMatchObject({ status: 429 });
    expect(f.mock.calls.some((c) => String(c[0]).includes('turnstile'))).toBe(false);
  });
  it('returns 403 when Turnstile fails or the token is absent', async () => {
    await expect(guardPublic(post({}), env, { turnstileToken: 't' }, opts(upstream(true, false)))).rejects.toMatchObject({ status: 403, code: 'bot_check_failed' });
    await expect(guardPublic(post({}), env, {}, opts(upstream(true, true)))).rejects.toMatchObject({ status: 403 });
  });
  it('skips Turnstile when not required (autosave)', async () => {
    await expect(guardPublic(post({}), env, {}, opts(upstream(true, false), false))).resolves.toBeDefined();
  });
  it('denies when the limiter is unreachable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const f = vi.fn(async () => { throw new Error('down'); });
    await expect(guardPublic(post({}), env, { turnstileToken: 't' }, opts(f))).rejects.toMatchObject({ status: 429 });
  });
});
