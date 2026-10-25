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
