import { adminPost, uuidOf } from '../../_lib/admin';
import { sendEmail, type OrderEmailData } from '../../_lib/email';
import { shippedEmail } from '../../_lib/emailTemplates';
import { orderLinkSecret } from '../../_lib/env';
import { HttpError } from '../../_lib/http';
import { rpc } from '../../_lib/supabase';
import { orderEmailToken, sha256Hex } from '../../_lib/token';

const ACTIONS = ['fulfilled', 'shipped', 'cancelled', 'note'];

/**
 * Hardware order actions: mark fulfilled, mark shipped (tracking required, emails the customer), cancel
 * (paid orders need a note and are restocked; the refund itself is done in Stripe), and add a manual
 * refund note. State rules and the audit trail live in the database.
 */
export const onRequestPost = adminPost(async ({ env, body, adminId }) => {
  const id = uuidOf(body, 'order_id');
  const action = typeof body.action === 'string' ? body.action : '';
  if (!ACTIONS.includes(action)) throw new HttpError(400, 'action_invalid');
  const note = typeof body.note === 'string' ? body.note.trim().slice(0, 500) : '';
  const carrier = typeof body.carrier === 'string' ? body.carrier.trim().slice(0, 60) : '';
  const tracking = typeof body.tracking === 'string' ? body.tracking.trim().slice(0, 120) : '';

  if (action === 'note') {
    await rpc(env, 'hw_admin_note', { p_order: id, p_note: note, p_actor: adminId });
    return { ok: true };
  }
  // resolve the link secret first: a config error must not leave an order shipped with no customer email
  const linkSecret = action === 'shipped' ? orderLinkSecret(env) : '';
  const r = await rpc<{ order_number: string; email: string; is_test: boolean }>(env, 'hw_admin_transition', {
    p_order: id, p_to: action, p_carrier: carrier || null, p_tracking: tracking || null, p_note: note || null, p_actor: adminId,
  });

  let emailed = false;
  if (action === 'shipped') {
    const token = await orderEmailToken(linkSecret, id);
    const hash = await sha256Hex(token);
    await rpc(env, 'hw_issue_email_token', { p_order: id, p_hash: hash });
    const order = await rpc<OrderEmailData>(env, 'hw_get_order', { p_id: id, p_token_hash: hash });
    emailed = (await sendEmail(env, { to: r.email, ...shippedEmail(env, order, carrier || null, tracking, token) })).sent;
  }
  return { ok: true, emailed };
});
