import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onRequestPost as cron } from '../../functions/api/cron/storefront-statements';
import { periodFor, runStatements, statementCsv, statementPdf, type StatementResult } from '../../functions/_lib/storefrontStatements';

const env = { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', RESEND_API_KEY: 're_x', CRON_SECRET: 'cron-secret' };
const stmt = (over: Partial<StatementResult> = {}): StatementResult => ({
  statement_id: 's1', period: '2026-09', total: 3.7, count: 2, dry_run: false,
  lines: [
    { code: 'AB12', location_id: 'L1', amount: 1.25, picked_up_at: '2026-09-03T10:00:00Z', subtotal: 25 },
    { code: '=CMD', location_id: 'L1', amount: 2.45, picked_up_at: '2026-09-09T10:00:00Z', subtotal: 49 },
  ], ...over,
});

let rpcCalls: any[]; let emails: any[]; let result: StatementResult; let ledgerTenants: string[]; let contact: string | null;
beforeEach(() => {
  rpcCalls = []; emails = []; result = stmt(); ledgerTenants = ['t1', 't1', 't2']; contact = 'owner@shop.test';
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.stubGlobal('fetch', vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
    if (url.includes('/rest/v1/fee_ledger')) return ok(ledgerTenants.map((tenant_id) => ({ tenant_id })));
    if (url.includes('/rest/v1/licenses')) return ok([{ contact_email: contact }]);
    if (url.includes('/rpc/sf_build_statement')) { rpcCalls.push(JSON.parse(init.body)); return ok(result); }
    if (url.includes('resend.com')) { emails.push(JSON.parse(init.body)); return ok({ id: 'em' }); }
    throw new Error('unexpected ' + url);
  }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('statement rendering', () => {
  it('defaults to the previous calendar month, including across a year boundary', () => {
    expect(periodFor(new Date('2026-10-01T03:00:00Z'))).toBe('2026-09');
    expect(periodFor(new Date('2027-01-01T00:30:00Z'))).toBe('2026-12');
    expect(periodFor(new Date('2026-10-01T03:00:00Z'), '2026-03')).toBe('2026-03');
  });
  it('CSV totals the fee column and defuses spreadsheet formulas', () => {
    const csv = statementCsv(stmt());
    expect(csv).toContain('AB12,L1,2026-09-03T10:00:00Z,25.00,1.25');
    expect(csv).toContain("'=CMD");
    expect(csv.trim().split('\r\n').at(-1)).toBe(',,,Total,3.70');
  });
  it('PDF is a well-formed single-font document that survives hostile text', () => {
    const text = new TextDecoder().decode(statementPdf('Shop (A) \\ B', stmt()));
    expect(text.startsWith('%PDF-1.4')).toBe(true);
    expect(text).toContain('Total due: $3.70');
    expect(text).toContain('Shop \\(A\\) \\\\ B');
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true);
    const start = Number(/startxref\n(\d+)/.exec(text)![1]);
    expect(text.slice(start, start + 4)).toBe('xref');
  });
  it('paginates long statements', () => {
    const lines = Array.from({ length: 120 }, (_, i) => ({ code: `C${i}`, location_id: 'L1', amount: 1, picked_up_at: null, subtotal: 10 }));
    const text = new TextDecoder().decode(statementPdf('Shop', stmt({ lines, count: 120, total: 120 })));
    expect(/\/Count (\d+)/.exec(text)![1]).toBe('3');
  });
});

describe('statement job', () => {
  it('dry run builds nothing and emails nobody, but reports the totals', async () => {
    const s = await runStatements(env, { period: '2026-09', dryRun: true });
    expect(rpcCalls.every((c) => c.p_dry_run === true)).toBe(true);
    expect(emails).toHaveLength(0);
    expect(s).toMatchObject({ dry_run: true, tenants: 2, issued: 0, emailed: 0 });
    expect(s.total).toBeCloseTo(7.4);
  });
  it('issues one statement per business (deduped) and emails PDF + CSV to the owner', async () => {
    const s = await runStatements(env, { period: '2026-09' });
    expect(rpcCalls.map((c) => c.p_tenant)).toEqual(['t1', 't2']);
    expect(s).toMatchObject({ issued: 2, emailed: 2, errors: 0 });
    expect(emails[0].to).toBe('owner@shop.test');
    expect(emails[0].attachments.map((a: any) => a.filename)).toEqual(['rackd-statement-2026-09.pdf', 'rackd-statement-2026-09.csv']);
  });
  it('re-running a period does not re-email an already issued statement', async () => {
    result = stmt({ already_issued: true });
    const s = await runStatements(env, { period: '2026-09' });
    expect(s).toMatchObject({ issued: 0, emailed: 0 });
    expect(emails).toHaveLength(0);
  });
  it('still issues when the owner has no email on file, and counts a failed build as an error', async () => {
    contact = null;
    expect(await runStatements(env, { period: '2026-09' })).toMatchObject({ issued: 2, emailed: 0, errors: 0 });
    (fetch as any).mockImplementationOnce(async () => new Response(JSON.stringify([{ tenant_id: 't9' }]), { status: 200 }))
      .mockImplementationOnce(async () => new Response(JSON.stringify({ message: 'boom' }), { status: 500 }));
    expect(await runStatements(env, { period: '2026-09' })).toMatchObject({ errors: 1 });
  });
});

describe('cron endpoint', () => {
  const call = (auth: string | null, body: unknown) => cron({ env, request: new Request('https://x.test/api/cron/storefront-statements', { method: 'POST', headers: auth ? { Authorization: auth } : {}, body: JSON.stringify(body) }) } as any);
  it('rejects a missing or wrong secret', async () => {
    expect((await call(null, {})).status).toBe(401);
    expect((await call('Bearer nope', {})).status).toBe(401);
  });
  it('rejects a malformed period', async () => {
    expect((await call('Bearer cron-secret', { period: '2026-13' })).status).toBe(400);
  });
  it('honours dry_run', async () => {
    const r = await call('Bearer cron-secret', { period: '2026-09', dry_run: true });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, dry_run: true, period: '2026-09' });
    expect(emails).toHaveLength(0);
  });
});
