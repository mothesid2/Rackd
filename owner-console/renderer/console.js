// Rackd Owner Console — renderer logic.
const $ = (id) => document.getElementById(id);
const view = $('view');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const ago = (iso) => {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
};

let bizList = [];         // [{tenant_id, name, businessKey, max_registers, used}]
let currentTenant = null;
let currentTab = 'businesses';

function toast(msg, err) {
  const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
  setTimeout(() => { t.className = 'toast'; }, 2600);
}

async function loadBusinesses() {
  const r = await window.owner.businesses();
  if (!r.success) { toast(r.error || 'Could not load businesses', true); return; }
  const byTenant = {};
  for (const l of r.licenses || []) {
    const t = l.tenant_id;
    byTenant[t] = byTenant[t] || { tenant_id: t, name: l.name, businessKey: null, max_registers: 0, used: 0 };
    if (l.kind === 'business') {
      byTenant[t].name = l.name; byTenant[t].businessKey = l.license_key;
      byTenant[t].max_registers = l.max_registers; byTenant[t].used = l.used_registers || 0;
    }
  }
  bizList = Object.values(byTenant);
  const sel = $('bizSelect');
  sel.innerHTML = bizList.length
    ? bizList.map((b) => `<option value="${b.tenant_id}">${esc(b.name || b.tenant_id.slice(0, 8))}</option>`).join('')
    : '<option value="">No businesses yet</option>';
  if (!currentTenant || !bizList.some((b) => b.tenant_id === currentTenant)) currentTenant = bizList[0]?.tenant_id || null;
  sel.value = currentTenant || '';
}

// ── Businesses ────────────────────────────────────────────────────────────────
async function renderBusinesses() {
  view.innerHTML = `<div class="sec-head"><div class="h2">Businesses</div><button class="btn btn-accent" id="newBiz">+ New business</button></div><div id="bizWrap" class="stack"></div>`;
  $('newBiz').addEventListener('click', () => { $('bizModal').style.display = 'flex'; });
  const wrap = $('bizWrap');
  if (!bizList.length) { wrap.innerHTML = `<div class="card muted">No businesses yet. Create one to issue a business key.</div>`; return; }
  wrap.innerHTML = bizList.map((b) => `
    <div class="card">
      <div class="rowflex" style="justify-content:space-between">
        <div>
          <div style="font-weight:700;font-size:15px">${esc(b.name || 'Business')}</div>
          <div class="muted" style="font-size:12px;margin-top:2px">Seats: ${b.used}/${b.max_registers} kiosks</div>
        </div>
        <div class="rowflex">
          ${b.businessKey ? `<span class="keycode" title="Business key">${esc(b.businessKey)}</span>` : `<span class="badge warn">no business key</span>`}
          <button class="rowbtn" data-add="${b.tenant_id}">+ Location</button>
          <button class="rowbtn" style="color:#f2a9a5" data-delete-biz="${b.tenant_id}" data-name="${esc(b.name || 'this business')}">Delete</button>
        </div>
      </div>
      <div class="muted" data-locs="${b.tenant_id}" style="margin-top:12px;font-size:13px">Loading locations…</div>
    </div>`).join('');
  wrap.querySelectorAll('[data-add]').forEach((btn) => btn.addEventListener('click', () => {
    $('lTenant').value = btn.dataset.add; $('lName').value = ''; $('lAddress').value = ''; $('lZip').value = '';
    $('locModal').style.display = 'flex'; $('lName').focus();
  }));
  // Delete an entire business (batch 5) — this is exactly what would have
  // prevented needing a hand-run SQL script for the 2026-07-24 accidental
  // duplicate-tenant incident. Type-the-name confirmation since this deletes
  // every location, employee, and kiosk registration for the tenant.
  wrap.querySelectorAll('[data-delete-biz]').forEach((btn) => btn.addEventListener('click', async () => {
    const tenantId = btn.dataset.deleteBiz;
    const name = btn.dataset.name;
    const typed = prompt(`This permanently deletes "${name}" — every location, employee, and kiosk registration under it. This cannot be undone.\n\nType the business name exactly to confirm:`, '');
    if (typed === null) return;
    if (typed.trim() !== name) { toast('Name did not match — nothing was deleted', true); return; }
    btn.disabled = true; btn.textContent = 'Deleting…';
    const r = await window.owner.deleteBusiness(tenantId);
    if (!r.success) { btn.disabled = false; btn.textContent = 'Delete'; toast(r.error || 'Failed', true); return; }
    toast(`"${name}" deleted`);
    await loadBusinesses();
    renderBusinesses();
  }));
  for (const b of bizList) loadLocations(b.tenant_id);
}

async function loadLocations(tenantId) {
  const el = document.querySelector(`[data-locs="${tenantId}"]`);
  if (!el) return;
  const r = await window.owner.locations(tenantId);
  if (!r.success) { el.textContent = r.error || 'Could not load locations'; return; }
  const locs = r.locations || [];
  el.innerHTML = locs.length
    ? `<table class="grid"><tbody>${locs.map((l) => `
        <tr><td>${esc(l.name)}</td>
        <td class="num muted" style="font-size:12px">${l.kiosk_count || 0} kiosk${l.kiosk_count === 1 ? '' : 's'}</td>
        <td class="num" style="width:90px"><button class="rowbtn" data-rename="${l.id}" data-name="${esc(l.name)}">Rename</button></td></tr>`).join('')}</tbody></table>`
    : '<span class="muted">No locations.</span>';
  el.querySelectorAll('[data-rename]').forEach((btn) => btn.addEventListener('click', async () => {
    const name = prompt('Rename location', btn.dataset.name);
    if (!name || name === btn.dataset.name) return;
    const r = await window.owner.renameLocation(btn.dataset.rename, name.trim());
    if (r.success) { toast('Location renamed'); loadLocations(tenantId); } else toast(r.error, true);
  }));
}

// ── Web Orders ──────────────────────────────────────────────────────────────
async function renderOrders() {
  view.innerHTML = `<div class="sec-head"><div class="h2">Web Orders</div><div class="muted" style="font-size:12px">Online pickup orders across this business's locations</div></div><div id="oWrap"><div class="spin">Loading…</div></div>`;
  const r = await window.owner.onlineOrders(currentTenant);
  if (!r.success) { $('oWrap').innerHTML = `<div class="card muted">${esc(r.error)}</div>`; return; }
  const orders = r.orders || [];
  const rev = orders.filter((o) => o.total > 0).reduce((s, o) => s + Number(o.total || 0), 0);
  const kpis = `<div class="kpi-row">
    <div class="kpi"><div class="lbl">Orders (recent)</div><div class="val">${orders.length}</div></div>
    <div class="kpi"><div class="lbl">Revenue</div><div class="val">${fmt(rev)}</div></div>
    <div class="kpi"><div class="lbl">Awaiting pickup</div><div class="val">${orders.filter((o) => ['new', 'preparing', 'ready'].includes(o.status)).length}</div></div>
  </div>`;
  $('oWrap').innerHTML = kpis + (orders.length ? `<div class="card" style="padding:0;overflow:hidden"><table class="grid">
    <thead><tr><th>Order</th><th>Location</th><th>Items</th><th>Status</th><th class="num">Total</th><th>When</th></tr></thead>
    <tbody>${orders.map((o) => `<tr>
      <td>#${esc(o.order_number || o.id.slice(0, 6))}</td>
      <td>${esc(o.location_name || '—')}</td>
      <td class="muted">${esc((o.online_order_items || []).map((i) => `${i.qty}× ${i.name}`).join(', ')).slice(0, 60)}</td>
      <td><span class="badge ${o.status === 'completed' ? 'on' : o.status === 'cancelled' ? 'dim' : 'warn'}">${esc(o.status)}</span></td>
      <td class="num">${fmt(o.total)}</td>
      <td class="muted">${ago(o.created_at)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="card muted">No online orders yet.</div>');
}

// ── Publish ───────────────────────────────────────────────────────────────────
const APP_LABELS = { pos: 'Point of Sale', manager: 'Manager Portal', owner: 'Owner Console', storefront: 'Web Storefront' };
async function renderPublish() {
  view.innerHTML = `<div class="sec-head"><div class="h2">Publish updates</div></div>
    <div class="muted" style="font-size:13px;margin-bottom:14px">Your staging copies update on every build. Publishing promotes staging → production, and only then do live systems pull it on their next launch.</div>
    <div id="pWrap"><div class="spin">Loading…</div></div>`;
  const r = await window.owner.publishStatus();
  const apps = r.success ? (r.apps || []) : [];
  // Storefront is a web deploy (no storage version) — always offer a publish button.
  const rows = [...apps, { app: 'storefront', staging_version: null, production_version: null, web: true }];
  $('pWrap').innerHTML = `<div class="stack">${rows.map((a) => {
    const changed = a.web ? true : (a.staging_version && a.staging_version !== a.production_version);
    return `<div class="card rowflex" style="justify-content:space-between">
      <div>
        <div style="font-weight:700">${esc(APP_LABELS[a.app] || a.app)}</div>
        <div class="muted" style="font-size:12px;margin-top:3px">${a.web
          ? 'Web deploy (staging → production via deploy hook)'
          : `staging <span class="keycode">${esc(a.staging_version || '—')}</span> · production <span class="keycode">${esc(a.production_version || '—')}</span>`}</div>
      </div>
      <div class="rowflex">
        ${changed ? '<span class="badge warn">update ready</span>' : '<span class="badge on">up to date</span>'}
        <button class="btn btn-accent" data-pub="${a.app}" ${changed ? '' : 'disabled'}>Publish</button>
      </div>
    </div>`;
  }).join('')}</div>`;
  $('pWrap').querySelectorAll('[data-pub]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Publish ${APP_LABELS[b.dataset.pub] || b.dataset.pub} to production? Live systems will update on their next launch.`)) return;
    b.disabled = true; b.textContent = 'Publishing…';
    const r = await window.owner.publish(b.dataset.pub);
    if (r.success) { toast(`Published ${APP_LABELS[b.dataset.pub] || b.dataset.pub}`); renderPublish(); }
    else { toast(r.error, true); b.disabled = false; b.textContent = 'Publish'; }
  }));
}

// ── Staff & permissions ───────────────────────────────────────────────────────
const PERM_LABELS = {
  apply_discount: 'Apply discount', process_refund: 'Process refund', override_price: 'Override price',
  inventory_adjust: 'Adjust inventory', view_reports: 'View reports', manage_rebates: 'Manage rebates',
  open_drawer_no_sale: 'Open drawer (no sale)', clock_others: 'Clock others in/out',
};
const PERM_KEYS = Object.keys(PERM_LABELS);

// Menu-tile access (item 3) — default ON (a cashier can open every POS tile
// unless a grant row explicitly revokes one); opposite default from PERM_LABELS
// above, which default OFF. Same employee_permissions storage either way.
const MENU_LABELS = {
  access_merchandise: 'Merchandise (inventory)', access_receipts: 'Receipts',
  access_customer_lookup: 'Customer Lookup', access_pickups: 'Online Pickups',
};
const MENU_KEYS = Object.keys(MENU_LABELS);

// Fixed feature registry (item 9) — matches the FEATURES list already used by
// the legacy local admin panel (src/renderer/admin/index.html), so a feature
// flag means the same thing everywhere rather than being a free-form string.
const FEATURES = [
  ['cloud_access', 'Cloud access'], ['ad_free', 'Ad-free'], ['inventory_management', 'Inventory management'],
  ['rebate_reporting', 'Automated rebate reporting'], ['sms_marketing', 'SMS marketing'], ['loyalty', 'Loyalty & rewards'],
  ['promotions', 'Promotions'], ['advanced_reports', 'Advanced reports'], ['reports_app', 'Phone reports app'],
  ['web_store', 'Online store'],
];

function sectionHead(iconPath, title, right = '') {
  return `<div class="section-head">
    <div class="s-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${iconPath}</svg></div>
    <div class="s-title">${title}</div>
    ${right}
  </div>`;
}

// ── Business (item 16: pick a business, see ALL of its settings in one place) ──
async function renderBusinessDetail() {
  view.innerHTML = '<div class="spin">Loading…</div>';
  if (!currentTenant) { view.innerHTML = '<div class="card muted">No businesses yet — create one first.</div>'; return; }
  const biz = bizList.find((b) => b.tenant_id === currentTenant);
  const [locR, bizAllR, revR, kioskR, staffR] = await Promise.all([
    window.owner.locations(currentTenant),
    window.owner.businesses(), // re-read so contact_email/phone/features/display_config are fresh
    window.owner.revenueByLocation(currentTenant),
    window.owner.kiosks(currentTenant),
    window.owner.staff(currentTenant),
  ]);
  const locs = locR.success ? (locR.locations || []) : [];
  const bizLic = (bizAllR.success ? bizAllR.licenses || [] : []).find((l) => l.tenant_id === currentTenant && l.kind === 'business') || {};
  const features = new Set(Array.isArray(bizLic.features) ? bizLic.features : []);
  const dc = bizLic.display_config || {};
  const ads = Array.isArray(dc.ads) ? dc.ads : [];
  const revLocs = revR.success ? (revR.locations || []) : [];
  const kiosks = kioskR.success ? (kioskR.kiosks || []) : [];
  const staffList = staffR.success ? (staffR.staff || []) : [];

  // ── Revenue (item 6: top of the page) ────────────────────────────────────
  const totalRev = revLocs.reduce((s, l) => s + Number(l.revenue || 0), 0);
  const totalTxn = revLocs.reduce((s, l) => s + Number(l.txn_count || 0), 0);
  const revenueSection = `<div class="section">
    ${sectionHead('<line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>', 'Revenue', '<span class="s-sub">In-store POS sales · last 30 days</span>')}
    <div class="section-body">
      <div class="kpi-row">
        <div class="kpi"><div class="lbl">Total POS revenue</div><div class="val">${fmt(totalRev)}</div></div>
        <div class="kpi"><div class="lbl">Transactions</div><div class="val">${totalTxn}</div></div>
        <div class="kpi"><div class="lbl">Locations</div><div class="val">${revLocs.filter((l) => l.location_id).length}</div></div>
      </div>
      ${revLocs.length ? `<table class="grid"><thead><tr><th>Location</th><th class="num">Transactions</th><th class="num">Refunds</th><th class="num">Revenue</th></tr></thead>
        <tbody>${revLocs.map((l) => `<tr>
          <td>${esc(l.location_name)}</td>
          <td class="num muted">${l.txn_count || 0}</td>
          <td class="num muted">${l.refund_count || 0}</td>
          <td class="num" style="font-weight:700">${fmt(l.revenue)}</td></tr>`).join('')}</tbody></table>`
        : '<div class="muted">No sales in this window yet.</div>'}
    </div>
  </div>`;

  // ── Business Info ─────────────────────────────────────────────────────────
  const businessInfoSection = `<div class="section">
    ${sectionHead('<path d="M3 21h18"/><path d="M5 21V7l8-4v18"/><path d="M19 21V11l-6-4"/>', 'Business Info')}
    <div class="section-body">
      <div class="rowflex" style="justify-content:space-between;margin-bottom:16px">
        <div class="rowflex">
          <span class="muted" style="font-size:12px">Business key</span>
          <span class="keycode" id="bizKeyDisplay">${esc(biz?.businessKey || '—')}</span>
          <button class="rowbtn" id="bizKeyCopy" ${biz?.businessKey ? '' : 'disabled'}>Copy</button>
        </div>
        <div class="rowflex">
          <span class="muted" style="font-size:12px">Kiosk seats: <strong>${biz?.used ?? 0} /</strong></span>
          <input id="bizMaxRegisters" type="number" min="1" step="1" value="${Number(biz?.max_registers ?? 1)}" style="width:64px" />
          <button class="rowbtn" id="bizMaxRegistersSave">Save</button>
        </div>
      </div>
      <div class="hgrid">
        <div>
          <div class="muted" style="font-size:11px;margin-bottom:6px">Owner contact</div>
          <div class="fg" style="margin-bottom:6px"><input id="bizContactEmail" placeholder="owner@business.com" value="${esc(bizLic.contact_email || '')}" /></div>
          <div class="fg" style="margin-bottom:6px"><input id="bizContactPhone" placeholder="Phone" value="${esc(bizLic.contact_phone || '')}" /></div>
          <button class="rowbtn" id="bizContactSave">Save contact</button>
        </div>
        <div>
          <div class="muted" style="font-size:11px;margin-bottom:6px">Features</div>
          <div id="bizFeatureToggles">${FEATURES.map(([id, label]) => `
            <div class="switch-row">
              <span class="sw-label">${esc(label)}</span>
              <label class="switch"><input type="checkbox" data-feat="${id}" ${features.has(id) ? 'checked' : ''} /><span class="slider"></span></label>
            </div>`).join('')}</div>
        </div>
      </div>
    </div>
  </div>`;

  // ── Twilio SMS (batch 5, item 2): owner-only — moved out of POS Settings
  // entirely, same treatment as address/tax rate and contact info. The auth
  // token is write-only (never read back), matching how POS Settings' old
  // Twilio card never pre-filled it either.
  const twilioSection = `<div class="section">
    ${sectionHead('<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>', 'Twilio SMS', '<span class="s-sub">Owner-only — used to send text messages from the register</span>')}
    <div class="section-body">
      <div class="hgrid">
        <div class="fg"><label>Account SID</label><input id="twSid" placeholder="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" value="${esc(bizLic.twilio_account_sid || '')}" /></div>
        <div class="fg"><label>Auth token</label><input id="twToken" type="password" placeholder="Leave blank to keep current" /></div>
        <div class="fg"><label>From phone number</label><input id="twFrom" placeholder="+15550000000" value="${esc(bizLic.twilio_from_number || '')}" /></div>
      </div>
      <button class="rowbtn" id="twSave">Save Twilio settings</button>
    </div>
  </div>`;

  // ── Ads (item 7: multiple ads) ────────────────────────────────────────────
  const adsSection = `<div class="section">
    ${sectionHead('<rect x="3" y="3" width="18" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>', 'Ads', '<span class="s-sub">Shown on the POS customer display</span>')}
    <div class="section-body">
      <div class="rowflex" style="margin-bottom:12px">
        <label class="switch"><input type="checkbox" id="adsEnabled" ${dc.promo_enabled ? 'checked' : ''} /><span class="slider"></span></label>
        <span class="sw-label">Show ads</span>
        <span class="muted" style="font-size:12px;margin-left:16px">Rotate every</span>
        <input id="adsInterval" type="number" min="2" value="${Number(dc.ads_interval) || 8}" style="width:64px" /><span class="muted" style="font-size:12px">sec</span>
      </div>
      <div id="adsListWrap"></div>
      <button class="rowbtn" id="adsAddRow" style="margin-bottom:12px">+ Add ad</button>
      <div><button class="btn btn-accent" id="adsSaveAll">Save ads</button></div>
    </div>
  </div>`;

  // ── Users (items 11 & 12: New User + staff permissions, replacing seats-as-provisioning) ──
  const usersSection = `<div class="section">
    ${sectionHead('<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>', 'Users', `<button class="btn btn-accent" id="bizAddUser">+ New user</button>`)}
    <div class="section-body" id="usersWrap">
      ${!staffList.length ? '<div class="muted">No staff yet.</div>' : staffList.map((e) => {
        const isAdmin = e.role === 'admin';
        const isCashier = e.role === 'cashier';
        const toggles = PERM_KEYS.map((k) => {
          const on = isAdmin || !!(e.permissions[k] && e.permissions[k].is_granted);
          return `<label class="permtog${isAdmin ? ' locked' : ''}">
            <input type="checkbox" data-uid="${esc(e.uid)}" data-key="${k}" ${on ? 'checked' : ''} ${isAdmin ? 'disabled' : ''}/>
            <span>${PERM_LABELS[k]}</span></label>`;
        }).join('');
        // Menu access only means anything for cashiers — managers/admins always
        // see every POS tile regardless (main-menu.html only checks this for the
        // cashier branch). Default ON: checked unless explicitly revoked.
        const menuToggles = MENU_KEYS.map((k) => {
          const p = e.permissions[k];
          const on = p ? !!p.is_granted : true;
          return `<label class="permtog">
            <input type="checkbox" data-uid="${esc(e.uid)}" data-key="${k}" ${on ? 'checked' : ''}/>
            <span>${MENU_LABELS[k]}</span></label>`;
        }).join('');
        return `<div class="card" style="margin-bottom:12px">
          <div class="rowflex" style="justify-content:space-between">
            <div>
              <div style="font-weight:700;font-size:15px">${esc(e.name || e.username || 'Staff')}
                <span class="badge ${isAdmin ? 'warn' : 'dim'}" style="margin-left:6px">${esc(e.role || '')}</span>
                ${e.is_active ? '' : '<span class="badge dim" style="margin-left:4px">inactive</span>'}</div>
              <div class="muted" style="font-size:12px;margin-top:2px">${isCashier ? 'register PIN sign-in' : esc(e.username || '—')} · ${esc(e.location_name || '')}</div>
            </div>
            ${isAdmin ? '' : isCashier
              ? `<button class="rowbtn" data-resetpin="${esc(e.uid)}" data-who="${esc(e.name || 'this user')}">Reset PIN</button>`
              : `<button class="rowbtn" data-resetpw="${esc(e.uid)}" data-who="${esc(e.username || e.name || 'this user')}">Reset password</button>`}
          </div>
          ${isAdmin
            ? '<div class="muted" style="font-size:12px;margin-top:12px">Admins have every permission — nothing to toggle.</div>'
            : `<div class="muted" style="font-size:11px;margin-top:12px">Actions</div><div class="permgrid" style="margin-top:6px">${toggles}</div>
               ${isCashier ? `<div class="muted" style="font-size:11px;margin-top:12px">Menu access — on by default</div><div class="permgrid" style="margin-top:6px">${menuToggles}</div>` : ''}`}
        </div>`;
      }).join('')}
    </div>
  </div>`;

  // ── Locations ──────────────────────────────────────────────────────────────
  const locationsSection = `<div class="section">
    ${sectionHead('<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>', 'Locations', '<button class="btn" id="bizAddLoc">+ Location</button>')}
    <div class="section-body stack" id="bizLocWrap"></div>
  </div>`;

  // ── Kiosks (item 12) ─────────────────────────────────────────────────────
  const kiosksSection = `<div class="section">
    ${sectionHead('<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>', 'Kiosks')}
    <div class="section-body">
      ${!kiosks.length ? '<div class="muted">No kiosks activated for this business yet.</div>' : `<table class="grid">
        <thead><tr><th>Kiosk</th><th>Location</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
        <tbody>${kiosks.map((k) => {
          const pc = k.pending_command;
          const status = pc
            ? `<span class="badge warn">${esc(pc.status)}</span>${pc.note ? `<div class="muted" style="font-size:11px;margin-top:3px">${esc(pc.note)}</div>` : ''}`
            : '<span class="badge on">active</span>';
          return `<tr>
            <td><span class="keycode">${esc((k.machine_id || '').slice(0, 8))}</span></td>
            <td>${esc(k.location_name || '—')}</td>
            <td class="muted">${ago(k.last_seen_at)}</td>
            <td>${status}</td>
            <td class="num" style="width:150px">${pc
              ? `<button class="rowbtn" data-cancel="${esc(k.machine_id)}">Cancel reset</button>`
              : `<button class="rowbtn" data-reset="${esc(k.machine_id)}" data-loc="${esc(k.location_name || '')}">Reset</button>`}</td>
          </tr>`;
        }).join('')}</tbody></table>`}
    </div>
  </div>`;

  view.innerHTML = `
    <div class="sec-head"><div class="h2" style="margin:0">${esc(biz?.name || 'Business')}</div></div>
    ${revenueSection}${businessInfoSection}${twilioSection}${adsSection}${usersSection}${locationsSection}${kiosksSection}`;

  // ── wire: Business Info ───────────────────────────────────────────────────
  $('bizKeyCopy')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(biz?.businessKey || ''); toast('Business key copied'); }
    catch { toast('Could not copy', true); }
  });
  $('bizContactSave').addEventListener('click', async () => {
    const r = await window.owner.setBusinessContact(currentTenant, $('bizContactEmail').value.trim(), $('bizContactPhone').value.trim());
    toast(r.success ? 'Contact info saved' : (r.error || 'Failed'), !r.success);
  });
  $('twSave').addEventListener('click', async () => {
    const cfg = { twilio_account_sid: $('twSid').value.trim(), twilio_from_number: $('twFrom').value.trim() };
    const token = $('twToken').value;
    if (token) cfg.twilio_auth_token = token;
    const r = await window.owner.setTwilioConfig(currentTenant, cfg);
    if (r.success) { $('twToken').value = ''; toast('Twilio settings saved'); } else toast(r.error || 'Failed', true);
  });
  // Kiosk seat cap (item 1): business-wide, not per-location — there's no
  // per-location kiosk limit in the data model, a kiosk just activates against
  // the business's one license up to this many distinct machines total.
  $('bizMaxRegistersSave').addEventListener('click', async () => {
    const n = Math.max(1, Number($('bizMaxRegisters').value) || 1);
    $('bizMaxRegisters').value = n;
    const r = await window.owner.setMaxRegisters(biz?.businessKey, n);
    if (r.success) { toast('Kiosk seat limit saved'); loadBusinesses(); } else toast(r.error || 'Failed', true);
  });
  $('bizFeatureToggles').querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', async () => {
    cb.disabled = true;
    const next = new Set(features);
    if (cb.checked) next.add(cb.dataset.feat); else next.delete(cb.dataset.feat);
    const r = await window.owner.setFeatures(currentTenant, [...next]);
    cb.disabled = false;
    if (r.success) { features.clear(); next.forEach((f) => features.add(f)); toast('Features saved'); }
    else { cb.checked = !cb.checked; toast(r.error || 'Failed', true); }
  }));

  // ── wire: Ads ──────────────────────────────────────────────────────────────
  function adRow(url) {
    const row = document.createElement('div');
    row.className = 'ad-row';
    row.innerHTML = `<input type="text" class="ad-url" placeholder="Image or GIF URL — fills the customer display" value="${esc(url || '')}" />
      <button type="button" class="rowbtn" data-rm-ad>Remove</button>`;
    row.querySelector('[data-rm-ad]').addEventListener('click', () => row.remove());
    return row;
  }
  const adsListWrap = $('adsListWrap');
  (ads.length ? ads : [{}]).forEach((a) => adsListWrap.appendChild(adRow(a.image)));
  $('adsAddRow').addEventListener('click', () => adsListWrap.appendChild(adRow('')));
  $('adsSaveAll').addEventListener('click', async () => {
    const newAds = Array.from(adsListWrap.querySelectorAll('.ad-url')).map((i) => ({ image: i.value.trim() })).filter((a) => a.image);
    const displayConfig = { ...dc, promo_enabled: $('adsEnabled').checked, ads_interval: Math.max(2, Number($('adsInterval').value) || 8), ads: newAds };
    const btn = $('adsSaveAll'); btn.disabled = true; btn.textContent = 'Saving…';
    const r = await window.owner.setAds(biz?.businessKey, displayConfig);
    btn.disabled = false; btn.textContent = 'Save ads';
    toast(r.success ? 'Ads saved' : (r.error || 'Failed'), !r.success);
  });

  // ── wire: Users ────────────────────────────────────────────────────────────
  $('bizAddUser').addEventListener('click', () => {
    $('mgrTenant').value = currentTenant; $('mgrName').value = ''; $('mgrUsername').value = ''; $('mgrRole').value = 'manager';
    updateUserModalRole(); $('mgrModal').style.display = 'flex'; $('mgrName').focus();
  });
  $('usersWrap').querySelectorAll('input[type=checkbox][data-key]').forEach((cb) => cb.addEventListener('change', async () => {
    cb.disabled = true;
    const r = await window.owner.setStaffPermission({
      tenant_id: currentTenant, employee_uid: cb.dataset.uid, permission_key: cb.dataset.key, is_granted: cb.checked,
    });
    cb.disabled = false;
    if (r.success) toast('Permission updated — applies on the register’s next sync');
    else { cb.checked = !cb.checked; toast(r.error || 'Failed', true); }
  }));
  $('usersWrap').querySelectorAll('[data-resetpw]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Reset the password for ${b.dataset.who}? They'll get a temporary password and must change it on next login.`)) return;
    b.disabled = true; b.textContent = 'Resetting…';
    const r = await window.owner.resetStaffPassword(currentTenant, b.dataset.resetpw);
    b.disabled = false; b.textContent = 'Reset password';
    if (!r.success) { toast(r.error || 'Failed', true); return; }
    $('tpTitle').textContent = 'Password reset — deliver this';
    $('tpKind').textContent = 'password'; $('tpLabel').textContent = 'Temporary password';
    $('tpWho').textContent = r.username || b.dataset.who;
    $('tpPass').textContent = r.temp_password || '—';
    $('tempPwModal').style.display = 'flex';
  }));
  $('usersWrap').querySelectorAll('[data-resetpin]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Reset the PIN for ${b.dataset.who}? They'll get a temporary PIN and must change it on next login.`)) return;
    b.disabled = true; b.textContent = 'Resetting…';
    const r = await window.owner.resetStaffPin(currentTenant, b.dataset.resetpin);
    b.disabled = false; b.textContent = 'Reset PIN';
    if (!r.success) { toast(r.error || 'Failed', true); return; }
    $('tpTitle').textContent = 'PIN reset — deliver this';
    $('tpKind').textContent = 'PIN'; $('tpLabel').textContent = 'Temporary PIN';
    $('tpWho').textContent = r.name || b.dataset.who;
    $('tpPass').textContent = r.temp_pin || '—';
    $('tempPwModal').style.display = 'flex';
  }));

  // ── wire: Locations ────────────────────────────────────────────────────────
  const locWrap = $('bizLocWrap');
  locWrap.innerHTML = locs.length ? locs.map((l) => `
    <div class="card">
      <div class="rowflex" style="justify-content:space-between;margin-bottom:10px">
        <div style="font-weight:700;font-size:15px">${esc(l.name)}
          ${l.is_storefront_enabled ? '<span class="badge on" style="margin-left:6px">online</span>' : ''}</div>
        <div class="muted" style="font-size:12px">${l.kiosk_count || 0} kiosk${l.kiosk_count === 1 ? '' : 's'}</div>
      </div>
      <div class="permgrid">
        <div class="fg"><label>Address</label><input data-loc-addr="${esc(l.id)}" value="${esc(l.address || '')}" placeholder="123 Main St, City ST" /></div>
        <div class="fg" style="max-width:110px"><label>ZIP</label><input data-loc-zip="${esc(l.id)}" value="${esc(l.zip || '')}" maxlength="10" /></div>
        <div class="fg"><label>Phone</label><input data-loc-phone="${esc(l.id)}" value="${esc(l.phone || '')}" /></div>
        <div class="fg"><label>Contact email</label><input data-loc-email="${esc(l.id)}" value="${esc(l.email || '')}" /></div>
      </div>
      <div class="rowflex" style="justify-content:space-between;margin-top:4px">
        <div class="muted" style="font-size:12px">Online sales tax: <strong>${((l.tax_rate ?? 0) * 100).toFixed(2)}%</strong> (auto, from ZIP)</div>
        <button class="rowbtn" data-save-loc="${esc(l.id)}">Save</button>
      </div>
      <div class="rowflex" style="margin-top:10px;padding-top:10px;border-top:1px solid var(--line-soft);flex-wrap:wrap;gap:10px">
        <div class="fg" style="margin:0;max-width:120px">
          <label>Credit rate (%)</label>
          <input data-loc-fee-credit="${esc(l.id)}" type="number" min="0" max="100" step="0.01" placeholder="e.g. 2.9" />
        </div>
        <div class="fg" style="margin:0;max-width:120px">
          <label>Debit rate (%)</label>
          <input data-loc-fee-debit="${esc(l.id)}" type="number" min="0" max="100" step="0.01" placeholder="e.g. 1.5" />
        </div>
        <div class="fg" style="margin:0;max-width:120px">
          <label>Flat fee ($/txn)</label>
          <input data-loc-fee-flat="${esc(l.id)}" type="number" min="0" step="0.01" placeholder="e.g. 0.10" />
        </div>
        <button class="rowbtn" style="align-self:flex-end" data-save-fee="${esc(l.id)}">Save fee</button>
      </div>
      <div class="muted" style="font-size:11px;margin-top:4px">Your actual card-processing rates — used for the tip-pool deduction and the revenue report's processing-cost estimate. This build's terminal can't tell credit from debit on a transaction (card brand only), so the lower of the two rates is applied until that changes — never over-deducts from tips. Not shown here after saving (re-enter to change); ask if you need to confirm the current values.</div>
    </div>`).join('') : '<div class="muted">No locations yet.</div>';

  // FIX (item 9, address partial-save bug): this used to be two independent
  // buttons — "Save address" (address+zip) and "Save contact" (phone+email) —
  // over what reads as one form. Clicking just one (the natural thing to do
  // after filling in all four fields) silently dropped the other two. One
  // button now fires both backend calls together.
  locWrap.querySelectorAll('[data-save-loc]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.saveLoc;
    const address = document.querySelector(`[data-loc-addr="${id}"]`).value.trim();
    const zip = document.querySelector(`[data-loc-zip="${id}"]`).value.trim();
    const phone = document.querySelector(`[data-loc-phone="${id}"]`).value.trim();
    const email = document.querySelector(`[data-loc-email="${id}"]`).value.trim();
    btn.disabled = true; btn.textContent = 'Saving…';
    const [ra, rc] = await Promise.all([
      window.owner.setLocationAddress(id, address, zip),
      window.owner.setLocationContact(id, phone, email),
    ]);
    if (ra.success && rc.success) {
      toast('Saved — flows down to the POS and Manager Portal');
      renderBusinessDetail();
    } else {
      toast([!ra.success && 'address', !rc.success && 'contact'].filter(Boolean).map((w) => `${w}: ${(w === 'address' ? ra.error : rc.error) || 'failed'}`).join(' · '), true);
      btn.disabled = false; btn.textContent = 'Save';
    }
  }));
  locWrap.querySelectorAll('[data-save-fee]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.saveFee;
    const creditRaw = document.querySelector(`[data-loc-fee-credit="${id}"]`).value;
    const debitRaw = document.querySelector(`[data-loc-fee-debit="${id}"]`).value;
    const flatRaw = document.querySelector(`[data-loc-fee-flat="${id}"]`).value;
    if (creditRaw === '' && debitRaw === '' && flatRaw === '') return toast('Enter at least one fee value first', true);
    const credit = Math.max(0, Math.min(100, Number(creditRaw) || 0));
    const debit = Math.max(0, Math.min(100, Number(debitRaw) || 0));
    const flatCents = Math.max(0, Math.round((Number(flatRaw) || 0) * 100));
    btn.disabled = true; btn.textContent = 'Saving…';
    const r = await window.owner.setLocationMerchantFee(id, { merchant_fee_credit_pct: credit, merchant_fee_debit_pct: debit, merchant_fee_flat_cents: flatCents });
    btn.disabled = false; btn.textContent = 'Save fee';
    if (!r.success) return toast(r.error || 'Failed — has migration 052 been applied yet?', true);
    document.querySelector(`[data-loc-fee-credit="${id}"]`).value = '';
    document.querySelector(`[data-loc-fee-debit="${id}"]`).value = '';
    document.querySelector(`[data-loc-fee-flat="${id}"]`).value = '';
    toast('Merchant fee saved — flows down to the POS on its next sync');
  }));
  $('bizAddLoc').addEventListener('click', () => {
    $('lTenant').value = currentTenant; $('lName').value = ''; $('lAddress').value = ''; $('lZip').value = '';
    $('locModal').style.display = 'flex'; $('lName').focus();
  });

  // ── wire: Kiosks ───────────────────────────────────────────────────────────
  view.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => {
    $('rTenant').value = currentTenant; $('rMachine').value = b.dataset.reset;
    $('rSub').textContent = `Kiosk ${b.dataset.reset.slice(0, 8)} at ${b.dataset.loc || 'its location'} will be unlocked and returned to setup.`;
    $('resetModal').style.display = 'flex';
  }));
  view.querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    const r = await window.owner.cancelReset(currentTenant, b.dataset.cancel);
    if (r.success) { toast('Reset cancelled'); renderBusinessDetail(); } else toast(r.error, true);
  }));
}

// ── nav ───────────────────────────────────────────────────────────────────────
const TABS = { business: renderBusinessDetail, businesses: renderBusinesses, orders: renderOrders, publish: renderPublish };
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  (TABS[tab] || renderBusinessDetail)();
}

// ── modal actions ──────────────────────────────────────────────────────────────
$('bCreate').addEventListener('click', async () => {
  const btn = $('bCreate');
  if (btn.disabled) return; // guards against a double-click firing two creates
  const name = $('bName').value.trim();
  const admin_username = $('bAdminUser').value.trim();
  const locations = $('bLocs').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const max_registers = Math.max(1, Number($('bSeats').value) || 1);
  if (!name) { toast('Enter a business name', true); return; }
  if (!admin_username) { toast('Enter an admin username', true); return; }
  btn.disabled = true; btn.textContent = 'Creating…';
  const r = await window.owner.createBusiness({ name, admin_username, locations, max_registers });
  btn.disabled = false; btn.textContent = 'Create business';
  if (!r.success) { toast(r.error, true); return; }
  $('bizModal').style.display = 'none';
  // Show the delivered credentials once (business key + admin login).
  $('cKey').textContent = (r.license && r.license.license_key) || '—';
  $('cUser').textContent = (r.admin && r.admin.username) || admin_username;
  $('cPass').textContent = (r.admin && r.admin.password) || '—';
  $('credsModal').style.display = 'flex';
  await loadBusinesses(); switchTab('business');
});
$('lCreate').addEventListener('click', async () => {
  const btn = $('lCreate');
  if (btn.disabled) return; // guards against a double-click firing two adds
  const name = $('lName').value.trim();
  const address = $('lAddress').value.trim();
  const zip = $('lZip').value.trim();
  if (!name) { toast('Enter a location name', true); return; }
  btn.disabled = true; btn.textContent = 'Adding…';
  const r = await window.owner.addLocation($('lTenant').value, name, address, zip);
  btn.disabled = false; btn.textContent = 'Add';
  if (!r.success) { toast(r.error, true); return; }
  $('locModal').style.display = 'none'; toast('Location added');
  if (currentTab === 'business') renderBusinessDetail(); else loadLocations($('lTenant').value);
});
function updateUserModalRole() {
  const isCashier = $('mgrRole').value === 'cashier';
  $('mgrUsernameWrap').style.display = isCashier ? 'none' : '';
  $('mgrCashierNote').style.display = isCashier ? '' : 'none';
}
$('mgrRole').addEventListener('change', updateUserModalRole);
$('mgrCreate').addEventListener('click', async () => {
  const btn = $('mgrCreate');
  if (btn.disabled) return;
  const role = $('mgrRole').value === 'cashier' ? 'cashier' : 'manager';
  const name = $('mgrName').value.trim();
  const username = $('mgrUsername').value.trim();
  if (!name) { toast('Enter a name', true); return; }
  if (role === 'manager' && !username) { toast('Enter a username', true); return; }
  btn.disabled = true; btn.textContent = 'Creating…';
  const r = await window.owner.createStaffUser($('mgrTenant').value, { role, username, name });
  btn.disabled = false; btn.textContent = 'Create';
  if (!r.success) { toast(r.error, true); return; }
  $('mgrModal').style.display = 'none';
  const isCashier = role === 'cashier';
  $('mcUserWrap').style.display = isCashier ? 'none' : '';
  $('mcUser').textContent = r.username || username;
  $('mcPassLabel').textContent = isCashier ? 'PIN (one-time)' : 'Password (one-time)';
  $('mcPass').textContent = (isCashier ? r.pin : r.password) || '—';
  // A manager needs BOTH — the temp PIN is what they enter to complete their
  // first sign-in at all (must_change_pin forces a real one right after), same
  // as a cashier's PIN. Only cashiers are PIN-only, so only managers get this
  // extra row (their PIN already shows in the row above via mcPass).
  $('mcPinWrap').style.display = isCashier ? 'none' : '';
  if (!isCashier) $('mcPin').textContent = r.pin || '—';
  $('mgrCredsModal').style.display = 'flex';
  if (currentTab === 'business') renderBusinessDetail();
});
$('rConfirm').addEventListener('click', async () => {
  const r = await window.owner.resetKiosk($('rTenant').value, $('rMachine').value);
  $('resetModal').style.display = 'none';
  if (r.success) { toast('Reset queued'); renderBusinessDetail(); } else toast(r.error, true);
});

// ── boot ───────────────────────────────────────────────────────────────────────
$('bizSelect').addEventListener('change', (e) => { currentTenant = e.target.value; if (['business', 'orders'].includes(currentTab)) switchTab(currentTab); });
document.querySelectorAll('.navbtn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

(async () => {
  const s = await window.owner.status();
  if (!s.unlocked) { window.location.href = 'login.html'; return; }
  await loadBusinesses();
  switchTab('business');
})();
