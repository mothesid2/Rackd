// Local UI test server: serves the static export from ./out and fakes /api/onboarding/* and the few
// Supabase REST/Storage calls the wizard makes, all in memory. Used for manual UI checks and the
// Playwright smoke tests. It does NOT reproduce server validation; that is covered by unit tests and
// the SQL tests. Build first with:
//   NEXT_PUBLIC_SUPABASE_URL=http://localhost:3111/sb NEXT_PUBLIC_SUPABASE_ANON_KEY=anon \
//   NEXT_PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA npx next build
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCatalog, priceCart } from '../../lib/hardware/pricing.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'out');
const PORT = Number(process.env.PORT || 3111);
const TOKEN = 'ab'.repeat(32);
const CODE = '123456';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain' };

let db = null;
const reset = () => { db = null; };

function newDraft(b) {
  return {
    application: {
      id: '5b7e2f0a-1111-4222-8333-444455556666', status: 'draft', full_name: b.full_name, email: b.email, email_verified_at: null,
      phone: b.phone, contact_role: b.role, legal_name: null, dba: null, entity_type: null, ein_set: false, ein_last4: null,
      years_in_business: null, business_email: null, business_phone: null, website: null, mailing_address: null, location_count: null,
      operations: {}, plan_model: null, addons: [], hardware_selection: null, compliance_ack_at: null, current_step: 1, info_request: null, submitted_at: null,
    },
    locations: [], owners: [], documents: [], signatures: [], sms_consent: null,
  };
}

const P = (sku, name, category, price, extra = {}) => ({ id: sku.toLowerCase(), sku, name, category, description: `${name} (placeholder).`, price_cents: price, specs: { model: 'TBD', connectivity: 'TBD' }, images: [], stock_qty: 25, max_per_order: 5, is_placeholder: true, sort_order: 0, ...extra });
const products = [
  P('POS-FULL', 'Full POS Station', 'station', 129900), P('POS-LITE', 'Counter Lite', 'station', 79900),
  P('KIT-ONLINE', 'Online-Only Kit (Model B)', 'kit', 49900), P('ACC-VP100', 'Payment terminal (VP100)', 'accessory', 24900),
  P('ACC-SCAN', 'Bluetooth barcode scanner', 'accessory', 8900), P('ACC-PAPER', 'Thermal paper (case)', 'consumable', 4900, { stock_qty: 3, max_per_order: 20 }),
  P('ACC-DRAWER', 'Cash drawer + RJ11 cable', 'accessory', 12900, { stock_qty: 0 }),
];
const bi = (sku, name, price, quantity, swap_group, is_optional) => ({ quantity, swap_group, is_optional, hardware_products: { sku, name, price_cents: price } });
const bundles = [
  { slug: 'full-pos-bundle', name: 'Full POS bundle', description: 'Dual-screen station with terminal.', model_fit: 'model_a', discount_cents: 10000, is_placeholder: true, sort_order: 10,
    hardware_bundle_items: [bi('POS-FULL', 'Full POS Station', 129900, 1, 'station', false), bi('ACC-VP100', 'Payment terminal (VP100)', 24900, 1, null, false), bi('ACC-PAPER', 'Thermal paper (case)', 4900, 1, null, true)] },
  { slug: 'counter-lite-bundle', name: 'Counter Lite bundle', description: 'Single-screen station with terminal.', model_fit: 'model_a', discount_cents: 7500, is_placeholder: true, sort_order: 20,
    hardware_bundle_items: [bi('POS-LITE', 'Counter Lite', 79900, 1, 'station', false), bi('ACC-VP100', 'Payment terminal (VP100)', 24900, 1, null, false)] },
  { slug: 'online-only-bundle', name: 'Online-Only bundle', description: 'iPad order board kit.', model_fit: 'model_b', discount_cents: 0, is_placeholder: true, sort_order: 30,
    hardware_bundle_items: [bi('KIT-ONLINE', 'Online-Only Kit', 49900, 1, null, false)] },
];
const config = [
  { key: 'plans', value: { is_placeholder: true, model_a: { name: 'Full Rackd POS', monthly_cents: 9900, setup_cents: 0, features: [] }, model_b: { name: 'Online Storefront only', monthly_cents: 4900, setup_cents: 0, features: [] } } },
  { key: 'addons', value: { is_placeholder: true, sms_marketing: { name: 'SMS marketing', monthly_cents: 2900, feature: 'sms_marketing' }, loyalty_crm: { name: 'Loyalty / CRM', monthly_cents: 1900, feature: 'loyalty' }, automated_rebates: { name: 'Automated rebates', monthly_cents: 2900, feature: 'rebate_reporting' }, multi_location: { name: 'Multi-location', monthly_cents: 3900, feature: null }, extra_registers: { name: 'Extra register', monthly_cents: 1500, feature: null } } },
  { key: 'hardware_tax', value: { is_placeholder: true, mode: 'flat', rate_pct: 8.25 } },
  { key: 'hardware_shipping', value: { is_placeholder: true, methods: [{ id: 'ground', name: 'Ground (flat rate)', cents: 1500 }] } },
  { key: 'online_fee', value: { is_placeholder: true, type: 'percent', value: 5, paid_by: 'customer' } },
];

const json = (res, body, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

function api(name, b, res) {
  const authed = b.token === TOKEN && db;
  switch (name) {
    case 'create': db = newDraft(b); return json(res, { resume_token: TOKEN, email_sent: true, dev_email_code: CODE });
    case 'send-code': return json(res, { email_sent: true, dev_email_code: CODE });
    case 'verify-email': if (!authed) return json(res, { error: 'invalid_token' }, 401);
      if (b.code === CODE) db.application.email_verified_at = new Date().toISOString();
      return json(res, { verified: b.code === CODE });
    case 'resume-request': return json(res, { ok: true });
    case 'resume': return json(res, { resume_token: TOKEN });
    case 'get': return authed ? json(res, db) : json(res, { error: 'invalid_token' }, 401);
    case 'status': return authed ? json(res, { status: db.application.status, full_name: db.application.full_name, legal_name: db.application.legal_name, submitted_at: db.application.submitted_at, info_request: db.application.info_request, reject_reason: null, events: db.application.status === 'draft' ? [] : [{ type: 'submitted', at: new Date().toISOString(), message: 'Application received.' }] }) : json(res, { error: 'invalid_token' }, 401);
    case 'save': if (!authed) return json(res, { error: 'invalid_token' }, 401);
      if (b.patch) Object.assign(db.application, b.patch);
      if (b.locations) db.locations = b.locations;
      if (b.owners) db.owners = b.owners;
      if (b.ein) { db.application.ein_set = true; db.application.ein_last4 = String(b.ein).replace(/\D/g, '').slice(-4); }
      return json(res, { ok: true, saved_at: new Date().toISOString() });
    case 'upload-url': return json(res, { path: `${db?.application.id}/mock.pdf`, upload_token: 'mock' });
    case 'register-document': { const id = crypto.randomUUID(); db.documents.push({ id, kind: b.kind, original_name: b.original_name, location_id: b.location_id ?? null, owner_id: b.owner_id ?? null, mime: 'application/pdf', size_bytes: 1, scan_status: 'skipped', requested_by_admin: false, uploaded_at: new Date().toISOString() });
      return json(res, { document_id: id, scan_status: 'skipped' }); }
    case 'agreements': db.signatures = [{ kind: 'terms_of_service', typed_name: b.typed_name }, { kind: 'merchant_agreement', typed_name: b.typed_name }];
      db.application.compliance_ack_at = new Date().toISOString(); db.sms_consent = { consented: !!b.sms_consent, text_version: 'x', created_at: '' };
      return json(res, { ok: true });
    case 'submit': db.application.status = 'submitted'; db.application.submitted_at = new Date().toISOString(); return json(res, { ok: true });
    case 'reset': reset(); return json(res, { ok: true });
    default: return json(res, { error: 'not_found' }, 404);
  }
}

const orders = new Map();
function hwApi(name, b, res) {
  const cat = buildCatalog(products, bundles, config);
  switch (name) {
    case 'mode': return json(res, { test_mode: true });
    case 'checkout': {
      const price = priceCart(cat, b.cart ?? { items: [] }, b.shipping_method);
      if (!price.ok) return json(res, { error: 'cart_invalid', problems: price.errors }, 409);
      const id = crypto.randomUUID(); const token = 'cd'.repeat(32);
      orders.set(id, { id, token, order_number: `HW-${1001 + orders.size}`, status: 'pending', email: b.email, ...price, items: price.lines.map((l) => ({ name: l.name, sku: l.sku, unit_price_cents: l.unit_cents, quantity: l.qty })), address: b.address });
      return json(res, { order_id: id, order_number: orders.get(id).order_number, access_token: token, total_cents: price.total_cents, tax_pending: false, test_mode: true });
    }
    case 'order': { const o = orders.get(b.id); if (!o || o.token !== b.token) return json(res, { error: 'invalid_token' }, 401);
      return json(res, { id: o.id, order_number: o.order_number, status: o.status, email: o.email, subtotal_cents: o.subtotal_cents, discount_cents: o.discount_cents, shipping_cents: o.shipping_cents, tax_cents: o.tax_cents, total_cents: o.total_cents, is_test: true, notes: null, shipping_method: 'ground', carrier: null, tracking_number: null, created_at: new Date().toISOString(), paid_at: null, shipped_at: null, address: { company: null, line2: null, ...o.address }, items: o.items }); }
    default: return json(res, { error: 'not_found' }, 404);
  }
}

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'POST' && url.pathname.startsWith('/api/hardware/')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { let b = {}; try { b = JSON.parse(raw || '{}'); } catch {} hwApi(url.pathname.split('/').pop(), b, res); });
    return;
  }
  if (req.method === 'POST' && url.pathname.startsWith('/api/onboarding/')) {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => { let b = {}; try { b = JSON.parse(raw || '{}'); } catch {} api(url.pathname.split('/').pop(), b, res); });
    return;
  }
  if (url.pathname.startsWith('/sb/rest/v1/app_config')) return json(res, config);
  if (url.pathname.startsWith('/sb/rest/v1/hardware_bundles')) return json(res, bundles);
  if (url.pathname.startsWith('/sb/rest/v1/hardware_products')) return json(res, products);
  if (url.pathname.startsWith('/sb/storage/')) return json(res, { Key: 'mock' });
  let p = decodeURIComponent(url.pathname);
  if (p.startsWith('/hardware/order/') && p !== '/hardware/order/') p = '/hardware/order-view/'; // mirrors public/_redirects
  let file = path.join(root, p);
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file) && fs.existsSync(file + '.html')) file += '.html';
  if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/html' }); return res.end('Not found'); }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`mock server on http://localhost:${PORT}`));
