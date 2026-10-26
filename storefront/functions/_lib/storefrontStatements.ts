// Monthly reservation-fee statements: build (idempotent, via sf_build_statement), render PDF + CSV, email the owner.
// Nothing here charges anyone. An optional Stripe Invoice for Rackd's own fee is gated by STRIPE_LIVE_ENABLED and is
// not implemented yet: statements are paid out of band and the Owner Console marks them paid.

import { escapeHtml, sendEmail, type EmailMessage } from './email';
import type { Env } from './env';
import { safeLog } from './redact';
import { restSelect, rpc, type FetchLike } from './supabase';

export interface StatementLine { code: string; location_id: string; amount: number; picked_up_at: string | null; subtotal: number }
export interface StatementResult { statement_id?: string; period: string; total: number; count: number; lines?: StatementLine[]; dry_run: boolean; already_issued?: boolean }

/** Previous calendar month as YYYY-MM (UTC), or the explicit period when given. */
export function periodFor(now: Date, explicit?: string | null): string {
  if (explicit) return explicit;
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const q = (v: unknown) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function statementCsv(r: StatementResult): string {
  const rows: unknown[][] = [['Order', 'Location', 'Picked up', 'Order subtotal', 'Reservation fee'],
    ...(r.lines ?? []).map((l) => [l.code, l.location_id, l.picked_up_at ?? '', Number(l.subtotal).toFixed(2), Number(l.amount).toFixed(2)]),
    ['', '', '', 'Total', r.total.toFixed(2)]];
  return rows.map((row) => row.map(q).join(',')).join('\r\n') + '\r\n';
}

const pdfText = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, (c) => `\\${c}`);

/** Minimal single-font text PDF (no dependencies, runs in a Worker). Paginates at 50 lines. */
export function statementPdf(business: string, r: StatementResult): Uint8Array {
  const lines = [
    `Rackd reservation fee statement`, `${business}`, `Period: ${r.period}`, '',
    `Orders: ${r.count}`, `Total due: $${r.total.toFixed(2)}`, '', 'Order      Fee      Picked up',
    ...(r.lines ?? []).map((l) => `${l.code.padEnd(10)} $${Number(l.amount).toFixed(2).padStart(7)}  ${(l.picked_up_at ?? '').slice(0, 10)}`),
  ];
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += 50) pages.push(lines.slice(i, i + 50));
  if (pages.length === 0) pages.push(['']);
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  pages.forEach((pg, i) => {
    const content = `BT /F1 10 Tf 14 TL 50 790 Td ${pg.map((l) => `(${pdfText(l)}) Tj T*`).join(' ')} ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Courier >> >> >> /Contents ${4 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

function b64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function statementEmail(business: string, r: StatementResult): Pick<EmailMessage, 'subject' | 'html'> {
  return {
    subject: `Your Rackd storefront statement for ${r.period}`,
    html: `<p>Hello,</p><p>${escapeHtml(business)}: your online storefront reservation fees for <strong>${escapeHtml(r.period)}</strong>: ` +
      `<strong>$${r.total.toFixed(2)}</strong> across ${r.count} picked-up order${r.count === 1 ? '' : 's'}.</p>` +
      `<p>The PDF and CSV are attached. Fees are billed to your Rackd account, never charged to your customers.</p>`,
  };
}

export interface StatementJobSummary { period: string; dry_run: boolean; tenants: number; issued: number; emailed: number; total: number; errors: number }

/** Builds the statement for every business with accrued fees in `period`. dryRun previews and writes nothing. */
export async function runStatements(env: Partial<Env>, opts: { period: string; dryRun?: boolean }, fetchImpl?: FetchLike): Promise<StatementJobSummary> {
  const rows = await restSelect<{ tenant_id: string }[]>(env, 'fee_ledger', `select=tenant_id&period=eq.${encodeURIComponent(opts.period)}&status=eq.accrued&limit=5000`, fetchImpl);
  const tenants = [...new Set(rows.map((r) => r.tenant_id))];
  const sum: StatementJobSummary = { period: opts.period, dry_run: !!opts.dryRun, tenants: tenants.length, issued: 0, emailed: 0, total: 0, errors: 0 };
  for (const t of tenants) {
    try {
      const r = await rpc<StatementResult>(env, 'sf_build_statement', { p_tenant: t, p_period: opts.period, p_dry_run: !!opts.dryRun }, fetchImpl);
      sum.total += Number(r.total);
      if (opts.dryRun || r.already_issued) continue;
      sum.issued++;
      const lic = await restSelect<{ contact_email: string | null }[]>(env, 'licenses', `select=contact_email&tenant_id=eq.${t}&limit=1`, fetchImpl);
      const to = lic[0]?.contact_email;
      if (!to) continue;
      const name = 'your business';
      const res = { ...r, total: Number(r.total), count: Number(r.count) };
      const mail = statementEmail(name, res);
      const sent = await sendEmail(env, { to, ...mail, attachments: [
        { filename: `rackd-statement-${opts.period}.pdf`, content: b64(statementPdf(name, res)) },
        { filename: `rackd-statement-${opts.period}.csv`, content: btoa(unescape(encodeURIComponent(statementCsv(res)))) },
      ] }, fetchImpl);
      if (sent.sent) sum.emailed++;
    } catch {
      sum.errors++;
      safeLog('error', 'statement build failed', { period: opts.period });
    }
  }
  return sum;
}
