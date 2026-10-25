import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost as cron } from '../../functions/api/cron/permit-reminders';
import { runPermitReminders, type DueRow } from '../../functions/_lib/permitReminders';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', RESEND_API_KEY: 're_x', CRON_SECRET: 'cron-secret-value', APP_BASE_URL: 'https://r4ckd.net' };
const TODAY = new Date(Date.UTC(2026, 9, 24));
const iso = (d: number) => new Date(Date.UTC(2026, 9, 24 + d)).toISOString().slice(0, 10);

const row = (over: Partial<DueRow> = {}): DueRow => ({
  permit_id: 'p1', tenant_id: 't1', location_name: 'Main St', kind: 'tx_ecig', number: 'EC-1', expiry: iso(20), days_before: 30,
  owner_email: 'owner@acme.co', owner_name: 'Alice A', ...over,
});

let due: DueRow[];
let emails: any[];
let marks: any[];
let audits: any[];
let failTo: string | null;
let markFails: boolean;

beforeEach(() => {
  due = []; emails = []; marks = []; audits = []; failTo = null; markFails = false;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const ok = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s });
    if (url.includes('resend.com')) {
      const b = JSON.parse(init.body);
      if (failTo === b.to) return ok({}, 500);
      emails.push(b);
      return ok({ id: 'em' });
    }
    if (url.includes('/rpc/permits_due_for_notice')) return ok(due);
    if (url.includes('/rpc/permit_notice_mark')) { if (markFails) return ok({ code: 'XX', message: 'x' }, 500); marks.push(JSON.parse(init.body)); return ok(null); }
    if (url.includes('/rpc/write_audit')) { audits.push(JSON.parse(init.body)); return ok(null); }
    throw new Error('unexpected ' + url);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('runPermitReminders', () => {
  it('does nothing when nothing is due', async () => {
    expect(await runPermitReminders(env, undefined, TODAY)).toEqual({ due: 0, emails_sent: 0, emails_failed: 0, permits_marked: 0 });
    expect(emails).toHaveLength(0);
  });

  it('sends one email per owner and bucket listing every permit, soonest first, then records each permit', async () => {
    due = [
      row({ permit_id: 'p1', kind: 'tx_ecig', expiry: iso(20) }),
      row({ permit_id: 'p2', kind: 'tabc', location_name: 'Second St', number: null, expiry: iso(9) }),
      row({ permit_id: 'p3', kind: 'tx_ecig', days_before: 7, expiry: iso(3), owner_email: 'OWNER@acme.co' }),
    ];
    const s = await runPermitReminders(env, undefined, TODAY);
    expect(s).toEqual({ due: 3, emails_sent: 2, emails_failed: 0, permits_marked: 3 });
    const thirty = emails.find((e) => e.subject.startsWith('Reminder'))!;
    expect(thirty.to).toBe('owner@acme.co');
    expect(thirty.subject).toBe('Reminder: permits expire within 30 days');
    expect(thirty.html.indexOf('Second St')).toBeLessThan(thirty.html.indexOf('Main St'));   // 9 days before 20 days
    expect(thirty.html).toContain('expires in 9 days');
    expect(thirty.html).toContain('TABC permit');
    const seven = emails.find((e) => e.subject.startsWith('Action needed'))!;
    expect(seven.subject).toBe('Action needed: a permit expires within 7 days');
    expect(seven.html).toContain('expires in 3 days');
    expect(marks).toEqual([
      { p_permit: 'p1', p_days: 30, p_expiry: iso(20) },
      { p_permit: 'p2', p_days: 30, p_expiry: iso(9) },
      { p_permit: 'p3', p_days: 7, p_expiry: iso(3) },
    ]);
  });

  it('keeps separate owners separate', async () => {
    due = [row({ permit_id: 'a' }), row({ permit_id: 'b', owner_email: 'other@vapor.co', owner_name: 'Bob', tenant_id: 't2' })];
    await runPermitReminders(env, undefined, TODAY);
    expect(emails.map((e) => e.to).sort()).toEqual(['other@vapor.co', 'owner@acme.co']);
  });

  it('does NOT record a reminder whose email failed, so the next run retries it', async () => {
    due = [row({ permit_id: 'a' }), row({ permit_id: 'b', owner_email: 'down@x.co', tenant_id: 't2' })];
    failTo = 'down@x.co';
    const s = await runPermitReminders(env, undefined, TODAY);
    expect(s).toMatchObject({ emails_sent: 1, emails_failed: 1, permits_marked: 1 });
    expect(marks.map((m) => m.p_permit)).toEqual(['a']);
  });

  it('survives a failed bookkeeping write and still reports the run', async () => {
    due = [row()];
    markFails = true;
    const s = await runPermitReminders(env, undefined, TODAY);
    expect(s).toMatchObject({ emails_sent: 1, permits_marked: 0 });
  });

  it('writes an audit row with the counts and no recipient addresses', async () => {
    due = [row()];
    await runPermitReminders(env, undefined, TODAY);
    expect(audits[0]).toMatchObject({ p_action: 'permit_reminders.run', p_after: { due: 1, emails_sent: 1 } });
    expect(JSON.stringify(audits)).not.toContain('owner@acme.co');
  });

  it('escapes permit numbers and location names in the email', async () => {
    due = [row({ location_name: '<img src=x onerror=alert(1)>', number: '"><script>1</script>' })];
    await runPermitReminders(env, undefined, TODAY);
    expect(emails[0].html).not.toContain('<script>');
    expect(emails[0].html).not.toContain('<img src=x');
  });

  it('uses plain-language dates and the single/plural wording', async () => {
    due = [row({ expiry: iso(1) })];
    await runPermitReminders(env, undefined, TODAY);
    expect(emails[0].html).toContain('expires tomorrow');
    expect(emails[0].html).toContain('October 25, 2026');
  });
});

describe('cron endpoint', () => {
  const call = async (headers: Record<string, string>, e: object = env) => {
    const res = await (cron as any)({ request: new Request('https://r4ckd.net/api/cron/permit-reminders', { method: 'POST', headers }), env: e });
    return { status: res.status, body: await res.json() as any };
  };
  it('requires the exact bearer secret', async () => {
    expect((await call({})).status).toBe(401);
    expect((await call({ Authorization: 'Bearer wrong' })).status).toBe(401);
    expect((await call({ Authorization: 'cron-secret-value' })).status).toBe(401);
    expect(emails).toHaveLength(0);
  });
  it('refuses to run at all when no secret is configured (never open by default)', async () => {
    const { CRON_SECRET: _c, ...open } = env;
    expect((await call({ Authorization: 'Bearer ' }, open)).status).toBe(503);
    expect((await call({}, open)).status).toBe(503);
  });
  it('runs with the right secret and returns the summary', async () => {
    due = [row()];
    const r = await call({ Authorization: 'Bearer cron-secret-value' });
    expect(r).toMatchObject({ status: 200, body: { ok: true, due: 1, emails_sent: 1, permits_marked: 1 } });
  });
});
