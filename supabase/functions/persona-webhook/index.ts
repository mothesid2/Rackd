

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

async function verifySignature(raw: string, header: string | null, secret: string): Promise<boolean> {
  if (!header) return false;
  const parts: Record<string, string> = {};
  for (const kv of header.split(',')) { const [k, v] = kv.split('='); parts[k?.trim()] = v?.trim(); }
  const t = parts['t']; const v1 = parts['v1'];
  if (!t || !v1) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${raw}`));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return hex === v1;
}

Deno.serve(async (req: Request) => {
  const secret = Deno.env.get('PERSONA_WEBHOOK_SECRET');
  if (!secret) return new Response('not configured', { status: 500 });
  const raw = await req.text();
  if (!(await verifySignature(raw, req.headers.get('Persona-Signature'), secret))) {
    return new Response('bad signature', { status: 400 });
  }

  let event: Record<string, unknown>;
  try { event = JSON.parse(raw); } catch { return new Response('bad json', { status: 400 }); }

  
  
  
  const d: any = event;
  const name: string = d?.data?.attributes?.name || '';
  const inquiry = d?.data?.attributes?.payload?.data;
  const attrs = inquiry?.attributes || {};
  const status: string = attrs['status'] || '';
  const referenceId: string = attrs['reference-id'] || attrs['reference_id'] || '';
  const inquiryId: string = inquiry?.id || '';

  const isApproved = /inquiry\.(completed|approved)/.test(name) && /(completed|approved)/.test(status);
  if (isApproved && referenceId) {
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    await admin.from('storefront_customers').update({
      age_verified: true, age_verified_at: new Date().toISOString(),
      age_verification_vendor: 'persona', age_verification_ref: inquiryId,
    }).eq('id', referenceId);
  }

  return new Response('ok', { status: 200 });
});
