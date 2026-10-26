import { encryptEin, normalizeEin } from '../../_lib/crypto';
import { requireEnv } from '../../_lib/env';
import { guardPublic } from '../../_lib/guard';
import { HttpError } from '../../_lib/http';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, tokenOf } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';
import type { Draft } from '../../../lib/onboarding/types';

/**
 * Autosave. Any subset of { patch, ein, locations, owners }.
 * The plaintext EIN exists only inside this request: it is encrypted here and never echoed or logged.
 */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  const token = tokenOf(body);
  await guardPublic(request, env, body, { bucket: 'save', limit: LIMITS.save });

  const { patch, ein, locations, owners } = body as {
    patch?: unknown; ein?: unknown; locations?: unknown; owners?: unknown;
  };
  if (patch !== undefined && (typeof patch !== 'object' || patch === null || Array.isArray(patch))) throw new HttpError(400, 'patch_invalid');
  if (locations !== undefined && !Array.isArray(locations)) throw new HttpError(400, 'locations_invalid');
  if (owners !== undefined && !Array.isArray(owners)) throw new HttpError(400, 'owners_invalid');

  if (patch) await rpc(env, 'app_save', { p_token: token, p_patch: patch });
  if (locations) await rpc(env, 'app_save_locations', { p_token: token, p_locations: locations });
  if (owners) await rpc(env, 'app_save_owners', { p_token: token, p_owners: owners });

  if (typeof ein === 'string' && ein.trim() !== '') {
    const digits = normalizeEin(ein);
    if (!digits) throw new HttpError(400, 'invalid_ein');
    requireEnv(env, ['EIN_ENCRYPTION_KEY']);
    // The application id is the AAD, so the ciphertext only decrypts for this exact row.
    const draft = await rpc<Draft>(env, 'app_get', { p_token: token });
    const enc = await encryptEin(digits, env.EIN_ENCRYPTION_KEY, draft.application.id);
    await rpc(env, 'app_set_ein', { p_token: token, p_ciphertext: enc.ciphertext, p_iv: enc.iv, p_last4: enc.last4 });
  }
  return { ok: true, saved_at: new Date().toISOString() };
});
