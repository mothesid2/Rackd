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
        </div>
      </div>
      <div class="muted" data-locs="${b.tenant_id}" style="margin-top:12px;font-size:13px">Loading locations…</div>
    </div>`).join('');
  wrap.querySelectorAll('[data-add]').forEach((btn) => btn.addEventListener('click', () => {
    $('lTenant').value = btn.dataset.add; $('lName').value = ''; $('locModal').style.display = 'flex'; $('lName').focus();
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

// ── Kiosks ────────────────────────────────────────────────────────────────────
async function renderKiosks() {
  view.innerHTML = `<div class="sec-head"><div class="h2">Kiosks</div></div><div id="kWrap"><div class="spin">Loading…</div></div>`;
  if (!currentTenant) { $('kWrap').innerHTML = '<div class="card muted">Pick a business.</div>'; return; }
  const r = await window.owner.kiosks(currentTenant);
  if (!r.success) { $('kWrap').innerHTML = `<div class="card muted">${esc(r.error)}</div>`; return; }
  const ks = r.kiosks || [];
  if (!ks.length) { $('kWrap').innerHTML = '<div class="card muted">No kiosks activated for this business yet.</div>'; return; }
  $('kWrap').innerHTML = `<div class="card" style="padding:0;overflow:hidden"><table class="grid">
    <thead><tr><th>Kiosk</th><th>Location</th><th>Last seen</th><th>Status</th><th></th></tr></thead>
    <tbody>${ks.map((k) => {
      const pc = k.pending_command;
      const status = pc
        ? `<span class="badge warn">${esc(pc.status)}${pc.note ? '' : ''}</span>${pc.note ? `<div class="muted" style="font-size:11px;margin-top:3px">${esc(pc.note)}</div>` : ''}`
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
    }).join('')}</tbody></table></div>`;
  $('kWrap').querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => {
    $('rTenant').value = currentTenant; $('rMachine').value = b.dataset.reset;
    $('rSub').textContent = `Kiosk ${b.dataset.reset.slice(0, 8)} at ${b.dataset.loc || 'its location'} will be unlocked and returned to setup.`;
    $('resetModal').style.display = 'flex';
  }));
  $('kWrap').querySelectorAll('[data-cancel]').forEach((b) => b.addEventListener('click', async () => {
    const r = await window.owner.cancelReset(currentTenant, b.dataset.cancel);
    if (r.success) { toast('Reset cancelled'); renderKiosks(); } else toast(r.error, true);
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
let staffList = [];

async function renderStaff() {
  view.innerHTML = `<div class="sec-head"><div class="h2">Staff &amp; permissions</div></div><div id="sWrap"><div class="spin">Loading…</div></div>`;
  if (!currentTenant) { $('sWrap').innerHTML = '<div class="card muted">Pick a business.</div>'; return; }
  const r = await window.owner.staff(currentTenant);
  if (!r.success) { $('sWrap').innerHTML = `<div class="card muted">${esc(r.error)}</div>`; return; }
  staffList = r.staff || [];
  if (!staffList.length) { $('sWrap').innerHTML = '<div class="card muted">No staff yet. Staff are created on the POS / Manager Portal.</div>'; return; }
  $('sWrap').innerHTML = staffList.map((e) => {
    const isAdmin = e.role === 'admin';
    const toggles = PERM_KEYS.map((k) => {
      const on = isAdmin || !!(e.permissions[k] && e.permissions[k].is_granted);
      return `<label class="permtog${isAdmin ? ' locked' : ''}">
        <input type="checkbox" data-uid="${esc(e.uid)}" data-key="${k}" ${on ? 'checked' : ''} ${isAdmin ? 'disabled' : ''}/>
        <span>${PERM_LABELS[k]}</span></label>`;
    }).join('');
    return `<div class="card" style="margin-bottom:12px">
      <div class="rowflex" style="justify-content:space-between">
        <div>
          <div style="font-weight:700;font-size:15px">${esc(e.name || e.username || 'Staff')}
            <span class="badge ${isAdmin ? 'warn' : 'dim'}" style="margin-left:6px">${esc(e.role || '')}</span>
            ${e.is_active ? '' : '<span class="badge dim" style="margin-left:4px">inactive</span>'}</div>
          <div class="muted" style="font-size:12px;margin-top:2px">${esc(e.username || '—')} · ${esc(e.location_name || '')}</div>
        </div>
        <button class="rowbtn" data-resetpw="${esc(e.uid)}" data-who="${esc(e.username || e.name || 'this user')}">Reset password</button>
      </div>
      ${isAdmin
        ? '<div class="muted" style="font-size:12px;margin-top:12px">Admins have every permission — nothing to toggle.</div>'
        : `<div class="permgrid" style="margin-top:12px">${toggles}</div>`}
    </div>`;
  }).join('');

  $('sWrap').querySelectorAll('input[type=checkbox]').forEach((cb) => cb.addEventListener('change', async () => {
    cb.disabled = true;
    const r = await window.owner.setStaffPermission({
      tenant_id: currentTenant, employee_uid: cb.dataset.uid, permission_key: cb.dataset.key, is_granted: cb.checked,
    });
    cb.disabled = false;
    if (r.success) toast('Permission updated — applies on the register’s next sync');
    else { cb.checked = !cb.checked; toast(r.error || 'Failed', true); }
  }));
  $('sWrap').querySelectorAll('[data-resetpw]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Reset the password for ${b.dataset.who}? They'll get a temporary password and must change it on next login.`)) return;
    b.disabled = true; b.textContent = 'Resetting…';
    const r = await window.owner.resetStaffPassword(currentTenant, b.dataset.resetpw);
    b.disabled = false; b.textContent = 'Reset password';
    if (!r.success) { toast(r.error || 'Failed', true); return; }
    $('tpWho').textContent = r.username || b.dataset.who;
    $('tpPass').textContent = r.temp_password || '—';
    $('tempPwModal').style.display = 'flex';
  }));
}

// ── Revenue (per location) ────────────────────────────────────────────────────
async function renderRevenue() {
  view.innerHTML = `<div class="sec-head"><div class="h2">Revenue by location</div><div class="muted" style="font-size:12px">In-store POS sales · last 30 days</div></div><div id="rvWrap"><div class="spin">Loading…</div></div>`;
  if (!currentTenant) { $('rvWrap').innerHTML = '<div class="card muted">Pick a business.</div>'; return; }
  const r = await window.owner.revenueByLocation(currentTenant);
  if (!r.success) { $('rvWrap').innerHTML = `<div class="card muted">${esc(r.error)}</div>`; return; }
  const locs = r.locations || [];
  const total = locs.reduce((s, l) => s + Number(l.revenue || 0), 0);
  const txns = locs.reduce((s, l) => s + Number(l.txn_count || 0), 0);
  const kpis = `<div class="kpi-row">
    <div class="kpi"><div class="lbl">Total POS revenue</div><div class="val">${fmt(total)}</div></div>
    <div class="kpi"><div class="lbl">Transactions</div><div class="val">${txns}</div></div>
    <div class="kpi"><div class="lbl">Locations</div><div class="val">${locs.filter((l) => l.location_id).length}</div></div>
  </div>`;
  $('rvWrap').innerHTML = kpis + (locs.length ? `<div class="card" style="padding:0;overflow:hidden"><table class="grid">
    <thead><tr><th>Location</th><th class="num">Transactions</th><th class="num">Refunds</th><th class="num">Revenue</th></tr></thead>
    <tbody>${locs.map((l) => `<tr>
      <td>${esc(l.location_name)}</td>
      <td class="num muted">${l.txn_count || 0}</td>
      <td class="num muted">${l.refund_count || 0}</td>
      <td class="num" style="font-weight:700">${fmt(l.revenue)}</td></tr>`).join('')}</tbody></table></div>`
    : '<div class="card muted">No sales in this window yet.</div>');
}

// ── nav ───────────────────────────────────────────────────────────────────────
const TABS = { businesses: renderBusinesses, kiosks: renderKiosks, orders: renderOrders, staff: renderStaff, revenue: renderRevenue, publish: renderPublish };
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  (TABS[tab] || renderBusinesses)();
}

// ── modal actions ──────────────────────────────────────────────────────────────
$('bCreate').addEventListener('click', async () => {
  const name = $('bName').value.trim();
  const admin_username = $('bAdminUser').value.trim();
  const locations = $('bLocs').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const max_registers = Math.max(1, Number($('bSeats').value) || 1);
  if (!name) { toast('Enter a business name', true); return; }
  if (!admin_username) { toast('Enter an admin username', true); return; }
  const r = await window.owner.createBusiness({ name, admin_username, locations, max_registers });
  if (!r.success) { toast(r.error, true); return; }
  $('bizModal').style.display = 'none';
  // Show the delivered credentials once (business key + admin login).
  $('cKey').textContent = (r.license && r.license.license_key) || '—';
  $('cUser').textContent = (r.admin && r.admin.username) || admin_username;
  $('cPass').textContent = (r.admin && r.admin.password) || '—';
  $('credsModal').style.display = 'flex';
  await loadBusinesses(); switchTab('businesses');
});
$('lCreate').addEventListener('click', async () => {
  const name = $('lName').value.trim();
  if (!name) { toast('Enter a location name', true); return; }
  const r = await window.owner.addLocation($('lTenant').value, name);
  if (!r.success) { toast(r.error, true); return; }
  $('locModal').style.display = 'none'; toast('Location added');
  loadLocations($('lTenant').value);
});
$('rConfirm').addEventListener('click', async () => {
  const r = await window.owner.resetKiosk($('rTenant').value, $('rMachine').value);
  $('resetModal').style.display = 'none';
  if (r.success) { toast('Reset queued'); renderKiosks(); } else toast(r.error, true);
});

// ── boot ───────────────────────────────────────────────────────────────────────
$('logout').addEventListener('click', async () => { await window.owner.logout(); window.location.href = 'login.html'; });
$('bizSelect').addEventListener('change', (e) => { currentTenant = e.target.value; if (['kiosks', 'orders', 'staff', 'revenue'].includes(currentTab)) switchTab(currentTab); });
document.querySelectorAll('.navbtn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

(async () => {
  const s = await window.owner.status();
  if (!s.unlocked) { window.location.href = 'login.html'; return; }
  await loadBusinesses();
  switchTab('businesses');
})();
