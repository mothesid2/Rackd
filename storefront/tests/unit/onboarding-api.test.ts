import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { b64encode, decryptEin } from '../../functions/_lib/crypto';
import { HONEYPOT_FIELD } from '../../functions/_lib/http';
import { sniffMime } from '../../functions/_lib/files';
import { onRequestPost as create } from '../../functions/api/onboarding/create';
import { onRequestPost as save } from '../../functions/api/onboarding/save';
import { onRequestPost as agreements } from '../../functions/api/onboarding/agreements';
import { onRequestPost as registerDocument } from '../../functions/api/onboarding/register-document';
import { onRequestPost as uploadUrl } from '../../functions/api/onboarding/upload-url';
import { onRequestPost as submit } from '../../functions/api/onboarding/submit';
import { onRequestPost as getDraft } from '../../functions/api/onboarding/get';
import { agreementText, MERCHANT_AGREEMENT, SMS_CONSENT_VERSION, TERMS_OF_SERVICE } from '../../lib/onboarding/legal';
import { sha256Hex } from '../../functions/_lib/token';

const KEY = b64encode(crypto.getRandomValues(new Uint8Array(32)));
const APP_ID = '5b7e2f0a-1111-4222-8333-444455556666';
const TOKEN = 'ab'.repeat(32);
const baseEnv = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  TURNSTILE_SECRET_KEY: 'ts-secret',
  EIN_ENCRYPTION_KEY: KEY,
  RESEND_API_KEY: 're_x',
};

type Rpc = Record<string, (args: any) => unknown>;
interface Upstream {
  rpcs: Rpc;
  rpcCalls: { fn: string; args: any }[];
  emails: any[];
  deleted: string[];
  object: { size: number; head: number[] } | null;
  turnstileOk: boolean;
  rateOk: boolean;
}
let up: Upstream;

function installFetch() {
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const ok = (b: unknown, s = 200, h: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: s, headers: h });
    if (url.includes('/rest/v1/rpc/')) {
      const fn = url.split('/rpc/')[1];
      const args = JSON.parse(init.body);
      up.rpcCalls.push({ fn, args });
      if (fn === 'rate_limit_hit') return ok(up.rateOk);
      if (!up.rpcs[fn]) return ok({ code: 'P0001', message: 'unexpected_rpc_' + fn }, 400);
      try { return ok(up.rpcs[fn](args)); } catch (e: any) { return ok({ code: e.code ?? 'P0001', message: e.message }, 400); }
    }
    if (url.includes('turnstile')) return ok({ success: up.turnstileOk });
    if (url.includes('resend.com')) { up.emails.push(JSON.parse(init.body)); return ok({ id: 'em' }); }
    if (url.includes('/storage/v1/object/upload/sign/')) return ok({ url: '/object/upload/sign/onboarding-docs/x?token=signed-token' });
    if (url.includes('/storage/v1/object/') && init?.method === 'DELETE') { up.deleted.push(url); return ok({}); }
    if (url.includes('/storage/v1/object/')) {
      if (!up.object) return ok({ message: 'not found' }, 404);
      return new Response(new Uint8Array(up.object.head), { status: 206, headers: { 'Content-Range': `bytes 0-15/${up.object.size}` } });
    }
    if (url.includes('/rest/v1/onboarding_documents')) return new Response(null, { status: 204 });
    throw new Error('unexpected fetch ' + url);
  }));
}

const req = (body: object, headers: Record<string, string> = {}) =>
  new Request('https://r4ckd.net/api/onboarding/x', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '203.0.113.5', 'User-Agent': 'vitest-agent', ...headers },
  });
const call = async (h: (c: any) => Promise<Response>, body: object, env: object = baseEnv, headers?: Record<string, string>) => {
  const res = await h({ request: req(body, headers), env });
  return { status: res.status, body: await res.json() as any };
};
const rpcsCalled = () => up.rpcCalls.map((c) => c.fn).filter((f) => f !== 'rate_limit_hit');

beforeEach(() => {
  up = { rpcs: {}, rpcCalls: [], emails: [], deleted: [], object: null, turnstileOk: true, rateOk: true };
  installFetch();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('request hygiene', () => {
  it('rejects non-JSON content types', async () => {
    const res = await create({ request: new Request('https://r4ckd.net/x', { method: 'POST', body: 'a=b', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }), env: baseEnv as any });
    expect(res.status).toBe(415);
  });
  it('rejects malformed tokens before touching the database', async () => {
    for (const t of [undefined, 'short', 'Z'.repeat(64), 123]) {
      const r = await call(getDraft, { token: t });
      expect(r.status).toBe(401);
    }
    expect(up.rpcCalls).toHaveLength(0);
  });
});

describe('create', () => {
  beforeEach(() => {
    up.rpcs = {
      app_create: () => [{ application_id: APP_ID, resume_token: TOKEN }],
      app_email_code_issue: () => '042913',
      app_magic_issue: () => [{ application_id: APP_ID, full_name: 'Alice A', email: 'alice@test.dev', magic_token: 'cd'.repeat(32) }],
    };
  });
  const good = { full_name: 'Alice A', email: 'Alice@Test.dev', phone: '5125550100', role: 'owner', turnstileToken: 'tok' };

  it('creates the draft, emails the code and the resume link, and returns only the resume token', async () => {
    const r = await call(create, good);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ resume_token: TOKEN, email_sent: true });
    expect(up.rpcCalls.find((c) => c.fn === 'app_create')!.args.p_email).toBe('alice@test.dev');
    expect(up.emails).toHaveLength(2);
    expect(up.emails[0].subject).toContain('verification');
    expect(up.emails[1].html).toContain('/get-started/resume?token=' + 'cd'.repeat(32));
    expect(JSON.stringify(r.body)).not.toContain('042913'); // code is only ever emailed
  });
  it('returns the code only when the dev flag is on and live payments are off', async () => {
    expect((await call(create, good, { ...baseEnv, DEV_RETURN_EMAIL_CODE: 'true' })).body.dev_email_code).toBe('042913');
    expect((await call(create, good, { ...baseEnv, DEV_RETURN_EMAIL_CODE: 'true', STRIPE_LIVE_ENABLED: 'true' })).body.dev_email_code).toBeUndefined();
  });
  it('blocks bots: honeypot, failed Turnstile, rate limit', async () => {
    expect((await call(create, { ...good, [HONEYPOT_FIELD]: 'x' })).status).toBe(400);
    up.turnstileOk = false;
    expect((await call(create, good)).body).toEqual({ error: 'bot_check_failed' });
    up.turnstileOk = true; up.rateOk = false;
    expect((await call(create, good)).status).toBe(429);
    expect(rpcsCalled()).not.toContain('app_create');
  });
  it('validates input', async () => {
    expect((await call(create, { ...good, email: 'nope' })).body.error).toBe('email_invalid');
    expect((await call(create, { ...good, role: 'king' })).body.error).toBe('role_invalid');
    expect((await call(create, { ...good, full_name: 'A' })).body.error).toBe('full_name_required');
  });
});

describe('save', () => {
  beforeEach(() => {
    up.rpcs = {
      app_get: () => ({ application: { id: APP_ID } }),
      app_save: () => null, app_set_ein: () => null, app_save_locations: () => null, app_save_owners: () => null,
    };
  });

  it('encrypts the EIN server-side: the database only ever sees ciphertext, iv and last4', async () => {
    const r = await call(save, { token: TOKEN, ein: '12-3456789', patch: { legal_name: 'Acme LLC' } });
    expect(r.status).toBe(200);
    const set = up.rpcCalls.find((c) => c.fn === 'app_set_ein')!.args;
    expect(set.p_last4).toBe('6789');
    const everythingSent = JSON.stringify(up.rpcCalls);
    expect(everythingSent).not.toContain('123456789');
    expect(everythingSent).not.toContain('12-3456789');
    expect(JSON.stringify(r.body)).not.toContain('3456789');
    // and it decrypts only with the right application id as AAD
    expect(await decryptEin({ ciphertext: set.p_ciphertext, iv: set.p_iv }, KEY, APP_ID)).toBe('12-3456789');
    await expect(decryptEin({ ciphertext: set.p_ciphertext, iv: set.p_iv }, KEY, 'other')).rejects.toBeDefined();
  });
  it('rejects an invalid EIN and a missing key without leaking either', async () => {
    expect((await call(save, { token: TOKEN, ein: '12-34' })).body).toEqual({ error: 'invalid_ein' });
    const r = await call(save, { token: TOKEN, ein: '12-3456789' }, { ...baseEnv, EIN_ENCRYPTION_KEY: '' });
    expect(r).toMatchObject({ status: 503, body: { error: 'server_not_configured' } });
  });
  it('forwards patch, locations and owners; validates their shapes', async () => {
    await call(save, { token: TOKEN, patch: { dba: 'X' }, locations: [{ id: 'l' }], owners: [{ id: 'o' }] });
    expect(rpcsCalled()).toEqual(['app_save', 'app_save_locations', 'app_save_owners']);
    expect((await call(save, { token: TOKEN, patch: [] })).body.error).toBe('patch_invalid');
    expect((await call(save, { token: TOKEN, locations: {} })).body.error).toBe('locations_invalid');
  });
  it('maps a bad/locked token to 401 and hides database text', async () => {
    up.rpcs.app_save = () => { throw Object.assign(new Error('invalid_token'), { code: '28000' }); };
    expect((await call(save, { token: TOKEN, patch: {} })).status).toBe(401);
  });
});

describe('agreements', () => {
  beforeEach(() => {
    up.rpcs = { onb_ensure_agreement: (a) => `id-${a.p_kind}`, app_record_agreements: () => null };
  });
  const good = { token: TOKEN, typed_name: 'Alice Applicant', agree: true, compliance_ack: true, sms_consent: false };

  it('registers the hash of the exact text and records IP, user agent, and the SMS decision separately', async () => {
    expect((await call(agreements, good)).status).toBe(200);
    const ens = up.rpcCalls.filter((c) => c.fn === 'onb_ensure_agreement');
    expect(ens.find((c) => c.args.p_kind === 'terms_of_service')!.args.p_sha256).toBe(await sha256Hex(agreementText(TERMS_OF_SERVICE)));
    expect(ens.find((c) => c.args.p_kind === 'merchant_agreement')!.args.p_sha256).toBe(await sha256Hex(agreementText(MERCHANT_AGREEMENT)));
    const rec = up.rpcCalls.find((c) => c.fn === 'app_record_agreements')!.args;
    expect(rec).toMatchObject({ p_ip: '203.0.113.5', p_user_agent: 'vitest-agent', p_sms_consented: false, p_sms_text_version: SMS_CONSENT_VERSION, p_typed_name: 'Alice Applicant' });
  });
  it('SMS consent is true only for a literal true', async () => {
    for (const v of ['true', 1, 'yes', null, undefined]) {
      up.rpcCalls = [];
      await call(agreements, { ...good, sms_consent: v });
      expect(up.rpcCalls.find((c) => c.fn === 'app_record_agreements')!.args.p_sms_consented).toBe(false);
    }
    up.rpcCalls = [];
    await call(agreements, { ...good, sms_consent: true });
    expect(up.rpcCalls.find((c) => c.fn === 'app_record_agreements')!.args.p_sms_consented).toBe(true);
  });
  it('requires agreement, compliance acknowledgement and a name', async () => {
    expect((await call(agreements, { ...good, agree: false })).body.error).toBe('agree_required');
    expect((await call(agreements, { ...good, compliance_ack: false })).body.error).toBe('compliance_ack_required');
    expect((await call(agreements, { ...good, typed_name: ' ' })).body.error).toBe('typed_name_required');
  });
});

describe('uploads', () => {
  beforeEach(() => {
    up.rpcs = {
      app_get: () => ({ application: { id: APP_ID } }),
      app_register_document: () => 'doc-1',
    };
  });

  it('upload-url only issues paths inside the applicant’s own folder and enforces type and size', async () => {
    const r = await call(uploadUrl, { token: TOKEN, mime: 'application/pdf', size: 1000 });
    expect(r.status).toBe(200);
    expect(r.body.path).toMatch(new RegExp(`^${APP_ID}/[0-9a-f]{32}\\.pdf$`));
    expect(r.body.upload_token).toBe('signed-token');
    expect((await call(uploadUrl, { token: TOKEN, mime: 'text/html', size: 10 })).body.error).toBe('file_type_not_allowed');
    expect((await call(uploadUrl, { token: TOKEN, mime: 'image/png', size: 10 * 1024 * 1024 + 1 })).status).toBe(413);
    expect((await call(uploadUrl, { token: TOKEN, mime: 'image/png', size: 0 })).body.error).toBe('file_empty');
  });

  const reg = { token: TOKEN, kind: 'license_tx_ecig', path: `${APP_ID}/abc.pdf`, original_name: 'permit.pdf' };
  const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34];

  it('records a real PDF using the sniffed type and actual size, not the browser’s claims', async () => {
    up.object = { size: 2048, head: PDF };
    const r = await call(registerDocument, { ...reg, mime: 'image/png', size: 1 });
    expect(r.body).toEqual({ document_id: 'doc-1', scan_status: 'skipped' });
    expect(up.rpcCalls.find((c) => c.fn === 'app_register_document')!.args).toMatchObject({ p_mime: 'application/pdf', p_size: 2048 });
  });
  it('deletes and rejects a file whose bytes are not PDF/JPG/PNG (e.g. an HTML file renamed .pdf)', async () => {
    up.object = { size: 100, head: [0x3c, 0x68, 0x74, 0x6d, 0x6c] };
    const r = await call(registerDocument, reg);
    expect(r.body.error).toBe('file_rejected');
    expect(up.deleted).toHaveLength(1);
    expect(rpcsCalled()).not.toContain('app_register_document');
  });
  it('deletes and rejects an oversized object', async () => {
    up.object = { size: 11 * 1024 * 1024, head: PDF };
    expect((await call(registerDocument, reg)).body.error).toBe('file_rejected');
    expect(up.deleted).toHaveLength(1);
  });
  it('rejects a missing upload, a foreign path and path traversal', async () => {
    expect((await call(registerDocument, reg)).body.error).toBe('upload_missing');
    expect((await call(registerDocument, { ...reg, path: 'other-app/abc.pdf' })).status).toBe(403);
    expect((await call(registerDocument, { ...reg, path: `${APP_ID}/../other/abc.pdf` })).status).toBe(403);
    expect((await call(registerDocument, { ...reg, kind: 'passport' })).body.error).toBe('document_kind_invalid');
  });
  it('sniffMime recognises the three allowed types only', () => {
    expect(sniffMime(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(sniffMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe('image/png');
    expect(sniffMime(new Uint8Array([0x4d, 0x5a]))).toBeNull(); // Windows executable
    expect(sniffMime(new Uint8Array([0x47, 0x49, 0x46]))).toBeNull(); // GIF
  });
});

describe('submit', () => {
  beforeEach(() => {
    up.rpcs = {
      app_submit: () => ({ ok: true }),
      app_get: () => ({ application: { id: APP_ID, email: 'alice@test.dev', full_name: 'Alice A', legal_name: 'Acme <b>LLC</b>', plan_model: 'model_a' } }),
    };
  });
  it('requires Turnstile, emails a confirmation and notifies the admin', async () => {
    up.turnstileOk = false;
    expect((await call(submit, { token: TOKEN })).status).toBe(403);
    up.turnstileOk = true;
    const r = await call(submit, { token: TOKEN, turnstileToken: 't' }, { ...baseEnv, ADMIN_NOTIFY_EMAIL: 'ops@r4ckd.net' });
    expect(r.body).toEqual({ ok: true });
    expect(up.emails.map((e) => e.to)).toEqual(['alice@test.dev', 'ops@r4ckd.net']);
    expect(up.emails[0].html).not.toContain('<b>LLC</b>'); // escaped
  });
  it('returns all validation problems and sends no email when incomplete', async () => {
    up.rpcs.app_submit = () => ({ ok: false, errors: ['Verify your email address.', 'Add at least one location.'] });
    const r = await call(submit, { token: TOKEN, turnstileToken: 't' });
    expect(r.body).toEqual({ ok: false, errors: ['Verify your email address.', 'Add at least one location.'] });
    expect(up.emails).toHaveLength(0);
  });
});
