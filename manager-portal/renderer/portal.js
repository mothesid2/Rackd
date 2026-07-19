// rackd Manager Portal — renderer logic.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const view = document.getElementById('view');
let nameOf = {};        // location_id -> name
let curTab = 'dashboard';
let orderTimer = null;  // auto-refresh handle for the online-orders queue

function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => { t.className = 'toast'; }, 2600);
}

function isoDate(d) { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); }
function range() { return { start: document.getElementById('startDate').value, end: document.getElementById('endDate').value }; }

// ── boot ──────────────────────────────────────────────────────────────────────
(async function boot() {
  const s = await window.portal.session();
  if (!s.success || !s.session) { window.location.href = 'login.html'; return; }
  document.getElementById('bizLabel').textContent = 'Business · ' + (s.session.tenant_id || '').slice(0, 8);

  const today = new Date();
  document.getElementById('endDate').value = isoDate(today);
  document.getElementById('startDate').value = isoDate(today).slice(0, 8) + '01';

  const loc = await window.portal.locations();
  if (loc.success) for (const l of loc.locations) nameOf[l.id] = l.name;

  document.querySelectorAll('.navbtn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  document.getElementById('applyRange').addEventListener('click', () => render());
  document.getElementById('logout').addEventListener('click', async () => { await window.portal.logout(); window.location.href = 'login.html'; });
  document.getElementById('changeBusiness').addEventListener('click', async () => {
    if (!confirm('Disconnect from this business and enter a new business key?')) return;
    await window.portal.clearBusiness();
    window.location.href = 'login.html';
  });
  document.getElementById('cSave').addEventListener('click', saveCustomer);
  document.getElementById('nSave').addEventListener('click', saveNewCustomer);
  document.getElementById('mSave').addEventListener('click', saveMenuItem);
  document.getElementById('xConfirm').addEventListener('click', confirmCancel);

  render();
})();

function switchTab(tab) {
  curTab = tab;
  document.querySelectorAll('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('rangeWrap').style.visibility = (tab === 'dashboard' || tab === 'rebates') ? 'visible' : 'hidden';
  render();
}

function render() {
  if (orderTimer) { clearInterval(orderTimer); orderTimer = null; }
  if (curTab === 'dashboard') return renderDashboard();
  if (curTab === 'inventory') return renderInventory();
  if (curTab === 'customers') return renderCustomers();
  if (curTab === 'storefront') return renderStorefront();
  if (curTab === 'orders') return renderOrders();
  if (curTab === 'rebates') return renderRebates();
  if (curTab === 'staff') return renderStaff();
}

// ── cashiers ────────────────────────────────────────────────────────────────
async function renderStaff() {
  const view = document.getElementById('view');
  view.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div class="h2" style="margin:0">Cashiers</div>
      <button class="btn btn-accent" id="addCashier">+ Add cashier</button>
    </div>
    <div class="muted" style="font-size:12px;margin-bottom:12px">Cashiers sign in on the register by PIN. Managers &amp; admins are set up on the POS by an admin.</div>
    <div id="staffWrap"><div class="spin">Loading…</div></div>`;
  document.getElementById('addCashier').addEventListener('click', () => openCashier(null));
  const r = await window.portal.staff();
  const wrap = document.getElementById('staffWrap');
  if (!r.success) { wrap.innerHTML = `<div class="card muted">${esc(r.error || 'Could not load staff')}</div>`; return; }
  const cashiers = (r.staff || []).filter((s) => s.role === 'cashier');
  const others = (r.staff || []).filter((s) => s.role !== 'cashier');
  wrap.innerHTML = `<div class="card" style="padding:0;overflow:hidden"><table class="grid"><tbody>${
    cashiers.length ? cashiers.map((s) => `<tr>
      <td>${esc(s.name || '—')}${s.is_active ? '' : ' <span style="font-size:10.5px;color:var(--muted);border:1px solid var(--line-soft);border-radius:999px;padding:1px 7px;margin-left:4px">inactive</span>'}${s.must_change_pin ? ' <span style="font-size:10.5px;color:#b8860b;background:rgba(224,161,58,.14);border-radius:999px;padding:1px 7px;margin-left:4px">temp PIN</span>' : ''}</td>
      <td class="num" style="width:200px">
        <button class="rowbtn" data-edit='${JSON.stringify(s).replace(/'/g, "&#39;")}'>Edit</button>
        <button class="rowbtn" data-pin="${esc(s.uid)}" data-name="${esc(s.name || '')}">Reset PIN</button>
      </td></tr>`).join('') : '<tr><td class="muted">No cashiers yet.</td></tr>'
  }</tbody></table></div>${
    others.length ? `<div class="muted" style="font-size:12px;margin-top:10px">${others.length} manager/admin account(s) — managed on the POS.</div>` : ''
  }`;
  wrap.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openCashier(JSON.parse(b.dataset.edit))));
  wrap.querySelectorAll('[data-pin]').forEach((b) => b.addEventListener('click', async () => {
    const pin = prompt(`New 4-digit PIN for ${b.dataset.name} (blank = auto-generate):`, '');
    if (pin === null) return;
    const r = await window.portal.updateCashier({ uid: b.dataset.pin, pin: pin.trim() || genPin4() });
    if (!r.success) return toast(r.error || 'Failed', true);
    alert(`New PIN for ${b.dataset.name}: ${r.pin}\n\nGive it to them — they change it on next sign-in.`);
    render();
  }));
}
function genPin4() { return Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join(''); }
function openCashier(s) {
  const name = prompt(s ? 'Rename cashier:' : 'New cashier name:', s ? (s.name || '') : '');
  if (name === null || !name.trim()) return;
  if (s) {
    window.portal.updateCashier({ uid: s.uid, name: name.trim() }).then((r) => { if (r.success) { toast('Saved'); render(); } else toast(r.error || 'Failed', true); });
  } else {
    const pin = prompt('4-digit PIN (blank = auto-generate):', '');
    if (pin === null) return;
    window.portal.createCashier({ name: name.trim(), pin: pin.trim() }).then((r) => {
      if (!r.success) return toast(r.error || 'Failed', true);
      alert(`Cashier "${name.trim()}" created.\nPIN: ${r.pin}\n\nGive it to them — they change it on next sign-in.`);
      render();
    });
  }
}

// ── rebates ─────────────────────────────────────────────────────────────────
async function renderRebates() {
  view.innerHTML = '<div class="spin">Loading rebate summary…</div>';
  const { start, end } = range();
  const r = await window.portal.rebates({ start, end });
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  const mfrs = r.manufacturers;
  const tApplied = mfrs.reduce((s, m) => s + Number(m.applied_amount || 0), 0);
  const tMissed = mfrs.reduce((s, m) => s + Number(m.missed_amount || 0), 0);
  const tAuto = mfrs.reduce((s, m) => s + Number(m.applied_auto || 0), 0);
  const tManual = mfrs.reduce((s, m) => s + Number(m.applied_manual || 0), 0);

  view.innerHTML = `
    <div class="kpi-row">
      <div class="kpi"><div class="lbl">Rebates claimed</div><div class="val green">${fmt(tApplied)}</div></div>
      <div class="kpi"><div class="lbl">Applied (auto / manual)</div><div class="val">${tAuto} / ${tManual}</div></div>
      <div class="kpi"><div class="lbl">Missed opportunities</div><div class="val red">${fmt(tMissed)}</div></div>
      <div class="kpi"><div class="lbl">Manufacturers</div><div class="val">${mfrs.length}</div></div>
    </div>
    <div class="h2">By manufacturer</div>
    <table class="grid">
      <thead><tr><th>Manufacturer</th><th class="num">Applied</th><th class="num">Auto/Manual</th><th class="num">Claimed $</th><th class="num">Missed</th><th class="num">Missed $</th><th>Last submission</th></tr></thead>
      <tbody>
        ${mfrs.length ? mfrs.map((m) => {
          const last = m.last_submission_at
            ? `${new Date(m.last_submission_at).toLocaleDateString()} <span class="muted">(${esc(m.last_submission_status || '')}, wk ${m.last_period_end || ''})</span>`
            : '<span class="red">never</span>';
          return `<tr>
            <td><strong>${esc(m.manufacturer_name || '—')}</strong></td>
            <td class="num">${m.applied_count || 0}</td>
            <td class="num muted">${m.applied_auto || 0} / ${m.applied_manual || 0}</td>
            <td class="num">${fmt(m.applied_amount)}</td>
            <td class="num ${Number(m.missed_count) ? 'low' : 'muted'}">${m.missed_count || 0}</td>
            <td class="num ${Number(m.missed_amount) ? 'low' : 'muted'}">${fmt(m.missed_amount)}</td>
            <td style="font-size:12.5px">${last}</td>
          </tr>`;
        }).join('') : '<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">No rebate activity in this range.</td></tr>'}
      </tbody>
    </table>`;
}

// ── dashboard ───────────────────────────────────────────────────────────────
async function renderDashboard() {
  view.innerHTML = '<div class="spin">Loading store totals…</div>';
  const { start, end } = range();
  const r = await window.portal.dashboard({ start, end });
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  const locs = r.locations;
  const totRev = locs.reduce((s, l) => s + Number(l.revenue || 0), 0);
  const totTxn = locs.reduce((s, l) => s + Number(l.txn_count || 0), 0);
  const dayAgo = Date.now() - 86400000;

  view.innerHTML = `
    <div class="kpi-row">
      <div class="kpi"><div class="lbl">Business revenue</div><div class="val green">${fmt(totRev)}</div></div>
      <div class="kpi"><div class="lbl">Transactions</div><div class="val">${totTxn}</div></div>
      <div class="kpi"><div class="lbl">Avg sale</div><div class="val">${fmt(totTxn ? totRev / totTxn : 0)}</div></div>
      <div class="kpi"><div class="lbl">Locations</div><div class="val">${locs.length}</div></div>
    </div>
    <div class="h2">Locations <span class="muted" style="font-weight:400;font-size:13px">— click a store for its full X/Z report</span></div>
    <div class="hgrid">
      ${locs.length ? locs.map((l) => {
        const stale = !l.last_txn_at || new Date(l.last_txn_at).getTime() < dayAgo;
        return `
        <div class="card click" onclick="openLocation('${esc(l.location_id)}','${esc(nameOf[l.location_id] || l.location_name || 'Location')}')">
          <div style="font-weight:800;margin-bottom:8px">${esc(nameOf[l.location_id] || l.location_name || 'Location')}</div>
          <div class="val green" style="font-size:22px">${fmt(l.revenue)}</div>
          <div class="muted" style="font-size:12.5px;margin-top:6px">${l.txn_count} sales · ${l.refund_count} refunds</div>
          <div style="margin-top:8px">${stale ? '<span class="pill flag">💤 No sales 24h</span>' : `<span class="muted" style="font-size:12px">Last sale ${new Date(l.last_txn_at).toLocaleString()}</span>`}</div>
        </div>`;
      }).join('') : '<div class="card muted">No sales in this range yet.</div>'}
    </div>`;
}

async function openLocation(id, name) {
  const modal = document.getElementById('repModal');
  document.getElementById('repTitle').textContent = name;
  document.getElementById('repBody').innerHTML = '<div class="spin">Loading…</div>';
  modal.style.display = 'flex';
  const { start, end } = range();
  const r = await window.portal.locationReport({ location_id: id, start, end });
  if (!r.success || !r.report) { document.getElementById('repBody').innerHTML = `<div class="muted">Couldn't load: ${esc(r.error || 'no data')}</div>`; return; }
  const rep = r.report, s = rep.summary, p = rep.payments;
  const payLines = [{ lbl: 'Cash', v: p.cash }].concat(p.brands.filter((b) => b.amount).map((b) => ({ lbl: b.brand, v: b.amount })));
  if (p.other_card && p.other_card.amount) payLines.push({ lbl: 'Other card', v: p.other_card.amount });
  document.getElementById('repBody').innerHTML = `
    <div class="kpi-row" style="margin-bottom:12px">
      <div class="kpi"><div class="lbl">Net collected</div><div class="val green">${fmt(s.total_collected)}</div></div>
      <div class="kpi"><div class="lbl">Sales</div><div class="val">${s.count}</div></div>
      <div class="kpi"><div class="lbl">Tax</div><div class="val">${fmt(s.tax)}</div></div>
    </div>
    <div class="h2" style="font-size:14px">Payments</div>
    <table class="grid"><tbody>
      ${payLines.map((l) => `<tr><td>${esc(l.lbl)}</td><td class="num">${fmt(l.v)}</td></tr>`).join('')}
      <tr><td class="muted">Refunds</td><td class="num">${rep.refunds.count ? fmt(rep.refunds.total) : '—'}</td></tr>
    </tbody></table>
    <div class="h2" style="font-size:14px;margin-top:14px">Top products</div>
    <table class="grid"><tbody>
      ${(rep.top_products || []).length ? rep.top_products.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${fmt(t.revenue)}</td></tr>`).join('') : '<tr><td class="muted">No sales</td></tr>'}
    </tbody></table>`;
}

// ── inventory ───────────────────────────────────────────────────────────────
async function renderInventory() {
  view.innerHTML = '<div class="spin">Loading inventory…</div>';
  const r = await window.portal.inventory();
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  const items = r.items;
  view.innerHTML = `
    <div class="h2">Inventory <span class="muted" style="font-weight:400;font-size:13px">— stock levels across all locations (reporting mirror)</span></div>
    <table class="grid">
      <thead><tr><th>Product</th><th>Location</th><th>Category</th><th class="num">Price</th><th class="num">Qty</th><th class="num">Reorder</th></tr></thead>
      <tbody>
        ${items.length ? items.map((i) => {
          const low = i.reorder_point != null && Number(i.quantity) <= Number(i.reorder_point);
          return `<tr>
            <td>${esc(i.name || '—')}</td>
            <td class="muted">${esc(nameOf[i.location_id] || '—')}</td>
            <td class="muted">${esc(i.category || '—')}</td>
            <td class="num">${fmt(i.price)}</td>
            <td class="num ${low ? 'low' : ''}">${i.quantity ?? 0}</td>
            <td class="num muted">${i.reorder_point ?? '—'}</td>
          </tr>`;
        }).join('') : '<tr><td colspan="6" class="muted" style="padding:24px;text-align:center">No inventory synced yet.</td></tr>'}
      </tbody>
    </table>`;
}

// ── customers ───────────────────────────────────────────────────────────────
let custCache = [];
async function renderCustomers() {
  view.innerHTML = '<div class="spin">Loading customers…</div>';
  const r = await window.portal.customers();
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  custCache = r.customers;
  view.innerHTML = `
    <div class="h2">Customers <span class="muted" style="font-weight:400;font-size:13px">— add & edit; changes sync down to registers</span></div>
    <div style="display:flex;gap:10px;align-items:center;margin-bottom:12px">
      <div class="fg" style="max-width:320px;margin:0;flex:1"><input id="custSearch" placeholder="Search name / phone / email…" /></div>
      <button class="btn btn-accent" onclick="openNewCustomer()">+ Add customer</button>
    </div>
    <table class="grid">
      <thead><tr><th>Name</th><th>Phone</th><th>Email</th><th class="num">Points</th><th>Gold</th><th></th></tr></thead>
      <tbody id="custRows"></tbody>
    </table>`;
  document.getElementById('custSearch').addEventListener('input', drawCustomers);
  drawCustomers();
}
function drawCustomers() {
  const q = (document.getElementById('custSearch')?.value || '').toLowerCase();
  const rows = custCache.filter((c) => !q || `${c.first_name} ${c.last_name} ${c.phone} ${c.email}`.toLowerCase().includes(q));
  document.getElementById('custRows').innerHTML = rows.length ? rows.map((c) => `
    <tr>
      <td>${esc(c.first_name || '')} ${esc(c.last_name || '')}</td>
      <td class="muted">${esc(c.phone || '—')}</td>
      <td class="muted">${esc(c.email || '—')}</td>
      <td class="num">${c.loyalty_points ?? 0}</td>
      <td>${c.gold_member ? '<span class="pill" style="background:#3a331a;color:#e2be6a">Gold</span>' : ''}</td>
      <td class="num"><button class="rowbtn" onclick='editCustomer(${JSON.stringify(c).replace(/'/g, "&#39;")})'>Edit</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="muted" style="padding:24px;text-align:center">No customers.</td></tr>';
}
function editCustomer(c) {
  document.getElementById('cUid').value = c.uid;
  document.getElementById('cFirst').value = c.first_name || '';
  document.getElementById('cLast').value = c.last_name || '';
  document.getElementById('cPhone').value = c.phone || '';
  document.getElementById('cEmail').value = c.email || '';
  document.getElementById('cPoints').value = c.loyalty_points ?? 0;
  document.getElementById('cGold').value = c.gold_member ? '1' : '0';
  document.getElementById('custModal').style.display = 'flex';
}
function openNewCustomer() {
  const sel = document.getElementById('nLocation');
  const locs = Object.entries(nameOf);
  if (!locs.length) { toast('No locations found for this business', true); return; }
  sel.innerHTML = locs.map(([id, name]) => `<option value="${id}">${esc(name)}</option>`).join('');
  document.getElementById('nFirst').value = '';
  document.getElementById('nLast').value = '';
  document.getElementById('nPhone').value = '';
  document.getElementById('nEmail').value = '';
  document.getElementById('newCustModal').style.display = 'flex';
}
async function saveNewCustomer() {
  const location_id = document.getElementById('nLocation').value;
  const fields = {
    first_name: document.getElementById('nFirst').value.trim(),
    last_name: document.getElementById('nLast').value.trim() || null,
    phone: document.getElementById('nPhone').value.trim() || null,
    email: document.getElementById('nEmail').value.trim() || null,
  };
  if (!fields.first_name) { toast('First name is required', true); return; }
  const btn = document.getElementById('nSave'); btn.disabled = true; btn.textContent = 'Creating…';
  const r = await window.portal.createCustomer({ location_id, fields });
  btn.disabled = false; btn.textContent = 'Create';
  if (!r.success) { toast(r.error || 'Create failed', true); return; }
  document.getElementById('newCustModal').style.display = 'none';
  toast('Customer added — syncing to that location');
  if (r.customer) custCache.unshift(r.customer);
  drawCustomers();
}

// ── storefront (online store control) ────────────────────────────────────────
let sfLocs = [];        // [{id,name,is_storefront_enabled,tax_rate}]
let menuCache = [];     // current location's menu items
let menuLoc = null;     // selected location for the menu builder

async function renderStorefront() {
  view.innerHTML = '<div class="spin">Loading storefront settings…</div>';
  const r = await window.portal.storefrontLocations();
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  sfLocs = r.locations;
  if (menuLoc == null) menuLoc = (sfLocs.find((l) => l.is_storefront_enabled) || sfLocs[0])?.id || null;

  view.innerHTML = `
    <div class="h2">Storefront <span class="muted" style="font-weight:400;font-size:13px">— set up payouts, turn a store's online shop on, set its tax rate, and pick what it sells</span></div>
    <table class="grid" style="margin-bottom:22px">
      <thead><tr><th>Location</th><th>Payouts (Stripe)</th><th>Online store</th><th class="num">Tax rate</th><th></th></tr></thead>
      <tbody>
        ${sfLocs.length ? sfLocs.map((l) => {
          const onboarded = !!l.stripe_onboarding_complete;
          const payoutCell = onboarded
            ? '<span class="pill" style="background:#1f3a25;color:#7fdca0">Ready</span>'
            : (l.stripe_account_id ? '<span class="pill flag">Incomplete</span>' : '<span class="pill flag">Not set up</span>');
          return `
          <tr>
            <td><strong>${esc(l.name)}</strong></td>
            <td>${payoutCell}
              <button class="rowbtn" onclick="stripeOnboard('${esc(l.id)}')">${onboarded ? 'Manage' : 'Set up'}</button>
              <button class="rowbtn" onclick="stripeRefresh('${esc(l.id)}')">Refresh</button>
            </td>
            <td>${l.is_storefront_enabled ? '<span class="pill" style="background:#1f3a25;color:#7fdca0">Live</span>' : '<span class="pill flag">Off</span>'}</td>
            <td class="num"><input data-tax="${esc(l.id)}" type="number" step="0.0001" value="${l.tax_rate ?? 0}" style="width:96px;text-align:right" /> <span class="muted" style="font-size:11px">(0.08 = 8%)</span></td>
            <td class="num">
              <button class="rowbtn" ${onboarded ? '' : 'disabled title="Complete Stripe payouts setup first"'} onclick="toggleStore('${esc(l.id)}', ${l.is_storefront_enabled ? 'false' : 'true'})">${l.is_storefront_enabled ? 'Turn off' : 'Turn on'}</button>
              <button class="rowbtn" onclick="saveTax('${esc(l.id)}')">Save tax</button>
            </td>
          </tr>`;
        }).join('') : '<tr><td colspan="5" class="muted" style="padding:24px;text-align:center">No locations.</td></tr>'}
      </tbody>
    </table>

    <div class="h2">Storefront listing <span class="muted" style="font-weight:400;font-size:13px">— the address and logo customers see when picking a store</span></div>
    <table class="grid" style="margin-bottom:22px">
      <thead><tr><th>Location</th><th>Address</th><th>Logo</th></tr></thead>
      <tbody>
        ${sfLocs.map((l) => `
          <tr>
            <td><strong>${esc(l.name)}</strong></td>
            <td><input data-addr="${esc(l.id)}" value="${esc(l.address || '')}" placeholder="123 Main St, City ST" style="width:190px" />
              <input data-zip="${esc(l.id)}" value="${esc(l.zip || '')}" placeholder="ZIP" style="width:64px" maxlength="10" />
              <button class="rowbtn" onclick="saveAddress('${esc(l.id)}')">Save</button></td>
            <td>
              ${l.logo_url ? `<img src="${esc(l.logo_url)}" alt="" style="width:30px;height:30px;border-radius:6px;object-fit:cover;vertical-align:middle;margin-right:6px" />` : '<span class="muted" style="margin-right:6px">bag icon</span>'}
              <button class="rowbtn" onclick="uploadLogo('${esc(l.id)}')">${l.logo_url ? 'Change' : 'Upload'}</button>
              <label style="font-size:12px;margin-left:8px;cursor:pointer"><input type="checkbox" ${l.show_logo ? 'checked' : ''} onchange="toggleLogo('${esc(l.id)}', this.checked)" /> show logo</label>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>

    <div class="h2">Online menu
      <select id="menuLocSel" style="margin-left:8px">
        ${sfLocs.map((l) => `<option value="${esc(l.id)}" ${l.id === menuLoc ? 'selected' : ''}>${esc(l.name)}</option>`).join('')}
      </select>
      <span class="muted" style="font-weight:400;font-size:13px">— tick a product to sell it online; set an override price if it should differ from in-store</span>
    </div>
    <div class="fg" style="max-width:340px;margin:0 0 10px"><input id="menuSearch" placeholder="Search products…" /></div>
    <table class="grid">
      <thead><tr><th style="width:60px">Online</th><th style="width:64px">Photo</th><th>Product</th><th>Category</th><th class="num">In-store</th><th class="num">Online price</th><th class="num">On hand</th></tr></thead>
      <tbody id="menuRows"><tr><td colspan="7" class="spin">Loading menu…</td></tr></tbody>
    </table>`;

  document.getElementById('menuLocSel').addEventListener('change', (e) => { menuLoc = e.target.value; loadMenu(); });
  document.getElementById('menuSearch').addEventListener('input', drawMenu);
  loadMenu();
}

async function toggleStore(id, enable) {
  const r = await window.portal.setStorefront({ location_id: id, enabled: enable });
  if (!r.success) {
    const msg = /stripe_onboarding_required/.test(r.error || '') ? 'Finish Stripe payouts setup before going live.' : (r.error || 'Failed');
    toast(msg, true); return;
  }
  toast(enable ? 'Store is live online' : 'Store taken offline');
  renderStorefront();
}

// Stripe Express onboarding: open the hosted flow (or the account dashboard) in
// the browser, then refresh status when the manager returns.
async function stripeOnboard(id) {
  toast('Opening Stripe…');
  const onboarded = !!sfLocs.find((l) => l.id === id)?.stripe_onboarding_complete;
  const r = await window.portal.stripeConnect({ action: onboarded ? 'login' : 'onboard', location_id: id });
  if (!r.success || !r.url) { toast(r.error || 'Could not start Stripe onboarding', true); return; }
  window.portal.openExternal(r.url);
}
async function stripeRefresh(id) {
  const r = await window.portal.stripeConnect({ action: 'status', location_id: id });
  if (!r.success) { toast(r.error || 'Could not refresh', true); return; }
  toast(r.onboarded ? 'Payouts ready' : 'Onboarding still incomplete', !r.onboarded);
  renderStorefront();
}

// ── storefront listing branding (address + logo) ──────────────────────────────
async function saveAddress(id) {
  const address = document.querySelector(`[data-addr="${id}"]`).value.trim();
  const zip = document.querySelector(`[data-zip="${id}"]`).value.trim();
  const r = await window.portal.setBranding({ location_id: id, address, zip });
  if (r.success) { const l = sfLocs.find((x) => x.id === id); if (l) { l.address = address; l.zip = zip; } }
  toast(r.success ? 'Address saved' : (r.error || 'Failed'), !r.success);
}
async function toggleLogo(id, show) {
  const r = await window.portal.setBranding({ location_id: id, show_logo: show });
  if (!r.success) { toast(r.error || 'Failed', true); renderStorefront(); return; }
  const l = sfLocs.find((x) => x.id === id); if (l) l.show_logo = show;
  toast(show ? 'Logo shown on listing' : 'Using default icon');
}
function uploadLogo(id) {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files && input.files[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Image too large (max 5MB)', true); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result).split(',')[1];
      const ext = (file.name.split('.').pop() || 'png');
      toast('Uploading logo…');
      const r = await window.portal.uploadLocationLogo({ location_id: id, base64, ext, contentType: file.type });
      if (!r.success) { toast(r.error || 'Upload failed', true); return; }
      toast('Logo updated'); renderStorefront();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}
async function saveTax(id) {
  const el = document.querySelector(`[data-tax="${id}"]`);
  const rate = Number(el.value);
  if (!(rate >= 0 && rate < 1)) { toast('Tax rate must be a fraction, e.g. 0.08', true); return; }
  const r = await window.portal.setStorefront({ location_id: id, enabled: sfLocs.find((l) => l.id === id)?.is_storefront_enabled, tax_rate: rate });
  toast(r.success ? 'Tax rate saved' : (r.error || 'Failed'), !r.success);
}

async function loadMenu() {
  if (!menuLoc) { document.getElementById('menuRows').innerHTML = '<tr><td colspan="7" class="muted">Pick a location.</td></tr>'; return; }
  const r = await window.portal.menu({ location_id: menuLoc });
  if (!r.success) { document.getElementById('menuRows').innerHTML = `<tr><td colspan="7" class="muted">Couldn't load: ${esc(r.error)}</td></tr>`; return; }
  menuCache = r.items;
  drawMenu();
}
function drawMenu() {
  const q = (document.getElementById('menuSearch')?.value || '').toLowerCase();
  const rows = menuCache.filter((i) => !q || `${i.name} ${i.category} ${i.barcode}`.toLowerCase().includes(q));
  document.getElementById('menuRows').innerHTML = rows.length ? rows.map((i) => {
    const bc = esc(i.barcode);
    const online = i.override_price != null ? fmt(i.override_price) : `<span class="muted">${fmt(i.price)}</span>`;
    const thumb = i.image_url
      ? `<img src="${esc(i.image_url)}" alt="" style="width:40px;height:40px;border-radius:8px;object-fit:cover;background:var(--panel-2)" />`
      : `<div style="width:40px;height:40px;border-radius:8px;background:var(--panel-2);display:grid;place-items:center;color:var(--faint)">—</div>`;
    return `<tr>
      <td><input type="checkbox" ${i.is_visible ? 'checked' : ''} onchange="toggleMenu('${bc}', this.checked)" /></td>
      <td>${thumb}<button class="rowbtn" style="margin-top:4px" onclick="uploadImage('${bc}')">${i.image_url ? 'Change' : 'Add'}</button></td>
      <td>${esc(i.name || i.barcode)}</td>
      <td class="muted">${esc(i.category || '—')}</td>
      <td class="num muted">${fmt(i.price)}</td>
      <td class="num">${online} <button class="rowbtn" onclick='openMenuPrice(${JSON.stringify(i).replace(/'/g, "&#39;")})'>Set</button></td>
      <td class="num ${Number(i.quantity) <= 0 ? 'low' : ''}">${i.quantity ?? 0}</td>
    </tr>`;
  }).join('') : '<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">No products with a barcode at this location.</td></tr>';
}

// Product photo (item 11): pick a file, upload it, and show it on this + every
// location's menu and the storefront. Business-wide by barcode.
function uploadImage(barcode) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Image too large (max 5MB)', true); return; }
    const reader = new FileReader();
    reader.onload = async () => {
      const base64 = String(reader.result).split(',')[1];
      const ext = (file.name.split('.').pop() || 'jpg');
      toast('Uploading photo…');
      const r = await window.portal.uploadProductImage({ barcode, base64, ext, contentType: file.type });
      if (!r.success) { toast(r.error || 'Upload failed', true); return; }
      const item = menuCache.find((i) => i.barcode === barcode);
      if (item) item.image_url = r.image_url;
      toast('Photo updated'); drawMenu();
    };
    reader.readAsDataURL(file);
  };
  input.click();
}
async function toggleMenu(barcode, visible) {
  const item = menuCache.find((i) => i.barcode === barcode);
  const r = await window.portal.setMenuItem({ location_id: menuLoc, barcode, is_visible: visible, override_price: item?.override_price ?? null });
  if (!r.success) { toast(r.error || 'Failed', true); loadMenu(); return; }
  if (item) item.is_visible = visible;
  toast(visible ? 'Now selling online' : 'Removed from online menu');
}
function openMenuPrice(i) {
  document.getElementById('mBarcode').value = i.barcode;
  document.getElementById('mTitle').textContent = i.name || i.barcode;
  document.getElementById('mSub').textContent = `In-store price ${fmt(i.price)}`;
  document.getElementById('mPrice').value = i.override_price ?? '';
  document.getElementById('menuModal').style.display = 'flex';
}
async function saveMenuItem() {
  const barcode = document.getElementById('mBarcode').value;
  const raw = document.getElementById('mPrice').value.trim();
  const item = menuCache.find((i) => i.barcode === barcode);
  const btn = document.getElementById('mSave'); btn.disabled = true; btn.textContent = 'Saving…';
  const r = await window.portal.setMenuItem({ location_id: menuLoc, barcode, is_visible: item?.is_visible ?? false, override_price: raw === '' ? null : raw });
  btn.disabled = false; btn.textContent = 'Save';
  if (!r.success) { toast(r.error || 'Failed', true); return; }
  document.getElementById('menuModal').style.display = 'none';
  if (item) item.override_price = raw === '' ? null : Number(raw);
  toast('Online price updated');
  drawMenu();
}

// ── online orders queue ──────────────────────────────────────────────────────
const OSTAT = {
  new: { label: 'New', cls: 'flag' },
  preparing: { label: 'Preparing', cls: '' },
  ready: { label: 'Ready', cls: '' },
};
async function renderOrders() {
  view.innerHTML = '<div class="spin">Loading online orders…</div>';
  await drawOrders();
  orderTimer = setInterval(() => { if (curTab === 'orders') drawOrders(); }, 20000);
}
async function drawOrders() {
  const r = await window.portal.orders({});
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  const orders = r.orders;
  view.innerHTML = `
    <div class="h2">Online orders <span class="muted" style="font-weight:400;font-size:13px">— pickup queue across all locations · refreshes automatically</span></div>
    ${orders.length ? `<div class="hgrid">${orders.map(orderCard).join('')}</div>`
      : '<div class="card muted">No open online orders.</div>'}`;
}
function orderCard(o) {
  const s = OSTAT[o.status] || OSTAT.new;
  const items = (o.online_order_items || []).map((i) => `${i.qty}× ${esc(i.name || '')}`).join(', ');
  const next = o.status === 'new'
    ? `<button class="btn btn-accent" onclick="advanceOrder('${o.id}','preparing')">Start preparing</button>`
    : o.status === 'preparing'
      ? `<button class="btn btn-accent" onclick="advanceOrder('${o.id}','ready')">Mark ready (texts customer)</button>`
      : `<span class="muted" style="font-size:12px">Customer notified · awaiting pickup</span>`;
  return `
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div style="font-weight:800">#${esc(o.order_number)}</div>
        <span class="pill ${s.cls}">${s.label}</span>
      </div>
      <div class="muted" style="font-size:12.5px;margin-top:4px">${esc(nameOf[o.location_id] || 'Location')}</div>
      <div style="font-size:13px;margin-top:8px">${items || '<span class="muted">—</span>'}</div>
      <div style="margin-top:6px"><strong>${fmt(o.total)}</strong> <span class="muted" style="font-size:12px">· ${new Date(o.created_at).toLocaleString()}</span></div>
      <div class="row" style="justify-content:space-between;align-items:center;margin-top:12px">
        ${next}
        <button class="rowbtn" onclick="openCancel('${o.id}','${esc(o.order_number)}')">Cancel</button>
      </div>
    </div>`;
}
async function advanceOrder(id, status) {
  const r = await window.portal.orderStatus({ order_id: id, status });
  if (!r.success) { toast(r.error || 'Failed', true); return; }
  toast(status === 'ready' ? 'Marked ready — customer texted' : 'Order updated');
  drawOrders();
}
function openCancel(id, number) {
  document.getElementById('xOrder').value = id;
  document.getElementById('xSub').textContent = `Order #${number}`;
  document.getElementById('xReason').value = '';
  document.getElementById('cancelModal').style.display = 'flex';
}
async function confirmCancel() {
  const id = document.getElementById('xOrder').value;
  const reason = document.getElementById('xReason').value.trim() || null;
  const btn = document.getElementById('xConfirm'); btn.disabled = true; btn.textContent = 'Cancelling…';
  const r = await window.portal.orderStatus({ order_id: id, status: 'cancelled', cancel_reason: reason });
  btn.disabled = false; btn.textContent = 'Cancel & refund';
  if (!r.success) { toast(r.error || 'Failed', true); return; }
  document.getElementById('cancelModal').style.display = 'none';
  toast(r.result && r.result.refunded ? 'Cancelled & refunded' : 'Order cancelled');
  drawOrders();
}

async function saveCustomer() {
  const uid = document.getElementById('cUid').value;
  const fields = {
    first_name: document.getElementById('cFirst').value.trim(),
    last_name: document.getElementById('cLast').value.trim(),
    phone: document.getElementById('cPhone').value.trim() || null,
    email: document.getElementById('cEmail').value.trim() || null,
    loyalty_points: parseInt(document.getElementById('cPoints').value, 10) || 0,
    gold_member: document.getElementById('cGold').value === '1',
  };
  const btn = document.getElementById('cSave'); btn.disabled = true; btn.textContent = 'Saving…';
  const r = await window.portal.updateCustomer({ uid, fields });
  btn.disabled = false; btn.textContent = 'Save';
  if (!r.success) { toast(r.error || 'Save failed', true); return; }
  document.getElementById('custModal').style.display = 'none';
  toast('Saved — will sync to registers');
  // reflect locally
  const idx = custCache.findIndex((c) => c.uid === uid);
  if (idx >= 0) custCache[idx] = { ...custCache[idx], ...fields };
  drawCustomers();
}
