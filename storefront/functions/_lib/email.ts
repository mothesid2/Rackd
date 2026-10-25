// Resend wrapper plus the first transactional templates (verification code, resume link).
// Email bodies and recipient addresses are never logged.

import type { Env } from './env';
import { appBaseUrl } from './env';
import { safeLog } from './redact';
import type { FetchLike } from './supabase';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export interface SendResult {
  sent: boolean;
  id?: string;
  reason?: 'no_api_key' | 'invalid_message' | 'provider_error' | 'network_error';
}

const EMAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function stripTags(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export async function sendEmail(env: Partial<Env>, msg: EmailMessage, fetchImpl: FetchLike = fetch): Promise<SendResult> {
  if (!EMAIL_RE.test(msg.to) || /[\r\n]/.test(msg.subject) || msg.subject.trim() === '') {
    return { sent: false, reason: 'invalid_message' };
  }
  if (!env.RESEND_API_KEY) {
    safeLog('warn', 'RESEND_API_KEY not set; email skipped');
    return { sent: false, reason: 'no_api_key' };
  }
  try {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: env.RESEND_FROM || 'Rackd <onboarding@resend.dev>',
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text ?? stripTags(msg.html),
      }),
    });
    if (!res.ok) {
      safeLog('error', 'resend rejected email', { status: res.status });
      return { sent: false, reason: 'provider_error' };
    }
    const data = (await res.json().catch(() => ({}))) as { id?: string };
    return { sent: true, id: data.id };
  } catch {
    safeLog('error', 'resend request failed');
    return { sent: false, reason: 'network_error' };
  }
}

// ---------------------------------------------------------------- templates
function shell(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#0c0d0f;font-family:system-ui,sans-serif;color:#f1efec">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" style="max-width:520px;background:#17181b;border-radius:12px;padding:28px">
<tr><td><div style="font-size:20px;font-weight:700;color:#e0293d;margin-bottom:12px">Rackd</div>
<h1 style="font-size:20px;margin:0 0 12px">${escapeHtml(title)}</h1>${bodyHtml}
<p style="font-size:12px;color:#9a9da3;margin-top:24px">If you did not request this, you can ignore this email.</p>
</td></tr></table></td></tr></table></body></html>`;
}

function button(url: string, label: string): string {
  return `<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#b01d2e;color:#fff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600">${escapeHtml(label)}</a></p>
<p style="font-size:12px;color:#9a9da3;word-break:break-all">${escapeHtml(url)}</p>`;
}

export function verificationCodeEmail(code: string): Pick<EmailMessage, 'subject' | 'html'> {
  return {
    subject: 'Your Rackd verification code',
    html: shell('Verify your email', `<p>Enter this code to continue your application:</p>
<p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:16px 0">${escapeHtml(code)}</p>
<p style="color:#9a9da3">It expires in 15 minutes.</p>`),
  };
}

export function resumeLinkEmail(env: Partial<Env>, name: string, magicToken: string): Pick<EmailMessage, 'subject' | 'html'> {
  const url = `${appBaseUrl(env)}/get-started/resume?token=${encodeURIComponent(magicToken)}`;
  return {
    subject: 'Continue your Rackd application',
    html: shell(`Welcome back, ${name.split(' ')[0] || 'there'}`, `<p>Pick up where you left off. This link works once and expires in 7 days.</p>${button(url, 'Continue application')}`),
  };
}

// ---------------------------------------------------------------- hardware order emails
const usd = (c: number) => (c / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

export interface OrderEmailData {
  id: string;
  order_number: string;
  is_test: boolean;
  items: { name: string; unit_price_cents: number; quantity: number }[];
  discount_cents: number; shipping_cents: number; tax_cents: number; total_cents: number;
  address: { full_name: string; line1: string; line2?: string | null; city: string; state: string; zip: string };
}

function orderTable(o: OrderEmailData): string {
  const row = (a: string, b: string, bold = false) =>
    `<tr><td style="padding:4px 0;${bold ? 'font-weight:700;border-top:1px solid #333' : ''}">${a}</td><td align="right" style="padding:4px 0;${bold ? 'font-weight:700;border-top:1px solid #333' : ''}">${b}</td></tr>`;
  return `<table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse">
${o.items.map((i) => row(`${i.quantity} × ${escapeHtml(i.name)}`, usd(i.unit_price_cents * i.quantity))).join('')}
${o.discount_cents > 0 ? row('Bundle discount', `−${usd(o.discount_cents)}`) : ''}
${row('Shipping', usd(o.shipping_cents))}${row('Sales tax', usd(o.tax_cents))}${row('Total', usd(o.total_cents), true)}</table>`;
}

export function orderConfirmationEmail(env: Partial<Env>, o: OrderEmailData, emailToken: string): Pick<EmailMessage, 'subject' | 'html'> {
  const url = `${appBaseUrl(env)}/hardware/order/${o.id}#t=${emailToken}`;
  const a = o.address;
  const test = o.is_test ? `<p style="background:#3a1016;border:1px solid #b01d2e;border-radius:8px;padding:10px;font-size:13px"><strong>TEST ORDER.</strong> No real payment was taken and nothing will ship.</p>` : '';
  return {
    subject: `${o.is_test ? '[TEST] ' : ''}Rackd order ${o.order_number} confirmed`,
    html: shell(`Thanks, we got your order`, `${test}<p>Order <strong>${escapeHtml(o.order_number)}</strong> is paid. We will email you again when it ships.</p>${orderTable(o)}
<p style="font-size:13px;color:#9a9da3;margin-top:16px">Shipping to ${escapeHtml(a.full_name)}, ${escapeHtml(a.line1)}${a.line2 ? ', ' + escapeHtml(a.line2) : ''}, ${escapeHtml(a.city)}, ${escapeHtml(a.state)} ${escapeHtml(a.zip)}</p>${button(url, 'View your order')}`),
  };
}

export function adminOrderEmail(o: { order_number: string; total_cents: number; is_test: boolean }, notes: string[]): Pick<EmailMessage, 'subject' | 'html'> {
  return {
    subject: `${o.is_test ? '[TEST] ' : ''}Hardware order ${o.order_number} paid (${usd(o.total_cents)})`,
    html: shell('Hardware order paid', `<p>Order <strong>${escapeHtml(o.order_number)}</strong> was paid.${o.is_test ? ' (Stripe test mode.)' : ''}</p>${notes.length ? `<ul>${notes.map((n) => `<li>${escapeHtml(n)}</li>`).join('')}</ul>` : ''}<p>Open it in the admin console to fulfil.</p>`),
  };
}
