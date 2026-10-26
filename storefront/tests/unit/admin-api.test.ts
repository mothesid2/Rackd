import bcrypt from 'bcryptjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { b64encode, decryptEin, encryptEin } from '../../functions/_lib/crypto';
import { orderEmailToken, sha256Hex } from '../../functions/_lib/token';
import { onRequestPost as fileUrl } from '../../functions/api/admin/file-url';
import { onRequestPost as revealEin } from '../../functions/api/admin/reveal-ein';
import { onRequestPost as appStatus } from '../../functions/api/admin/application-status';
import { onRequestPost as approve } from '../../functions/api/admin/approve';
import { onRequestPost as resend } from '../../functions/api/admin/resend-invite';
import { onRequestPost as orderAction } from '../../functions/api/admin/order-action';
import { onRequestPost as activate } from '../../functions/api/onboarding/activate';
import { diffKeys, permitFlag, toCents, toDollars } from '../../lib/admin/api';

const KEY = b64encode(crypto.getRandomValues(new Uint8Array(32)));
const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', TURNSTILE_SECRET_KEY: 's', EIN_ENCRYPTION_KEY: KEY, RESEND_API_KEY: 're_x', APP_BASE_URL: 'https://r4ckd.net' };
const ADMIN = 'aaaaaaaa-1111-1111-1111-111111111111';
const APP = '5b7e2f0a-1111-4222-8333-444455556666';
const ORDER = '6c8f3a1b-2222-4333-8444-555566667777';
const DOC = '7d9a4b2c-3333-4444-8555-666677778888';
const TENANT = '11111111-1111-1111-1111-111111111111';
const INVITE = 'cd'.repeat(32);

interface Up { rpcs: Record<string, (a: any, auth: string) => unknown>; calls: { fn: string; args: any; auth: string }[]; rest: Record<string, (url: string, init?: any) => unknown>; restCalls: { url: string; method: string; body?: any }[]; emails: any[]; whoami: string | null; turnstileOk: boolean; resendOk: boolean; storage: { signed?: string } }
let up: Up;

beforeEach(() => {
  up = { rpcs: {}, calls: [], rest: {}, restCalls: [], emails: [], whoami: ADMIN, turnstileOk: true, resendOk: true, storage: {} };
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const ok = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (url.includes('turnstile')) return ok({ success: up.turnstileOk });
    if (url.includes('resend.com')) { if (!up.resendOk) return ok({}, 500); up.emails.push(JSON.parse(init.body)); return ok({ id: 'em' }); }
    if (url.includes('/storage/v1/object/sign/')) return ok({ signedURL: '/object/sign/onboarding-docs/x?token=abc' });
    if (url.includes('/rpc/')) {
      const fn = url.split('/rpc/')[1];
      const args = JSON.parse(init.body);
      const auth = init.headers.Authorization as string;
      up.calls.push({ fn, args, auth });
      if (fn === 'rate_limit_hit') return ok(true);
      if (fn === 'admin_whoami') return up.whoami && auth === 'Bearer admin-jwt' ? ok(up.whoami) : ok(null);
      if (!up.rpcs[fn]) return ok({ code: 'P0001', message: 'unexpected_rpc_' + fn }, 400);
      try { return ok(up.rpcs[fn](args, auth)); } catch (e: any) { return ok({ code: e.code ?? 'P0001', message: e.message }, 400); }
    }
    if (url.includes('/rest/v1/')) {
      const method = init?.method ?? 'GET';
      up.restCalls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      const table = url.split('/rest/v1/')[1].split('?')[0];
      const h = up.rest[`${method} ${table}`];
      if (!h) return ok({ code: 'XX', message: 'unexpected rest ' + method + ' ' + table }, 500);
      const r = h(url, init);
      return method === 'GET' ? ok(r) : new Response(null, { status: 204 });
    }
    throw new Error('unexpected fetch ' + url);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const post = async (h: any, body: object, opts: { auth?: string | null; env?: object } = {}) => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' };
  const auth = opts.auth === undefined ? 'Bearer admin-jwt' : opts.auth;
  if (auth) headers.Authorization = auth;
  const res = await h({ request: new Request('https://r4ckd.net/api/admin/x', { method: 'POST', body: JSON.stringify(body), headers }), env: opts.env ?? env });
  return { status: res.status, body: await res.json() as any };
};
const fnCalls = (name: string) => up.calls.filter((c) => c.fn === name);

describe('admin guard', () => {
  it('rejects missing, malformed and non-admin bearer tokens before doing anything', async () => {
    expect((await post(fileUrl, { document_id: DOC }, { auth: null })).status).toBe(401);
    expect((await post(fileUrl, { document_id: DOC }, { auth: 'Basic abc' })).status).toBe(401);
    expect((await post(fileUrl, { document_id: DOC }, { auth: 'Bearer some-customer-jwt' })).status).toBe(403);
    up.whoami = null; // a signed-in customer: valid JWT, not in platform_admins
    expect((await post(fileUrl, { document_id: DOC })).status).toBe(403);
    expect(up.restCalls).toHaveLength(0);
  });
  it('verifies the admin as the caller (the database decides, using their own JWT)', async () => {
    up.rest['GET onboarding_documents'] = () => [];
    await post(fileUrl, { document_id: DOC });
    expect(fnCalls('admin_whoami')[0].auth).toBe('Bearer admin-jwt');
  });
});

describe('file-url', () => {
  const doc = { storage_path: `${APP}/abc.pdf`, scan_status: 'skipped', original_name: 'permit.pdf', mime: 'application/pdf', application_id: APP, kind: 'license_tx_ecig' };
  it('returns a short-lived absolute signed URL and audits the view with the admin as actor', async () => {
    up.rest['GET onboarding_documents'] = () => [doc];
    up.rpcs.write_audit = () => null;
    const r = await post(fileUrl, { document_id: DOC });
    expect(r.body.url).toBe('https://p.supabase.co/storage/v1/object/sign/onboarding-docs/x?token=abc');
    expect(fnCalls('write_audit')[0].args).toMatchObject({ p_action: 'document.view', p_entity_id: DOC, p_actor: ADMIN });
  });
  it('refuses infected files, unknown documents and bad ids', async () => {
    up.rest['GET onboarding_documents'] = () => [{ ...doc, scan_status: 'infected' }];
    expect((await post(fileUrl, { document_id: DOC })).body.error).toBe('file_infected');
    up.rest['GET onboarding_documents'] = () => [];
    expect((await post(fileUrl, { document_id: DOC })).status).toBe(404);
    expect((await post(fileUrl, { document_id: 'nope' })).status).toBe(400);
    expect(fnCalls('write_audit')).toHaveLength(0);
  });
});

describe('reveal-ein', () => {
  it('decrypts for the admin, audits the reveal, and never audits or logs the plaintext', async () => {
    const e = await encryptEin('12-3456789', KEY, APP);
    up.rest['GET onboarding_applications'] = () => [{ ein_ciphertext: e.ciphertext, ein_iv: e.iv }];
    up.rpcs.write_audit = () => null;
    const spies = [vi.spyOn(console, 'info'), vi.spyOn(console, 'error'), vi.spyOn(console, 'warn')];
    const r = await post(revealEin, { application_id: APP });
    expect(r.body).toEqual({ ein: '12-3456789' });
    expect(JSON.stringify(fnCalls('write_audit'))).not.toContain('3456789');
    expect(fnCalls('write_audit')[0].args).toMatchObject({ p_action: 'ein.reveal', p_actor: ADMIN });
    expect(spies.flatMap((s) => s.mock.calls.flat()).join(' ')).not.toContain('3456789');
    expect(await decryptEin({ ciphertext: e.ciphertext, iv: e.iv }, KEY, APP)).toBe('12-3456789');
  });
  it('404s when no EIN is stored and fails without the key', async () => {
    up.rest['GET onboarding_applications'] = () => [{ ein_ciphertext: null, ein_iv: null }];
    expect((await post(revealEin, { application_id: APP })).body.error).toBe('ein_not_set');
    expect((await post(revealEin, { application_id: APP }, { env: { ...env, EIN_ENCRYPTION_KEY: '' } })).status).toBe(503);
  });
});

describe('application-status', () => {
  beforeEach(() => {
    up.rpcs.admin_set_status = () => null;
    up.rpcs.app_magic_issue = () => [{ magic_token: 'ef'.repeat(32) }];
    up.rest['GET onboarding_applications'] = () => [{ email: 'owner@acme.co', full_name: 'Alice A' }];
  });
  it('runs the transition as the admin (so the audit row has their id) and emails the info request with a resume link', async () => {
    const r = await post(appStatus, { application_id: APP, to: 'needs_info', message: 'Please upload a clearer sales tax permit.' });
    expect(r.body).toEqual({ ok: true, emailed: true });
    expect(fnCalls('admin_set_status')[0]).toMatchObject({ auth: 'Bearer admin-jwt', args: { p_app: APP, p_status: 'needs_info' } });
    expect(up.emails[0].to).toBe('owner@acme.co');
    expect(up.emails[0].html).toContain('clearer sales tax permit');
    expect(up.emails[0].html).toContain('/get-started/resume?token=' + 'ef'.repeat(32));
  });
  it('escapes admin-written text in the email', async () => {
    await post(appStatus, { application_id: APP, to: 'needs_info', message: '<script>alert(1)</script> upload a better scan' });
    expect(up.emails[0].html).not.toContain('<script>');
  });
  it('emails the rejection reason; start-review sends no email', async () => {
    await post(appStatus, { application_id: APP, to: 'rejected', message: 'Permit could not be verified with the state.' });
    expect(up.emails[0].subject).toContain('update');
    up.emails = [];
    expect((await post(appStatus, { application_id: APP, to: 'in_review' })).body).toEqual({ ok: true });
    expect(up.emails).toHaveLength(0);
  });
  it('requires a real message for info and rejection, and only allows review statuses (approve is its own endpoint)', async () => {
    expect((await post(appStatus, { application_id: APP, to: 'needs_info', message: 'short' })).body.error).toBe('message_required');
    expect((await post(appStatus, { application_id: APP, to: 'approved' })).body.error).toBe('status_invalid');
    expect((await post(appStatus, { application_id: APP, to: 'activated' })).body.error).toBe('status_invalid');
    expect(fnCalls('admin_set_status')).toHaveLength(0);
  });
  it('surfaces invalid transitions as a safe slug', async () => {
    up.rpcs.admin_set_status = () => { throw new Error('invalid_transition: approved -> rejected'); };
    expect((await post(appStatus, { application_id: APP, to: 'rejected', message: 'a long enough reason' })).body.error).toBe('invalid_transition');
  });
});

describe('approve', () => {
  const first = { tenant_id: TENANT, license_id: 'l1', license_key: 'RACKD-ABCD-EFGH-JKLM', plan_type: 'model_a', features: ['web_store'], locations: [{ id: 'x', name: 'Main' }], owner_email: 'owner@acme.co', owner_name: 'Alice A', already_provisioned: false, invite_token: INVITE };
  beforeEach(() => { up.rest['GET onboarding_applications'] = () => [{ legal_name: 'Acme Vapes LLC' }]; });

  it('provisions once, emails the invite, and never returns the invite token to the browser', async () => {
    up.rpcs.onb_provision = () => first;
    const r = await post(approve, { application_id: APP });
    expect(r.body).toMatchObject({ license_key: 'RACKD-ABCD-EFGH-JKLM', emailed: true, already_provisioned: false });
    expect(JSON.stringify(r.body)).not.toContain(INVITE);
    expect(fnCalls('onb_provision')[0].args).toEqual({ p_app: APP, p_actor: ADMIN });
    expect(up.emails).toHaveLength(1);
    expect(up.emails[0].to).toBe('owner@acme.co');
    expect(up.emails[0].html).toContain(`/get-started/activate?token=${INVITE}`);
    expect(up.emails[0].html).toContain('RACKD-ABCD-EFGH-JKLM');
  });
  it('a second click returns the same business and sends nothing', async () => {
    up.rpcs.onb_provision = () => { const { invite_token, ...rest } = first; return { ...rest, already_provisioned: true }; };
    const r = await post(approve, { application_id: APP });
    expect(r.body).toMatchObject({ already_provisioned: true, emailed: false, license_key: 'RACKD-ABCD-EFGH-JKLM' });
    expect(up.emails).toHaveLength(0);
  });
  it('reports a failed email without losing the provisioning (the admin can resend)', async () => {
    up.rpcs.onb_provision = () => first;
    up.resendOk = false;
    const r = await post(approve, { application_id: APP });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ already_provisioned: false, emailed: false, license_key: 'RACKD-ABCD-EFGH-JKLM' });
  });
  it('shows a clear error for duplicate business names and wrong statuses', async () => {
    up.rpcs.onb_provision = () => { throw new Error('business_name_exists'); };
    expect((await post(approve, { application_id: APP })).body.error).toBe('business_name_exists');
    up.rpcs.onb_provision = () => { throw new Error('invalid_status: draft'); };
    expect((await post(approve, { application_id: APP })).body.error).toBe('invalid_status');
  });
});

describe('resend-invite', () => {
  it('mints a fresh link, emails it, and refuses activated owners', async () => {
    up.rest['GET onboarding_applications'] = () => [{ legal_name: 'Acme Vapes LLC' }];
    up.rpcs.onb_reissue_invite = () => ({ email: 'owner@acme.co', full_name: 'Alice A', invite_token: INVITE, license_key: 'RACKD-ABCD-EFGH-JKLM' });
    expect((await post(resend, { application_id: APP })).body).toEqual({ ok: true, emailed: true });
    expect(up.emails[0].html).toContain(INVITE);
    up.rpcs.onb_reissue_invite = () => { throw new Error('already_activated'); };
    expect((await post(resend, { application_id: APP })).body.error).toBe('already_activated');
  });
});

describe('order-action', () => {
  beforeEach(() => {
    up.rpcs.hw_admin_transition = (a) => ({ order_number: 'HW-1001', email: 'buyer@test.dev', is_test: true, to: a.p_to });
    up.rpcs.hw_issue_email_token = () => null;
    up.rpcs.hw_get_order = () => ({ id: ORDER, order_number: 'HW-1001', is_test: true, items: [], discount_cents: 0, shipping_cents: 0, tax_cents: 0, total_cents: 0, address: { full_name: 'Pat', line1: '1', city: 'A', state: 'TX', zip: '78701' } });
    up.rpcs.hw_admin_note = () => null;
  });
  it('marks shipped with tracking, passes the admin as actor, and emails a link whose token matches the stored hash', async () => {
    const r = await post(orderAction, { order_id: ORDER, action: 'shipped', carrier: 'UPS', tracking: '1Z999AA10123456784' });
    expect(r.body).toEqual({ ok: true, emailed: true });
    expect(fnCalls('hw_admin_transition')[0].args).toMatchObject({ p_order: ORDER, p_to: 'shipped', p_carrier: 'UPS', p_tracking: '1Z999AA10123456784', p_actor: ADMIN });
    const mail = up.emails[0];
    expect(mail.to).toBe('buyer@test.dev');
    expect(mail.html).toContain('1Z999AA10123456784');
    const tok = /#t=([0-9a-f]{64})/.exec(mail.html)![1];
    expect(tok).toBe(await orderEmailToken(KEY, ORDER));                       // same link as the confirmation email
    expect(fnCalls('hw_issue_email_token')[0].args.p_hash).toBe(await sha256Hex(tok));
  });
  it('fulfilled and cancelled send no customer email; notes call the note function', async () => {
    await post(orderAction, { order_id: ORDER, action: 'fulfilled' });
    await post(orderAction, { order_id: ORDER, action: 'cancelled', note: 'customer asked, refunded in Stripe' });
    expect(up.emails).toHaveLength(0);
    await post(orderAction, { order_id: ORDER, action: 'note', note: 'refunded $50' });
    expect(fnCalls('hw_admin_note')[0].args).toEqual({ p_order: ORDER, p_note: 'refunded $50', p_actor: ADMIN });
  });
  it('rejects unknown actions (including refunded, which only Stripe can set) and surfaces database rules', async () => {
    expect((await post(orderAction, { order_id: ORDER, action: 'refunded' })).body.error).toBe('action_invalid');
    expect((await post(orderAction, { order_id: ORDER, action: 'paid' })).body.error).toBe('action_invalid');
    up.rpcs.hw_admin_transition = () => { throw new Error('tracking_required'); };
    expect((await post(orderAction, { order_id: ORDER, action: 'shipped', tracking: '' })).body.error).toBe('tracking_required');
    up.rpcs.hw_admin_transition = () => { throw new Error('invalid_transition: shipped -> shipped'); };
    expect((await post(orderAction, { order_id: ORDER, action: 'shipped', tracking: 'x' })).body.error).toBe('invalid_transition');
  });
});

describe('owner activation', () => {
  const pub = async (body: object, e: object = env) => {
    const res = await (activate as any)({ request: new Request('https://r4ckd.net/api/onboarding/activate', { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' } }), env: e });
    return { status: res.status, body: await res.json() as any };
  };
  const good = { invite: INVITE, password: 'correct horse battery', turnstileToken: 't' };
  beforeEach(() => {
    up.rpcs.onb_peek_invite = () => ({ tenant_id: TENANT, email: 'Owner@Acme.co', full_name: 'Alice A' });
    up.rpcs.onb_redeem_invite = () => ({});
    up.rpcs.onb_mark_activated = () => true;
    up.rest['GET employees_cloud'] = () => [];
    up.rest['POST employees_cloud'] = () => null;
  });

  it('creates an admin login with a bcrypt hash of the chosen password, then consumes the invite and activates', async () => {
    const r = await pub(good);
    expect(r.body).toEqual({ ok: true, username: 'owner@acme.co' });
    const ins = up.restCalls.find((c) => c.method === 'POST')!.body;
    expect(ins).toMatchObject({ tenant_id: TENANT, username: 'owner@acme.co', name: 'Alice A', role: 'admin', is_active: true, must_change_password: false, must_change_pin: true, pin_hash: null });
    expect(ins.password_hash).toMatch(/^\$2[aby]\$10\$/);
    expect(bcrypt.compareSync('correct horse battery', ins.password_hash)).toBe(true);   // the exact check staff-login performs
    expect(JSON.stringify(up.restCalls)).not.toContain('correct horse battery');
    expect(JSON.stringify(up.calls)).not.toContain('correct horse battery');
    expect(up.calls.map((c) => c.fn).filter((f) => f !== 'rate_limit_hit')).toEqual(['onb_peek_invite', 'onb_redeem_invite', 'onb_mark_activated']);
  });
  it('updates the password of an existing login instead of creating a duplicate', async () => {
    up.rest['GET employees_cloud'] = () => [{ uid: 'u-1' }];
    up.rest['PATCH employees_cloud'] = () => null;
    await pub(good);
    expect(up.restCalls.some((c) => c.method === 'POST')).toBe(false);
    expect(up.restCalls.find((c) => c.method === 'PATCH')!.url).toContain('uid=eq.u-1');
  });
  it('does not burn the invite if creating the login fails', async () => {
    up.rest['POST employees_cloud'] = () => { throw new Error('db down'); };
    const r = await pub(good);
    expect(r.status).toBe(500);
    const called = up.calls.map((c) => c.fn);
    expect(called).toContain('onb_peek_invite');
    expect(called).not.toContain('onb_redeem_invite');
    expect(called).not.toContain('onb_mark_activated');
  });
  it('enforces password length, Turnstile, and valid invites', async () => {
    expect((await pub({ ...good, password: 'short' })).body.error).toBe('password_too_short');
    expect((await pub({ ...good, password: 'x'.repeat(129) })).body.error).toBe('password_too_long');
    up.turnstileOk = false;
    expect((await pub(good)).body.error).toBe('bot_check_failed');
    up.turnstileOk = true;
    expect((await pub({ ...good, invite: 'nope' })).status).toBe(401);
    up.rpcs.onb_peek_invite = () => { throw Object.assign(new Error('invalid_token'), { code: '28000' }); };
    expect((await pub(good)).status).toBe(401);
    expect(up.restCalls.filter((c) => c.method !== 'GET')).toHaveLength(0);
  });
});

describe('console helpers', () => {
  it('permit flags: red when expired or within 30 days', () => {
    const today = new Date(2026, 9, 24);
    expect(permitFlag('2026-10-23', today)).toBe('expired');
    expect(permitFlag('2026-10-24', today)).toBe('soon');
    expect(permitFlag('2026-11-23', today)).toBe('soon');
    expect(permitFlag('2026-11-24', today)).toBe('ok');
    expect(permitFlag(null, today)).toBeNull();
  });
  it('money conversion round-trips and rejects junk', () => {
    expect(toCents('12.34')).toBe(1234);
    expect(toCents('$1,299.00')).toBe(129900);
    expect(toCents('0.1')).toBe(10);
    for (const bad of ['', 'abc', '-5']) expect(toCents(bad)).toBeNull();
    expect(toDollars(129900)).toBe('1299.00');
    expect(toDollars(null)).toBe('');
  });
  it('diffKeys reports only real changes and ignores timestamps', () => {
    expect(diffKeys({ price_cents: 100, name: 'A', updated_at: 'x' }, { price_cents: 200, name: 'A', updated_at: 'y' })).toEqual([{ key: 'price_cents', from: 100, to: 200 }]);
    expect(diffKeys(null, { a: 1 })).toEqual([{ key: 'a', from: undefined, to: 1 }]);
    expect(diffKeys({ a: { x: 1 } }, { a: { x: 1 } })).toEqual([]);
  });
  it('the emailed order token is deterministic per order and secret', async () => {
    expect(await orderEmailToken('s1', ORDER)).toBe(await orderEmailToken('s1', ORDER));
    expect(await orderEmailToken('s1', ORDER)).not.toBe(await orderEmailToken('s2', ORDER));
    expect(await orderEmailToken('s1', ORDER)).not.toBe(await orderEmailToken('s1', APP));
    expect(await orderEmailToken('s1', ORDER)).toMatch(/^[0-9a-f]{64}$/);
  });
});
