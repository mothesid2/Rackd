import { adminPost, uuidOf } from '../../_lib/admin';
import { decryptEin } from '../../_lib/crypto';
import { requireEnv } from '../../_lib/env';
import { HttpError } from '../../_lib/http';
import { restSelect, rpc } from '../../_lib/supabase';

/**
 * Decrypts the business EIN for a platform admin. The plaintext is returned once, never cached or logged,
 * and every reveal is written to the audit log. The ciphertext columns are not readable by any client role.
 */
export const onRequestPost = adminPost(async ({ env, body, adminId }) => {
  requireEnv(env, ['EIN_ENCRYPTION_KEY']);
  const id = uuidOf(body, 'application_id');
  const rows = await restSelect<{ ein_ciphertext: string | null; ein_iv: string | null }[]>(
    env, 'onboarding_applications', `select=ein_ciphertext,ein_iv&id=eq.${id}`);
  const r = rows[0];
  if (!r) throw new HttpError(404, 'not_found');
  if (!r.ein_ciphertext || !r.ein_iv) throw new HttpError(404, 'ein_not_set');
  const ein = await decryptEin({ ciphertext: r.ein_ciphertext, iv: r.ein_iv }, env.EIN_ENCRYPTION_KEY, id);
  await rpc(env, 'write_audit', {
    p_action: 'ein.reveal', p_entity: 'onboarding_applications', p_entity_id: id, p_before: null, p_after: null, p_actor: adminId,
  });
  return { ein };
});
