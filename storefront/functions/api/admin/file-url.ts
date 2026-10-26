import { adminPost, uuidOf } from '../../_lib/admin';
import { HttpError } from '../../_lib/http';
import { createSignedDownload, restSelect, rpc } from '../../_lib/supabase';

/** Short-lived (60 s) signed link to one uploaded license or ID. Every view is audit-logged. */
export const onRequestPost = adminPost(async ({ env, body, adminId }) => {
  const id = uuidOf(body, 'document_id');
  const rows = await restSelect<{ storage_path: string; scan_status: string; original_name: string | null; mime: string; application_id: string; kind: string }[]>(
    env, 'onboarding_documents', `select=storage_path,scan_status,original_name,mime,application_id,kind&id=eq.${id}`);
  const d = rows[0];
  if (!d) throw new HttpError(404, 'not_found');
  if (d.scan_status === 'infected') throw new HttpError(409, 'file_infected');
  const url = await createSignedDownload(env, d.storage_path, 60);
  await rpc(env, 'write_audit', {
    p_action: 'document.view', p_entity: 'onboarding_documents', p_entity_id: id, p_before: null,
    p_after: { application_id: d.application_id, kind: d.kind }, p_actor: adminId,
  });
  return { url, name: d.original_name, mime: d.mime, scan_status: d.scan_status };
});
