import { isAllowedMime, MAX_UPLOAD_BYTES, recordScan, scanUploadedFile, sniffMime } from '../../_lib/files';
import { guardPublic } from '../../_lib/guard';
import { HttpError } from '../../_lib/http';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, str, tokenOf } from '../../_lib/route';
import { deleteObject, probeObject, rpc } from '../../_lib/supabase';
import type { Draft } from '../../../lib/onboarding/types';

const KINDS = ['license_tx_ecig', 'license_tobacco', 'license_sales_tax', 'license_tabc', 'owner_id', 'requested_info'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** After the browser uploads, verify what actually landed in storage, then record it. */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  const token = tokenOf(body);
  await guardPublic(request, env, body, { bucket: 'register-document', limit: LIMITS.upload });

  const kind = str(body, 'kind', { max: 40 });
  const path = str(body, 'path', { max: 200 });
  const originalName = str(body, 'original_name', { optional: true, max: 200 });
  const locationId = typeof body.location_id === 'string' && UUID.test(body.location_id) ? body.location_id : null;
  const ownerId = typeof body.owner_id === 'string' && UUID.test(body.owner_id) ? body.owner_id : null;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'document_kind_invalid');

  const draft = await rpc<Draft>(env, 'app_get', { p_token: token });
  if (!path.startsWith(`${draft.application.id}/`) || path.includes('..')) throw new HttpError(403, 'forbidden');

  const probe = await probeObject(env, path);
  if (!probe) throw new HttpError(400, 'upload_missing');
  const mime = sniffMime(probe.head);
  if (!mime || !isAllowedMime(mime) || probe.size > MAX_UPLOAD_BYTES || probe.size <= 0) {
    await deleteObject(env, path);
    throw new HttpError(400, 'file_rejected');
  }

  const documentId = await rpc<string>(env, 'app_register_document', {
    p_token: token, p_kind: kind, p_location_id: locationId, p_owner_id: ownerId,
    p_storage_path: path, p_original_name: originalName, p_mime: mime, p_size: probe.size,
  });

  const scan = await scanUploadedFile(env, path);
  await recordScan(env, documentId, scan);
  if (scan === 'infected') {
    await deleteObject(env, path);
    throw new HttpError(400, 'file_rejected');
  }
  return { document_id: documentId, scan_status: scan };
});
