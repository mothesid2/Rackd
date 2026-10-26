import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost as cron } from '../../functions/api/cron/storefront-jobs';
import { onRequestPost as kick } from '../../functions/api/storefront/kick';
import { customerReservationEmail, shopNewReservationEmail, STOREFRONT_EMAIL_TEXT, type OutboxPayload } from '../../functions/_lib/storefrontEmails';
import { processOutbox } from '../../functions/_lib/storefrontOutbox';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', TURNSTILE_SECRET_KEY: 's', RESEND_API_KEY: 're_x', CRON_SECRET: 'cron-secret' };

const payload = (over: Partial<OutboxPayload> = {}): OutboxPayload => ({
  reservation: {
    code: 'AB12CD34', customer_name: 'Cora C.', subtotal: 25, fee_amount: 1.25, total: 26.25, hold_expires_at: new Date(Date.now() + 3600e3).toISOString(), notes: null,
    items: [{ name: 'Mango <b>Ice</b>', qty: 2, unit_price: 12.5, line_total: 25 }, { name: 'Removed thing', qty: 1, unit_price: 5, line_total: 5, is_removed: true }],
  },
  location_name: 'Main St Vapes', pickup_instructions: 'Ring the bell', notify_email: true, customer_email: 'cora@test.dev', shop_email: 'shop@t1.dev', ...over,
});

let claimed: any[]; let done: any[]; let emails: any[]; let expired: number; let resendOk: boolean; let turnstileOk: boolean;
beforeEach(() => {
  claimed = []; done = []; emails = []; expired = 0; resendOk = true; turnstileOk = true;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const ok = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (url.includes('turnstile')) return ok({ success: turnstileOk });
    if (url.includes('resend.com')) { if (!resendOk) return ok({}, 500); emails.push(JSON.parse(init.body)); return ok({ id: 'em' }); }
    if (url.includes('/rpc/rate_limit_hit')) return ok(true);
    if (url.includes('/rpc/sf_outbox_claim')) return ok(claimed);
    if (url.includes('/rpc/sf_outbox_done')) { done.push(JSON.parse(init.body)); return ok(null); }
    if (url.includes('/rpc/expire_reservation_holds')) return ok(expired);
    throw new Error('unexpected ' + url);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('email templates', () => {
  it('shop email lists items, fee and total, links to the manager, and escapes customer-controlled text', () => {
    const m = shopNewReservationEmail({ MANAGE_BASE_URL: 'https://manage.example.test' }, payload({ reservation: { ...payload().reservation, notes: '<script>x</script>' } }));
    expect(m.subject).toBe('New online reservation AB12CD34');
    expect(m.html).toContain('Cora C.');
    expect(m.html).toContain('$26.25');
    expect(m.html).toContain('https://manage.example.test');
    expect(m.html).not.toContain('<script>');
    expect(m.html).not.toContain('<b>Ice</b>');
    expect(m.html).not.toContain('Removed thing');
  });
  it('customer emails: ready carries pickup instructions, the ID reminder and pay-at-pickup; cancelled shows the reason', () => {
    const ready = customerReservationEmail('ready', payload());
    expect(ready.subject).toBe(STOREFRONT_EMAIL_TEXT.readySubject('AB12CD34'));
    expect(ready.html).toContain('Ring the bell');
    expect(ready.html).toContain('21 or older');
    expect(ready.html).toContain('pay at the shop');
    const cancelled = customerReservationEmail('cancelled', payload({ reservation: { ...payload().reservation, cancel_reason: 'Out of stock <i>sorry</i>' } }));
    expect(cancelled.html).toContain('You were not charged');
    expect(cancelled.html).toContain('Out of stock &lt;i&gt;sorry&lt;/i&gt;');
    expect(cancelled.html).not.toContain('pay at the shop');
    expect(customerReservationEmail('no_show', payload()).subject).toContain('expired');
    expect(customerReservationEmail('items_changed', payload()).subject).toContain('Update');
  });
  it('a waived fee reads "waived", never a dollar amount', () => {
    expect(customerReservationEmail('confirmed', payload({ reservation: { ...payload().reservation, fee_amount: 0, fee_waived: true } })).html).toContain('waived');
  });
});

describe('processOutbox', () => {
  it('sends shop and customer rows to the right recipients and marks each done', async () => {
    claimed = [{ id: 1, kind: 'new_reservation', audience: 'shop', payload: payload() }, { id: 2, kind: 'ready', audience: 'customer', payload: payload() }];
    expect(await processOutbox(env)).toEqual({ claimed: 2, sent: 2, skipped: 0, failed: 0 });
    expect(emails.map((e) => e.to)).toEqual(['shop@t1.dev', 'cora@test.dev']);
    expect(done).toEqual([{ p_id: 1, p_ok: true }, { p_id: 2, p_ok: true }]);
  });
  it('a shop with email notifications off is skipped (still closed), customers are not affected', async () => {
    claimed = [{ id: 1, kind: 'new_reservation', audience: 'shop', payload: payload({ notify_email: false }) }, { id: 2, kind: 'confirmed', audience: 'customer', payload: payload({ notify_email: false }) }];
    expect(await processOutbox(env)).toMatchObject({ sent: 1, skipped: 1 });
    expect(emails.map((e) => e.to)).toEqual(['cora@test.dev']);
  });
  it('closes rows with nobody to email instead of retrying forever', async () => {
    claimed = [{ id: 1, kind: 'ready', audience: 'customer', payload: payload({ customer_email: null }) }, { id: 2, kind: 'new_reservation', audience: 'shop', payload: payload({ shop_email: null }) }];
    expect(await processOutbox(env)).toMatchObject({ skipped: 2, sent: 0 });
    expect(done.every((d) => d.p_ok)).toBe(true);
  });
  it('leaves a failed send pending (with the reason) so it is retried; it never marks it sent', async () => {
    resendOk = false;
    claimed = [{ id: 7, kind: 'ready', audience: 'customer', payload: payload() }];
    expect(await processOutbox(env)).toMatchObject({ failed: 1, sent: 0 });
    expect(done).toEqual([{ p_id: 7, p_ok: false, p_error: 'provider_error' }]);
  });
  it('does nothing when the outbox is empty', async () => {
    expect(await processOutbox(env)).toEqual({ claimed: 0, sent: 0, skipped: 0, failed: 0 });
  });
});

describe('endpoints', () => {
  const callCron = async (headers: Record<string, string>, e: object = env) => {
    const res = await (cron as any)({ request: new Request('https://r4ckd.net/api/cron/storefront-jobs', { method: 'POST', headers }), env: e });
    return { status: res.status, body: await res.json() as any };
  };
  it('cron needs the exact bearer secret and refuses to run without one configured', async () => {
    expect((await callCron({})).status).toBe(401);
    expect((await callCron({ Authorization: 'Bearer nope' })).status).toBe(401);
    const { CRON_SECRET: _c, ...open } = env;
    expect((await callCron({}, open)).status).toBe(503);
  });
  it('cron expires holds then drains the outbox', async () => {
    expired = 3;
    claimed = [{ id: 1, kind: 'cancelled', audience: 'customer', payload: payload() }];
    const r = await callCron({ Authorization: 'Bearer cron-secret' });
    expect(r.body).toMatchObject({ ok: true, expired: 3, outbox: { sent: 1 } });
  });
  it('kick is public but bot-checked: honeypot and rate limit apply, and it only drains the queue', async () => {
    claimed = [{ id: 1, kind: 'new_reservation', audience: 'shop', payload: payload() }];
    const res = await (kick as any)({ request: new Request('https://r4ckd.net/api/storefront/kick', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': '1.2.3.4' } }), env });
    expect(await res.json()).toEqual({ ok: true, sent: 1 });
    const bot = await (kick as any)({ request: new Request('https://r4ckd.net/api/storefront/kick', { method: 'POST', body: JSON.stringify({ fax_number: 'x' }), headers: { 'Content-Type': 'application/json' } }), env });
    expect(bot.status).toBe(400);
  });
});
