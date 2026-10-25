// Admin-triggered transactional emails: info request, rejection, welcome/invite, order shipped.

import { button, escapeHtml, shell, type EmailMessage, type OrderEmailData } from './email';
import { appBaseUrl, type Env } from './env';

type Tpl = Pick<EmailMessage, 'subject' | 'html'>;
const first = (name: string) => name.trim().split(/\s+/)[0] || 'there';
const para = (s: string) => escapeHtml(s).replace(/\n/g, '<br>');

export function infoRequestEmail(env: Partial<Env>, name: string, message: string, magicToken: string): Tpl {
  const url = `${appBaseUrl(env)}/get-started/resume?token=${encodeURIComponent(magicToken)}`;
  return {
    subject: 'We need a little more information for your Rackd application',
    html: shell(`Hi ${first(name)}, one more thing`, `<p>Our team reviewed your application and needs the following before we can continue:</p>
<blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #e0293d;background:#0c0d0f">${para(message)}</blockquote>
<p>Use the button to open your application, upload what we asked for, and let us know you are done.</p>${button(url, 'Open my application')}`),
  };
}

export function rejectionEmail(name: string, reason: string): Tpl {
  return {
    subject: 'An update on your Rackd application',
    html: shell(`Hi ${first(name)}`, `<p>Thank you for applying. We are not able to approve your application at this time.</p>
<blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #9a9da3;background:#0c0d0f">${para(reason)}</blockquote>
<p>If you think this is a mistake, or your situation changes, reply to this email or write to support@r4ckd.net.</p>`),
  };
}

export function welcomeEmail(env: Partial<Env>, name: string, businessName: string, licenseKey: string, inviteToken: string): Tpl {
  const url = `${appBaseUrl(env)}/get-started/activate?token=${encodeURIComponent(inviteToken)}`;
  return {
    subject: `${businessName} is approved on Rackd`,
    html: shell(`Welcome to Rackd, ${first(name)}`, `<p><strong>${escapeHtml(businessName)}</strong> has been approved. Create your password to finish setting up your account. The link works once and expires in 14 days.</p>
${button(url, 'Create my password')}
<p style="margin-top:20px">Your business activation key (keep it private, you will enter it when you set up a register):</p>
<p style="font-size:20px;letter-spacing:1px;font-weight:700;background:#0c0d0f;padding:10px 14px;border-radius:8px">${escapeHtml(licenseKey)}</p>
<p style="font-size:13px;color:#9a9da3">Your online storefront stays switched off until you publish it. Nothing goes live without you.</p>`),
  };
}

export function shippedEmail(env: Partial<Env>, o: OrderEmailData, carrier: string | null, tracking: string, orderToken: string): Tpl {
  const url = `${appBaseUrl(env)}/hardware/order/${o.id}#t=${orderToken}`;
  const test = o.is_test ? '<p style="background:#3a1016;border:1px solid #b01d2e;border-radius:8px;padding:10px;font-size:13px"><strong>TEST ORDER.</strong> Nothing was actually shipped.</p>' : '';
  return {
    subject: `${o.is_test ? '[TEST] ' : ''}Your Rackd order ${o.order_number} has shipped`,
    html: shell('Your order is on its way', `${test}<p>Order <strong>${escapeHtml(o.order_number)}</strong> has shipped.</p>
<p style="background:#0c0d0f;padding:10px 14px;border-radius:8px">${carrier ? escapeHtml(carrier) + ' · ' : ''}Tracking: <strong>${escapeHtml(tracking)}</strong></p>${button(url, 'View your order')}`),
  };
}

// ---------------------------------------------------------------- permit expiry reminders
export interface ReminderItem {
  location: string;
  kind: string;
  number: string | null;
  expiry: string;
  daysLeft: number;
}

const PERMIT_LABEL: Record<string, string> = {
  tx_ecig: 'Texas E-Cigarette Retailer Permit',
  tobacco: 'Tobacco / cigarette permit',
  sales_tax: 'Sales tax permit',
  tabc: 'TABC permit',
};

const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

export function permitReminderEmail(env: Partial<Env>, name: string, bucket: 30 | 7, items: ReminderItem[]): Tpl {
  const rows = items.map((i) => {
    const when = i.daysLeft <= 0 ? 'expires today' : i.daysLeft === 1 ? 'expires tomorrow' : `expires in ${i.daysLeft} days`;
    return `<tr><td style="padding:8px 0;border-top:1px solid #333"><strong>${escapeHtml(PERMIT_LABEL[i.kind] ?? i.kind)}</strong>${i.number ? ` #${escapeHtml(i.number)}` : ''}<br>
<span style="color:#9a9da3">${escapeHtml(i.location)}</span></td><td align="right" style="padding:8px 0;border-top:1px solid #333;white-space:nowrap">${escapeHtml(longDate(i.expiry))}<br><span style="color:${bucket === 7 ? '#e0293d' : '#9a9da3'}">${when}</span></td></tr>`;
  }).join('');
  return {
    subject: bucket === 7
      ? `Action needed: ${items.length === 1 ? 'a permit expires' : 'permits expire'} within 7 days`
      : `Reminder: ${items.length === 1 ? 'a permit expires' : 'permits expire'} within 30 days`,
    html: shell(`Hi ${first(name)}, a permit is expiring`, `<p>${bucket === 7 ? 'This is your final reminder.' : 'This is an early reminder.'} Please renew with the issuing agency and send us the new certificate by replying to this email.</p>
<table role="presentation" width="100%" style="font-size:14px;border-collapse:collapse">${rows}</table>
<p style="font-size:13px;color:#9a9da3;margin-top:16px">Selling age-restricted products with an expired permit can put your business at risk, and Rackd may pause online ordering for a location whose permits have lapsed. This is a reminder only; keeping your permits current is your responsibility. We send this once at 30 days and once at 7 days.</p>
<p style="font-size:12px;color:#9a9da3">${escapeHtml(appBaseUrl(env))}</p>`),
  };
}
