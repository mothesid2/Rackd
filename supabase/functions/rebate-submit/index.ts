

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { dueNow, type Cadence } from './cadence.ts';
import { getFormatter, type ReportRow, type ReportContext } from './formatters/index.ts';
import { fetchCredential, sftpUpload, sha256Hex } from './sftp.ts';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function cadenceOf(m: any): Cadence {
  return { batch_end_dow: m.batch_end_dow, due_dow: m.due_dow, due_offset_weeks: m.due_offset_weeks || 1 };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);
  let body: any = {};
  try { body = await req.json(); } catch {  }

  const secret = Deno.env.get('REBATE_DISPATCH_SECRET');
  if (!secret) return json({ error: 'function not configured' }, 500);
  if (String(body?.secret || '') !== secret) return json({ error: 'unauthorized' }, 401);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  const today = new Date();

  
  const jobs: { mfr: any; period: { start: string; end: string; dueDate: string } }[] = [];
  if (body?.manufacturer_uid && body?.tenant_id) {
    const { data: m } = await admin.from('manufacturers_cloud').select('*')
      .eq('tenant_id', body.tenant_id).eq('uid', body.manufacturer_uid).maybeSingle();
    if (!m) return json({ error: 'manufacturer not found' }, 404);
    const period = (body.period_start && body.period_end)
      ? { start: body.period_start, end: body.period_end, dueDate: body.period_end }
      : dueNow(cadenceOf(m), today);
    if (!period) return json({ error: 'no period due (cadence unset?)' }, 400);
    jobs.push({ mfr: m, period });
  } else {
    const { data: mfrs, error } = await admin.from('manufacturers_cloud').select('*').eq('is_active', true);
    if (error) return json({ error: error.message }, 500);
    for (const m of mfrs ?? []) {
      const period = dueNow(cadenceOf(m), today);
      if (!period) continue;
      const { data: done } = await admin.from('manufacturer_submissions').select('id')
        .eq('tenant_id', m.tenant_id).eq('manufacturer_uid', m.uid)
        .eq('period_end', period.end).eq('status', 'success').maybeSingle();
      if (done) continue; 
      jobs.push({ mfr: m, period });
    }
  }

  const results = [];
  for (const j of jobs) results.push(await processJob(admin, j.mfr, j.period));
  return json({ ran: results.length, results });
});

async function processJob(admin: any, mfr: any, period: { start: string; end: string; dueDate: string }) {
  const ctx: ReportContext = {
    manufacturer: { uid: mfr.uid, name: mfr.name, parent_company_code: mfr.parent_company_code },
    tenant_id: mfr.tenant_id, period_start: period.start, period_end: period.end,
  };

  
  const { data: prior } = await admin.from('manufacturer_submissions').select('id, retry_count')
    .eq('tenant_id', mfr.tenant_id).eq('manufacturer_uid', mfr.uid).eq('period_end', period.end)
    .neq('status', 'success').maybeSingle();
  let subId: string;
  let retry = 0;
  if (prior) {
    subId = prior.id; retry = (prior.retry_count || 0) + 1;
    await admin.from('manufacturer_submissions').update({ status: 'pending', retry_count: retry, error: null }).eq('id', subId);
  } else {
    const { data: sub } = await admin.from('manufacturer_submissions').insert({
      tenant_id: mfr.tenant_id, manufacturer_uid: mfr.uid, period_start: period.start, period_end: period.end, status: 'pending',
    }).select('id').single();
    subId = sub!.id;
  }

  try {
    const { data: rows, error } = await admin.from('applied_rebates_cloud')
      .select('applied_at, barcode, discount_amount, is_manufacturer_funded, was_auto_applied, rebate_rule_uid, transaction_id, location_id, register_id')
      .eq('tenant_id', mfr.tenant_id).eq('manufacturer_uid', mfr.uid)
      .gte('applied_at', period.start + 'T00:00:00Z')
      .lte('applied_at', period.end + 'T23:59:59Z')
      .order('applied_at');
    if (error) throw new Error(error.message);
    const reportRows: ReportRow[] = (rows ?? []).map((r: any) => ({ ...r, discount_amount: Number(r.discount_amount) || 0 }));

    const fmt = getFormatter(mfr.parent_company_code);
    const contents = fmt.format(reportRows, ctx);
    const filename = fmt.filename(ctx);
    const hash = await sha256Hex(contents);

    const cred = await fetchCredential(admin, mfr.tenant_id, mfr.uid);
    if (!cred) throw new Error('no SFTP credentials configured for this manufacturer');
    const remote = await sftpUpload(cred, filename, contents);

    await admin.from('manufacturer_submissions').update({
      status: 'success', row_count: reportRows.length, file_hash: hash, submitted_at: new Date().toISOString(), error: null,
    }).eq('id', subId);
    return { manufacturer: mfr.name, tenant_id: mfr.tenant_id, period_end: period.end, status: 'success', rows: reportRows.length, remote };
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    await admin.from('manufacturer_submissions').update({ status: 'failed', error: msg, retry_count: retry }).eq('id', subId);
    return { manufacturer: mfr.name, tenant_id: mfr.tenant_id, period_end: period.end, status: 'failed', error: msg };
  }
}
