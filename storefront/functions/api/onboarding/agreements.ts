import {
  agreementText, COMPLIANCE_TEXT, COMPLIANCE_VERSION, MERCHANT_AGREEMENT, SMS_CONSENT_TEXT, SMS_CONSENT_VERSION, TERMS_OF_SERVICE,
} from '../../../lib/onboarding/legal';
import { guardPublic } from '../../_lib/guard';
import { HttpError } from '../../_lib/http';
import { LIMITS } from '../../_lib/rateLimit';
import { postJson, str, tokenOf } from '../../_lib/route';
import { rpc } from '../../_lib/supabase';
import { clientIp, sha256Hex } from '../../_lib/token';

/**
 * Records the e-signature: typed name, server date, IP and user agent, plus the exact document
 * versions (by SHA-256 of the text) and, separately, the SMS consent decision.
 */
export const onRequestPost = postJson(async ({ request, env, body }) => {
  const token = tokenOf(body);
  await guardPublic(request, env, body, { bucket: 'agreements', limit: LIMITS.save });
  const typedName = str(body, 'typed_name', { min: 2, max: 120 });
  if (body.agree !== true) throw new HttpError(400, 'agree_required');
  if (body.compliance_ack !== true) throw new HttpError(400, 'compliance_ack_required');
  const smsConsent = body.sms_consent === true; // anything but literal true means "no"

  const [tos, merchant] = await Promise.all([TERMS_OF_SERVICE, MERCHANT_AGREEMENT].map(async (d) =>
    rpc<string>(env, 'onb_ensure_agreement', { p_kind: d.kind, p_version: d.version, p_sha256: await sha256Hex(agreementText(d)) })));

  await rpc(env, 'app_record_agreements', {
    p_token: token,
    p_tos_version: tos,
    p_merchant_version: merchant,
    p_typed_name: typedName,
    p_sms_consented: smsConsent,
    p_sms_text_version: SMS_CONSENT_VERSION,
    p_sms_text_sha256: await sha256Hex(SMS_CONSENT_TEXT),
    p_compliance_ack: true,
    p_compliance_version: `${COMPLIANCE_VERSION}:${(await sha256Hex(COMPLIANCE_TEXT)).slice(0, 16)}`,
    p_ip: clientIp(request),
    p_user_agent: request.headers.get('User-Agent') ?? '',
  });
  return { ok: true };
});
