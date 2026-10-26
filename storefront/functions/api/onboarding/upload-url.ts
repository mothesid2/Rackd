import { EXT_FOR_MIME, isAllowedMime, MAX_UPLOAD_BYTES } from '../../_lib/files';
import { guardPublic } from '../../_lib/guard';
import { HttpError } from '../../_lib/http';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, tokenOf } from '../../_lib/route';
import { createSignedUpload, rpc } from '../../_lib/supabase';
import { randomToken } from '../../_lib/token';
import type { Draft } from '../../../lib/onboarding/types';

/**
 * Issues a signed upload token for ONE object path inside this application's folder.
 * The bucket is private; the browser can only write to the exact path it is given.
 */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  const token = tokenOf(body);
  await guardPublic(request, env, body, { bucket: 'upload-url', limit: LIMITS.upload });
  if (!isAllowedMime(body.mime)) throw new HttpError(400, 'file_type_not_allowed');
  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'file_empty');
  if (size > MAX_UPLOAD_BYTES) throw new HttpError(413, 'file_too_large');

  const draft = await rpc<Draft>(env, 'app_get', { p_token: token });
  const path = `${draft.application.id}/${randomToken(16)}.${EXT_FOR_MIME[body.mime]}`;
  const signed = await createSignedUpload(env, path);
  return { path: signed.path, upload_token: signed.token };
});
