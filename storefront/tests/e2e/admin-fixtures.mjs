// Fixtures for the /admin console in the local mock server (Supabase REST + /api/admin). UI checks only.
export const ADMIN_ID = 'aaaaaaaa-1111-1111-1111-111111111111';
export const A1 = '5b7e2f0a-1111-4222-8333-444455556666';
export const A2 = '6c8f3a1b-2222-4333-8444-555566667777';
const iso = (d) => new Date(Date.now() + d * 864e5).toISOString();
const day = (d) => iso(d).slice(0, 10);

export const adminTables = {
  onboarding_applications: [
    { id: A1, status: 'submitted', full_name: 'Alice Applicant', email: 'alice@acme.co', email_verified_at: iso(-3), phone: '5125550100', contact_role: 'owner', legal_name: 'Acme Vapes LLC', dba: 'Acme', entity_type: 'llc', ein_last4: '6789', years_in_business: 3, business_email: 'biz@acme.co', business_phone: '5125550101', website: 'acme.co', mailing_address: { street: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' }, location_count: 1, operations: { current_pos: 'Square', registers: 2, employees: 4, product_mix: ['vape', 'glass'], card_pct: 70, avg_ticket: 24 }, plan_model: 'model_a', addons: ['sms_marketing'], hardware_selection: { mode: 'bundle', bundle_slug: 'full-pos-bundle' }, compliance_ack_at: iso(-3), compliance_ack_version: 'ack-2026-10-1:abc', kyc_status: 'not_started', info_request: null, reject_reason: null, submitted_at: iso(-2), reviewed_at: null, provisioned_tenant_id: null, created_at: iso(-4) },
    { id: A2, status: 'needs_info', full_name: 'Bob Builder', email: 'bob@vapor.co', plan_model: 'model_b', legal_name: 'Vapor Hut Inc', submitted_at: iso(-9), created_at: iso(-10), location_count: 2, info_request: 'Please upload a clearer tax permit.' },
    { id: 'c3', status: 'approved', full_name: 'Cara', email: 'cara@x.co', plan_model: 'model_a', legal_name: 'Cloud Nine LLC', submitted_at: iso(-20), created_at: iso(-21), location_count: 1 },
  ],
  onboarding_locations: [{ id: 'L1', application_id: A1, name: 'Main St', street: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', phone: '5125550102', sort_order: 1 }],
  onboarding_licenses: [
    { id: 'x1', application_id: A1, location_id: 'L1', kind: 'tx_ecig', number: 'EC-1', expiry: day(12), document_id: 'D1' },
    { id: 'x2', application_id: A1, location_id: 'L1', kind: 'sales_tax', number: 'ST-1', expiry: null, document_id: 'D2' },
    { id: 'x3', application_id: A2, location_id: 'L9', kind: 'tx_ecig', number: 'EC-9', expiry: day(-40), document_id: null },
  ],
  onboarding_owners: [{ id: 'O1', application_id: A1, full_name: 'Alice Applicant', title: 'Owner', ownership_pct: 100, is_control_person: true, id_document_id: 'D3', created_at: iso(-4) }],
  onboarding_documents: [
    { id: 'D1', application_id: A1, kind: 'license_tx_ecig', original_name: 'ecig-permit.pdf', mime: 'application/pdf', size_bytes: 204800, scan_status: 'skipped', uploaded_at: iso(-3) },
    { id: 'D2', application_id: A1, kind: 'license_sales_tax', original_name: 'sales-tax.pdf', mime: 'application/pdf', size_bytes: 102400, scan_status: 'skipped', uploaded_at: iso(-3) },
    { id: 'D3', application_id: A1, kind: 'owner_id', original_name: 'license.jpg', mime: 'image/jpeg', size_bytes: 512000, scan_status: 'skipped', uploaded_at: iso(-3) },
  ],
  agreement_signatures: [{ application_id: A1, typed_name: 'Alice Applicant', signed_on: day(-3), signed_at: iso(-3), ip: '203.0.113.9', user_agent: 'Mozilla/5.0', agreement_versions: { kind: 'terms_of_service', version: '2026-10-draft-1', body_sha256: 'a'.repeat(64) } }],
  sms_consents: [{ application_id: A1, consented: false, consent_text_version: 'sms-2026-10-1', consent_text_sha256: 'b'.repeat(64), ip: '203.0.113.9', created_at: iso(-3) }],
  application_events: [{ id: 1, application_id: A1, type: 'created', actor: 'applicant', detail: null, created_at: iso(-4) }, { id: 2, application_id: A1, type: 'submitted', actor: 'applicant', detail: { message: 'Application received.' }, created_at: iso(-2) }],
  application_notes: [{ id: 'n1', application_id: A1, body: 'Called the store, owner confirmed hours.', author: ADMIN_ID, created_at: iso(-1) }],
  provision_runs: [],
  hardware_orders: [
    { id: 'o1', order_number: 'HW-1001', status: 'paid', email: 'buyer@test.dev', total_cents: 158246, subtotal_cents: 154800, discount_cents: 10000, shipping_cents: 1500, tax_cents: 11946, is_test: true, created_at: iso(-1), paid_at: iso(-1), tenant_id: null, application_id: A1, shipping_address_id: 'sa1', stripe_payment_intent: 'pi_123', shipping_method: 'ground', carrier: null, tracking_number: null, shipped_at: null, refund_note: null, notes: 'Please call before delivery.' },
    { id: 'o2', order_number: 'HW-1002', status: 'shipped', email: 'late@test.dev', total_cents: 8900, is_test: false, created_at: iso(-6), tenant_id: null, application_id: null },
  ],
  hardware_order_items: [{ id: 'i1', order_id: 'o1', name_snapshot: 'Full POS Station', sku_snapshot: 'POS-FULL', unit_price_cents: 129900, quantity: 1 }, { id: 'i2', order_id: 'o1', name_snapshot: 'Payment terminal (VP100)', sku_snapshot: 'ACC-VP100', unit_price_cents: 24900, quantity: 1 }],
  shipping_addresses: [{ id: 'sa1', full_name: 'Pat Shopkeeper', line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701', phone: '5125550123' }],
  audit_log: [
    { id: 3, actor: ADMIN_ID, action: 'app_config.update', entity: 'app_config', entity_id: 'online_fee', before: { key: 'online_fee', value: { type: 'percent', value: 5 } }, after: { key: 'online_fee', value: { type: 'flat', value: 250 } }, created_at: iso(0) },
    { id: 2, actor: ADMIN_ID, action: 'ein.reveal', entity: 'onboarding_applications', entity_id: A1, before: null, after: null, created_at: iso(-1) },
    { id: 1, actor: null, action: 'hardware_order.paid', entity: 'hardware_orders', entity_id: 'o1', before: { status: 'pending' }, after: { status: 'paid' }, created_at: iso(-1) },
  ],
};

/** Returns true when the table is an admin fixture and the response was written. */
export function adminRest(table, url, req, res, { json, config, products, bundles }) {
  let rows = adminTables[table];
  if (table === 'app_config') rows = config;
  if (table === 'hardware_products') rows = products.map((p) => ({ ...p, is_active: true }));
  if (table === 'hardware_bundles') rows = bundles.map((b) => ({ ...b, id: b.slug, is_active: true }));
  if (!rows) return false;
  const eq = (k) => (url.searchParams.get(k) || '').replace(/^eq\./, '');
  const f = rows.filter((r) => ['id', 'application_id', 'order_id'].every((k) => !url.searchParams.get(k) || String(r[k]) === eq(k)));
  if ((req.headers.accept || '').includes('pgrst.object')) {
    if (!f[0]) { res.writeHead(406, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 'PGRST116', message: 'no rows' })); return true; }
    json(res, f[0]);
    return true;
  }
  json(res, f);
  return true;
}

export function adminApi(name, json, res) {
  switch (name) {
    case 'file-url': return json(res, { url: 'about:blank', name: 'permit.pdf', mime: 'application/pdf', scan_status: 'skipped' });
    case 'reveal-ein': return json(res, { ein: '12-3456789' });
    case 'application-status': return json(res, { ok: true, emailed: true });
    case 'approve': return json(res, { tenant_id: 't1', license_key: 'RACKD-ABCD-EFGH-JKLM', plan_type: 'model_a', features: ['web_store', 'sms_marketing'], locations: [{ id: 'x', name: 'Main St' }], owner_email: 'alice@acme.co', already_provisioned: false, emailed: true });
    case 'order-action': return json(res, { ok: true, emailed: true });
    default: return json(res, { error: 'not_found' }, 404);
  }
}
