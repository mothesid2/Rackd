import { adminPost, uuidOf } from '../../_lib/admin';
import { sendEmail } from '../../_lib/email';
import { welcomeEmail } from '../../_lib/emailTemplates';
import { restSelect, rpc } from '../../_lib/supabase';

/** Mints a fresh activation link (old links stop working) and emails it. Only for owners who have not activated. */
export const onRequestPost = adminPost(async ({ env, body, adminId }) => {
  const id = uuidOf(body, 'application_id');
  const inv = await rpc<{ email: string; full_name: string; invite_token: string; license_key: string }>(env, 'onb_reissue_invite', { p_app: id, p_actor: adminId });
  const biz = (await restSelect<{ legal_name: string | null }[]>(env, 'onboarding_applications', `select=legal_name&id=eq.${id}`))[0];
  const mail = await sendEmail(env, { to: inv.email, ...welcomeEmail(env, inv.full_name, biz?.legal_name ?? 'Your business', inv.license_key, inv.invite_token) });
  return { ok: true, emailed: mail.sent };
});
