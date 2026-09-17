

export async function sendSms(to: string | null | undefined, body: string): Promise<boolean> {
  const sid = Deno.env.get('TWILIO_ACCOUNT_SID');
  const token = Deno.env.get('TWILIO_AUTH_TOKEN');
  const from = Deno.env.get('TWILIO_FROM');
  if (!sid || !token || !from || !to) return false;
  try {
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + btoa(`${sid}:${token}`), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: to, From: from, Body: body }),
    });
    return r.ok;
  } catch {
    return false;
  }
}


export async function sendEmail(
  to: string | null | undefined,
  subject: string,
  html: string,
  text?: string,
): Promise<boolean> {
  const key = Deno.env.get('RESEND_API_KEY');
  const from = Deno.env.get('RESEND_FROM') || 'Rackd <onboarding@resend.dev>';
  if (!key || !to) {
    if (!key) console.warn('[sendEmail] RESEND_API_KEY not set — email skipped');
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, subject, html, text: text || html.replace(/<[^>]+>/g, ' ') }),
    });
    if (!r.ok) {
      console.error('[sendEmail] Resend error', r.status, await r.text().catch(() => ''));
      return false;
    }
    return true;
  } catch (e) {
    console.error('[sendEmail] threw', String(e));
    return false;
  }
}


export function emailShell(heading: string, bodyHtml: string): string {
  return `<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#1c1f24">
    <div style="font-size:22px;font-weight:800;letter-spacing:3px;margin-bottom:16px">RACK<span style="color:#b01d2e">D</span></div>
    <h1 style="font-size:20px;margin:0 0 12px">${heading}</h1>
    ${bodyHtml}
    <p style="font-size:12px;color:#8a9099;margin-top:24px;border-top:1px solid #eee;padding-top:12px">Bring a valid government photo ID (21+) to pick up your order.</p>
  </div>`;
}

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, apikey',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}
