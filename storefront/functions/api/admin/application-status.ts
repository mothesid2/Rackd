import { adminPost, uuidOf } from '../../_lib/admin';
import { sendEmail } from '../../_lib/email';
import { infoRequestEmail, rejectionEmail } from '../../_lib/emailTemplates';
import { HttpError } from '../../_lib/http';
import { restSelect, rpc, rpcAs } from '../../_lib/supabase';

const TO = ['in_review', 'needs_info', 'rejected'];

/**
 * Review actions. The transition rules live in the database (admin_set_status) and run as the admin, so the
 * audit row carries their id. Requesting info and rejecting also email the applicant.
 */
export const onRequestPost = adminPost(async ({ env, body, jwt }) => {
  const id = uuidOf(body, 'application_id');
  const to = typeof body.to === 'string' ? body.to : '';
  if (!TO.includes(to)) throw new HttpError(400, 'status_invalid');
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (to !== 'in_review' && message.length < 10) throw new HttpError(400, 'message_required');
  if (message.length > 2000) throw new HttpError(400, 'message_too_long');

  await rpcAs(env, jwt, 'admin_set_status', { p_app: id, p_status: to, p_message: message || null });
  if (to === 'in_review') return { ok: true };

  const rows = await restSelect<{ email: string; full_name: string }[]>(env, 'onboarding_applications', `select=email,full_name&id=eq.${id}`);
  const a = rows[0];
  let emailed = false;
  if (a) {
    if (to === 'needs_info') {
      const magic = await rpc<{ magic_token: string }[]>(env, 'app_magic_issue', { p_email: a.email });
      emailed = !!magic[0] && (await sendEmail(env, { to: a.email, ...infoRequestEmail(env, a.full_name, message, magic[0].magic_token) })).sent;
    } else {
      emailed = (await sendEmail(env, { to: a.email, ...rejectionEmail(a.full_name, message) })).sent;
    }
  }
  return { ok: true, emailed };
});
