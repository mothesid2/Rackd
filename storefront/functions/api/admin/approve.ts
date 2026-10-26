import { adminPost, uuidOf } from '../../_lib/admin';
import { sendEmail } from '../../_lib/email';
import { welcomeEmail } from '../../_lib/emailTemplates';
import { restSelect, rpc } from '../../_lib/supabase';

interface Provisioned {
  tenant_id: string;
  license_id: string;
  license_key: string;
  plan_type: string;
  features: string[];
  locations: { id: string; name: string }[];
  owner_email: string;
  owner_name: string;
  already_provisioned: boolean;
  invite_token?: string;
}

/**
 * Approve = provision. onb_provision is one database transaction, idempotent and row-locked, so a second
 * click (or a retry after a timeout) returns the stored result with already_provisioned=true and NO invite
 * token. The welcome email is therefore only ever sent by the call that actually created the business.
 */
export const onRequestPost = adminPost(async ({ env, body, adminId }) => {
  const id = uuidOf(body, 'application_id');
  const r = await rpc<Provisioned>(env, 'onb_provision', { p_app: id, p_actor: adminId });
  const { invite_token, ...safe } = r;
  if (r.already_provisioned || !invite_token) return { ...safe, emailed: false };

  const biz = (await restSelect<{ legal_name: string | null }[]>(env, 'onboarding_applications', `select=legal_name&id=eq.${id}`))[0];
  const mail = await sendEmail(env, { to: r.owner_email, ...welcomeEmail(env, r.owner_name, biz?.legal_name ?? 'Your business', r.license_key, invite_token) });
  // If the email fails, the admin uses "Resend invite" (a new link is minted); nothing is lost.
  return { ...safe, emailed: mail.sent };
});
