
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const view = document.getElementById('view');
let nameOf = {};        
let curTab = 'dashboard';
let orderTimer = null;  
let currentStoreId = null; 

function toast(msg, isErr) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.className = 'toast show' + (isErr ? ' err' : '');
  setTimeout(() => { t.className = 'toast'; }, 2600);
}

function isoDate(d) { const x = new Date(d); x.setMinutes(x.getMinutes() - x.getTimezoneOffset()); return x.toISOString().slice(0, 10); }
function range() { return { start: document.getElementById('startDate').value, end: document.getElementById('endDate').value }; }


let sessionFeatures = [];
function isFeatureEnabled(feature) {
  return sessionFeatures.length === 0 || sessionFeatures.includes(feature);
}


(async function boot() {
  const s = await window.portal.session();
  if (!s.success || !s.session) { window.location.href = 'login.html'; return; }
  document.getElementById('bizLabel').textContent = 'Business · ' + (s.session.tenant_id || '').slice(0, 8);
  
  
  currentStoreId = s.currentLocationId || null;

  
  sessionFeatures = s.session.features || [];
  if (!isFeatureEnabled('rebate_reporting')) document.querySelector('.navbtn[data-tab="rebates"]')?.style.setProperty('display', 'none', 'important');
  if (!isFeatureEnabled('web_store')) {
    document.querySelector('.navbtn[data-tab="storefront"]')?.style.setProperty('display', 'none', 'important');
    document.querySelector('.navbtn[data-tab="orders"]')?.style.setProperty('display', 'none', 'important');
  }

  const today = new Date();
  document.getElementById('endDate').value = isoDate(today);
  document.getElementById('startDate').value = isoDate(today).slice(0, 8) + '01';

  const loc = await window.portal.locations();
  if (loc.success) {
    for (const l of loc.locations) nameOf[l.id] = l.name;
    document.getElementById('storeLabel').textContent = currentStoreId ? (nameOf[currentStoreId] || 'Store') : 'All stores';
  }
  document.getElementById('storeLabel').addEventListener('click', () => { window.location.href = 'login.html'; });

  document.querySelectorAll('.navbtn').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  document.getElementById('applyRange').addEventListener('click', () => render());
  document.getElementById('logout').addEventListener('click', async () => { await window.portal.logout(); window.location.href = 'login.html'; });
  document.getElementById('cSave').addEventListener('click', saveCustomer);
  document.getElementById('nSave').addEventListener('click', saveNewCustomer);
  document.getElementById('mSave').addEventListener('click', saveMenuItem);
  document.getElementById('xConfirm').addEventListener('click', confirmCancel);
  document.getElementById('seSave').addEventListener('click', saveStaffEdit);

  render();
})();

function switchTab(tab) {
  curTab = tab;
  document.querySelectorAll('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('rangeWrap').style.visibility = (tab === 'dashboard' || tab === 'rebates' || tab === 'timesheets') ? 'visible' : 'hidden';
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
  if (curTab === 'timesheets') return renderTimesheet();
  if (curTab === 'customization') return renderCustomization();
}


let tsPunches = []; 
async function renderTimesheet() {
  view.innerHTML = '<div class="spin">Loading timesheet…</div>';
  const { start, end } = range();
  const r = await window.portal.timesheet({ start, end });
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  
  const punches = currentStoreId ? r.punches.filter((p) => p.location_id === currentStoreId) : r.punches;
  tsPunches = punches;

  
  
  
  const byEmp = {};
  const now = Date.now();
  for (const p of punches) {
    const key = p.employee_uid;
    byEmp[key] = byEmp[key] || { uid: key, name: p.employee_name || 'Employee', shifts: 0, hours: 0, openSince: null };
    const inMs = new Date(p.clock_in).getTime();
    const outMs = p.clock_out ? new Date(p.clock_out).getTime() : now;
    byEmp[key].shifts += 1;
    byEmp[key].hours += Math.max(0, (outMs - inMs) / 3600000);
    if (!p.clock_out) byEmp[key].openSince = p.clock_in;
  }
  const rows = Object.values(byEmp).sort((a, b) => b.hours - a.hours);
  const totalHours = rows.reduce((s, e) => s + e.hours, 0);

  view.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
      <div class="h2" style="margin:0">Timesheets <span class="muted" style="font-weight:400;font-size:13px">— ${currentStoreId ? esc(nameOf[currentStoreId] || 'this store') : 'all locations'}, clock-in/out punches for the selected range</span></div>
      <button class="btn btn-accent" id="tsAddBtn">+ Add shift</button>
    </div>
    <div class="kpi-row">
      <div class="kpi"><div class="lbl">Total hours</div><div class="val">${totalHours.toFixed(1)}</div></div>
      <div class="kpi"><div class="lbl">Employees</div><div class="val">${rows.length}</div></div>
      <div class="kpi"><div class="lbl">Shifts</div><div class="val">${punches.length}</div></div>
    </div>
    <table class="grid">
      <thead><tr><th>Employee</th><th class="num">Shifts</th><th class="num">Hours</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.length ? rows.map((e) => `<tr>
          <td>${esc(e.name)}</td>
          <td class="num muted">${e.shifts}</td>
          <td class="num" style="font-weight:700">${e.hours.toFixed(1)}</td>
          <td>${e.openSince ? `<span class="pill solid-good">Clocked in since ${new Date(e.openSince).toLocaleString()}</span>` : ''}</td>
          <td class="num"><button class="rowbtn" data-adjust="${esc(e.uid)}" data-name="${esc(e.name)}">Adjust</button></td>
        </tr>`).join('') : '<tr><td colspan="5" class="muted" style="padding:24px;text-align:center">No punches in this range.</td></tr>'}
      </tbody>
    </table>`;
  view.querySelectorAll('[data-adjust]').forEach((b) => b.addEventListener('click', () => openTimesheetAdjust(b.dataset.adjust, b.dataset.name)));
  document.getElementById('tsAddBtn').addEventListener('click', openTimesheetAdd);
}


async function openTimesheetAdd() {
  const sel = document.getElementById('tsAddEmployee');
  sel.innerHTML = '<option>Loading…</option>';
  document.getElementById('tsAddIn').value = '';
  document.getElementById('tsAddOut').value = '';
  document.getElementById('tsAddModal').style.display = 'flex';
  const r = await window.portal.staff();
  const staff = (r.success ? r.staff || [] : []).filter((s) => s.is_active);
  sel.innerHTML = staff.length
    ? staff.map((s) => `<option value="${esc(s.uid)}" data-name="${esc(s.name || s.username || '')}">${esc(s.name || s.username || '—')} (${esc(s.role)})</option>`).join('')
    : '<option value="">No active staff</option>';
}
document.getElementById('tsAddSave')?.addEventListener('click', async () => {
  const btn = document.getElementById('tsAddSave');
  const sel = document.getElementById('tsAddEmployee');
  const uid = sel.value;
  const name = sel.selectedOptions[0]?.dataset.name || '';
  const inVal = document.getElementById('tsAddIn').value;
  const outVal = document.getElementById('tsAddOut').value;
  if (!uid) return toast('Pick an employee', true);
  if (!inVal) return toast('Clock-in time is required', true);
  btn.disabled = true; btn.textContent = 'Adding…';
  const r = await window.portal.addTimeClock({
    employee_uid: uid, employee_name: name,
    clock_in: new Date(inVal).toISOString(), clock_out: outVal ? new Date(outVal).toISOString() : null,
  });
  btn.disabled = false; btn.textContent = 'Add shift';
  if (!r.success) return toast(r.error || 'Failed', true);
  document.getElementById('tsAddModal').style.display = 'none';
  toast('Shift added — applies on the register’s next sync');
  render();
});


function isoToLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

function openTimesheetAdjust(employeeUid, name) {
  document.getElementById('tsTitle').textContent = `Adjust punches — ${name}`;
  const rows = tsPunches.filter((p) => p.employee_uid === employeeUid).sort((a, b) => new Date(b.clock_in) - new Date(a.clock_in));
  const wrap = document.getElementById('tsRows');
  wrap.innerHTML = rows.length ? rows.map((p) => `
    <div class="card" style="padding:12px;margin-bottom:10px">
      <div class="row">
        <div class="fg" style="flex:1"><label>Clock in</label><input type="datetime-local" data-in="${esc(p.uid)}" value="${isoToLocalInput(p.clock_in)}" /></div>
        <div class="fg" style="flex:1"><label>Clock out ${p.clock_out ? '' : '(blank = still clocked in)'}</label><input type="datetime-local" data-out="${esc(p.uid)}" value="${isoToLocalInput(p.clock_out)}" /></div>
      </div>
      <div class="row" style="justify-content:space-between;margin-top:4px">
        <button class="rowbtn" data-save-punch="${esc(p.uid)}">Save</button>
        <button class="rowbtn" style="color:var(--bad)" data-delete-punch="${esc(p.uid)}">Delete shift</button>
      </div>
    </div>`).join('') : '<div class="muted">No punches for this employee in range.</div>';
  wrap.querySelectorAll('[data-save-punch]').forEach((btn) => btn.addEventListener('click', async () => {
    const uid = btn.dataset.savePunch;
    const inVal = wrap.querySelector(`[data-in="${uid}"]`).value;
    const outVal = wrap.querySelector(`[data-out="${uid}"]`).value;
    if (!inVal) return toast('Clock-in time is required', true);
    btn.disabled = true; btn.textContent = 'Saving…';
    const r = await window.portal.adjustTimeClock({ uid, clock_in: new Date(inVal).toISOString(), clock_out: outVal ? new Date(outVal).toISOString() : null });
    btn.disabled = false; btn.textContent = 'Save';
    if (!r.success) return toast(r.error || 'Failed', true);
    toast('Punch updated — applies on the register’s next sync');
    render();
  }));
  wrap.querySelectorAll('[data-delete-punch]').forEach((btn) => btn.addEventListener('click', async () => {
    if (!confirm('Delete this shift entirely? This removes it from hours and tip-pool calculations. This cannot be undone from here.')) return;
    const uid = btn.dataset.deletePunch;
    btn.disabled = true; btn.textContent = 'Deleting…';
    const r = await window.portal.deleteTimeClock({ uid });
    if (!r.success) { btn.disabled = false; btn.textContent = 'Delete shift'; return toast(r.error || 'Failed', true); }
    toast('Shift deleted — applies on the register’s next sync');
    document.getElementById('tsModal').style.display = 'none';
    render();
  }));
  document.getElementById('tsModal').style.display = 'flex';
}


async function renderStaff() {
  const view = document.getElementById('view');
  view.innerHTML = `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div class="h2" style="margin:0">Staff</div>
      <div class="row">
        <button class="btn" id="addManager">+ Add manager</button>
        <button class="btn btn-accent" id="addCashier">+ Add cashier</button>
      </div>
    </div>
    <div class="muted" style="font-size:12px;margin-bottom:12px">Cashiers sign in on the register by PIN. Managers sign in with a username + password (POS start-of-day and this portal).</div>
    <div id="staffWrap"><div class="spin">Loading…</div></div>`;
  document.getElementById('addCashier').addEventListener('click', () => openCashier());
  document.getElementById('addManager').addEventListener('click', () => openManager());
  const r = await window.portal.staff();
  const wrap = document.getElementById('staffWrap');
  if (!r.success) { wrap.innerHTML = `<div class="card muted">${esc(r.error || 'Could not load staff')}</div>`; return; }
  
  
  
  
  
  
  
  const staffList = (r.staff || []).filter((s) => s.is_active);
  const removedList = (r.staff || []).filter((s) => !s.is_active);
  wrap.innerHTML = `<div class="card" style="padding:0;overflow:hidden"><table class="grid"><tbody>${
    staffList.length ? staffList.map((s) => {
      const isAdmin = s.role === 'admin';
      const isCashier = s.role === 'cashier';
      const tempBadge = (isCashier ? s.must_change_pin : s.must_change_password)
        ? ` <span style="font-size:10.5px;color:var(--warn);background:rgba(156,107,18,.1);border-radius:var(--radius-sm);padding:1px 7px;margin-left:4px">temp ${isCashier ? 'PIN' : 'password'}</span>` : '';
      return `<tr>
      <td>${esc(s.name || s.username || '—')}
        <span class="badge ${isAdmin ? 'warn' : 'dim'}" style="margin-left:6px">${esc(s.role)}</span>
        ${tempBadge}</td>
      <td class="num" style="width:260px">${isAdmin ? '<span class="muted" style="font-size:12px">managed on the POS</span>' : `
        <button class="rowbtn" data-edit='${JSON.stringify(s).replace(/'/g, "&#39;")}'>Edit</button>
        <button class="rowbtn" data-reset="${esc(s.uid)}" data-name="${esc(s.name || '')}" data-role="${esc(s.role)}">Reset ${isCashier ? 'PIN' : 'password'}</button>
        <button class="rowbtn" style="color:var(--bad)" data-delete="${esc(s.uid)}" data-name="${esc(s.name || '')}">Delete</button>
      `}</td></tr>`;
    }).join('') : '<tr><td class="muted">No staff yet.</td></tr>'
  }</tbody></table></div>
  ${removedList.length ? `
  <details style="margin-top:14px">
    <summary style="cursor:pointer;font-size:12.5px;color:var(--muted);font-weight:600">Removed staff (${removedList.length}) — click to show</summary>
    <div class="card" style="padding:0;overflow:hidden;margin-top:8px"><table class="grid"><tbody>${
      removedList.map((s) => `<tr>
        <td class="muted">${esc(s.name || s.username || '—')}
          <span class="badge dim" style="margin-left:6px">${esc(s.role)}</span></td>
        <td class="num" style="width:260px">
          <button class="rowbtn" data-reactivate="${esc(s.uid)}" data-name="${esc(s.name || '')}">Reactivate</button>
          <button class="rowbtn" style="color:var(--bad)" data-permadelete="${esc(s.uid)}" data-name="${esc(s.name || '')}">Delete Permanently</button>
        </td></tr>`).join('')
    }</tbody></table></div>
  </details>` : ''}`;
  wrap.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => openStaffEdit(JSON.parse(b.dataset.edit))));
  wrap.querySelectorAll('[data-reset]').forEach((b) => b.addEventListener('click', () => {
    openResetCred(b.dataset.reset, b.dataset.name, b.dataset.role === 'cashier');
  }));
  wrap.querySelectorAll('[data-delete]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Remove ${b.dataset.name || 'this user'}? They immediately lose register and portal access.`)) return;
    const r = await window.portal.deleteStaff({ uid: b.dataset.delete });
    if (!r.success) return toast(r.error || 'Failed', true);
    toast('Removed'); render();
  }));
  wrap.querySelectorAll('[data-reactivate]').forEach((b) => b.addEventListener('click', async () => {
    const r = await window.portal.reactivateStaff({ uid: b.dataset.reactivate });
    if (!r.success) return toast(r.error || 'Failed', true);
    toast(`${b.dataset.name || 'Staff member'} reactivated`); render();
  }));
  wrap.querySelectorAll('[data-permadelete]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm(`Permanently delete ${b.dataset.name || 'this user'}? This cannot be undone — there is no way back, unlike Remove.`)) return;
    const r = await window.portal.permanentlyDeleteStaff({ uid: b.dataset.permadelete });
    if (!r.success) return toast(r.error || 'Failed', true);
    toast(`${b.dataset.name || 'Staff member'} permanently deleted`); render();
  }));
}
function genPassword() {
  const a = 'abcdefghjkmnpqrstuvwxyz', d = '23456789';
  const pick = (s, n) => Array.from({ length: n }, () => s[Math.floor(Math.random() * s.length)]).join('');
  return `${pick(a, 6)}-${pick(d, 4)}`;
}

const TIMEZONE_OPTIONS = [
  { value: 'America/New_York', label: 'Eastern Time' },
  { value: 'America/Chicago', label: 'Central Time' },
  { value: 'America/Denver', label: 'Mountain Time' },
  { value: 'America/Phoenix', label: 'Mountain Time — Arizona (no DST)' },
  { value: 'America/Los_Angeles', label: 'Pacific Time' },
  { value: 'America/Anchorage', label: 'Alaska Time' },
  { value: 'Pacific/Honolulu', label: 'Hawaii Time' },
];

const PERM_LABELS = {
  apply_discount: 'Apply discount', process_refund: 'Process refund', override_price: 'Override price',
  inventory_adjust: 'Adjust inventory', view_reports: 'View reports', manage_rebates: 'Manage rebates',
  open_drawer_no_sale: 'Open drawer (no sale)', clock_others: 'Clock others in/out',
};
const MENU_LABELS = {
  access_merchandise: 'Merchandise (inventory)', access_receipts: 'Receipts',
  access_customer_lookup: 'Customer Lookup', access_pickups: 'Online Pickups',
};

function openStaffEdit(s) {
  document.getElementById('seTitle').textContent = `Edit ${s.role === 'manager' ? 'manager' : 'cashier'} — ${s.name || s.username || ''}`;
  document.getElementById('seUid').value = s.uid;
  document.getElementById('seName').value = s.name || '';
  document.getElementById('seActive').checked = !!s.is_active;
  const perms = s.permissions || {};
  const isCashier = s.role === 'cashier';
  const permRows = Object.entries(PERM_LABELS).map(([k, label]) => `
    <label class="permtog"><input type="checkbox" data-perm="${k}" ${perms[k]?.is_granted ? 'checked' : ''} /><span>${esc(label)}</span></label>`).join('');
  const menuRows = isCashier ? Object.entries(MENU_LABELS).map(([k, label]) => {
    const on = perms[k] ? !!perms[k].is_granted : true; 
    return `<label class="permtog"><input type="checkbox" data-perm="${k}" ${on ? 'checked' : ''} /><span>${esc(label)}</span></label>`;
  }).join('') : '';
  document.getElementById('sePermsWrap').innerHTML = `
    <div class="perm-sub">Permissions</div><div class="permgrid">${permRows}</div>
    ${isCashier ? `<div class="perm-sub">Menu access — on by default</div><div class="permgrid">${menuRows}</div>` : ''}`;
  document.getElementById('sePermsWrap').querySelectorAll('[data-perm]').forEach((cb) => cb.addEventListener('change', async () => {
    cb.disabled = true;
    const r = await window.portal.setStaffPermission({ employee_uid: s.uid, permission_key: cb.dataset.perm, is_granted: cb.checked });
    cb.disabled = false;
    if (r.success) toast('Permission updated — applies on the register’s next sync');
    else { cb.checked = !cb.checked; toast(r.error || 'Failed', true); }
  }));
  openModal('staffEditModal');
}
async function saveStaffEdit() {
  const uid = document.getElementById('seUid').value;
  const name = document.getElementById('seName').value.trim();
  const is_active = document.getElementById('seActive').checked;
  if (!name) return toast('Name is required', true);
  const r = await window.portal.updateCashier({ uid, name, is_active });
  if (!r.success) return toast(r.error || 'Failed', true);
  closeModal('staffEditModal');
  toast('Saved'); render();
}
function openModal(id) { document.getElementById(id).style.display = 'flex'; }
function closeModal(id) { document.getElementById(id).style.display = 'none'; }


function openResetCred(uid, name, isCashier) {
  document.getElementById('rcUid').value = uid;
  document.getElementById('rcIsCashier').value = isCashier ? '1' : '0';
  document.getElementById('rcTitle').textContent = `Reset ${isCashier ? 'PIN' : 'password'} — ${name}`;
  document.getElementById('rcLabel').textContent = isCashier
    ? 'New 4-digit PIN (blank = auto-generate)' : 'New password (blank = auto-generate)';
  document.getElementById('rcValue').value = '';
  openModal('resetCredModal');
}
document.getElementById('rcSave').addEventListener('click', async () => {
  const uid = document.getElementById('rcUid').value;
  const isCashier = document.getElementById('rcIsCashier').value === '1';
  const name = document.getElementById('rcTitle').textContent.split(' — ')[1] || '';
  const val = document.getElementById('rcValue').value.trim();
  
  
  
  const r = isCashier
    ? await window.portal.updateCashier({ uid, pin: val })
    : await window.portal.updateCashier({ uid, password: val });
  if (!r.success) return toast(r.error || 'Failed', true);
  closeModal('resetCredModal');
  alert(isCashier
    ? `New PIN for ${name}: ${r.pin}\n\nGive it to them — they change it on next sign-in.`
    : `New password for ${name}: ${r.password}\n\nGive it to them — they change it on next sign-in.`);
  render();
});

function openManager() {
  document.getElementById('amName').value = '';
  document.getElementById('amUsername').value = '';
  openModal('addManagerModal');
}
document.getElementById('amSave').addEventListener('click', async () => {
  const name = document.getElementById('amName').value.trim();
  const username = document.getElementById('amUsername').value.trim();
  if (!name || !username) return toast('Name and username are required', true);
  const password = genPassword();
  const r = await window.portal.createManager({ name, username, password });
  if (!r.success) return toast(r.error || 'Failed', true);
  closeModal('addManagerModal');
  alert(`Manager "${name}" created.\nUsername: ${username}\nPassword: ${password}\n\nGive it to them — they change it on next sign-in.`);
  render();
});


function openCashier() {
  document.getElementById('acName').value = '';
  document.getElementById('acPin').value = '';
  openModal('addCashierModal');
}
document.getElementById('acSave').addEventListener('click', async () => {
  const name = document.getElementById('acName').value.trim();
  if (!name) return toast('Name is required', true);
  const pin = document.getElementById('acPin').value.trim();
  const r = await window.portal.createCashier({ name, pin });
  if (!r.success) return toast(r.error || 'Failed', true);
  closeModal('addCashierModal');
  alert(`Cashier "${name}" created.\nPIN: ${r.pin}\n\nGive it to them — they change it on next sign-in.`);
  render();
});


const CUST_METRIC_CATALOG = {
  revenue: 'Revenue', profit: 'Profit (visible to whichever role you assign it to)',
  sales: 'Sales today', avg_ticket: 'Avg ticket', tax_collected: 'Tax collected',
  discounts_given: 'Discounts given', refunds_today: 'Refunds / exchanges',
};
const CUST_TILE_CATALOG = {
  receipts: 'Receipts', merchandise: 'Merchandise', 'customer-lookup': 'Customer Lookup',
  timeclock: 'Time Clock', pickups: 'Online Pickups', xzout: 'X / Z Out',
};
const CUST_DEFAULT_TILE_ORDER = ['receipts', 'merchandise', 'customer-lookup', 'timeclock', 'pickups', 'xzout'];
const CUST_ROLES = ['cashier', 'manager', 'admin'];

let custConfigs = {};      
let custRole = 'cashier';
let custSlots = [null, null, null];   
let custTiles = [];                    
let custDragFrom = null;

async function renderCustomization() {
  view.innerHTML = '<div class="spin">Loading layout config…</div>';
  const r = await window.portal.getLayoutConfig();
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  custConfigs = {};
  for (const c of r.configs) custConfigs[c.role] = { report_slots: c.report_slots || null, tile_order: c.tile_order || null };
  custLoadRoleState(custRole);

  view.innerHTML = `
    <div class="card">
      <h3 style="margin:0 0 4px">POS Main-Screen Customization</h3>
      <div class="muted" style="font-size:12.5px;margin-bottom:16px">
        Choose what each role sees on the register's main screen. Saves reach every register on its next sync
        (about a minute) — no app restart needed.
      </div>
      <div class="row" style="gap:8px;margin-bottom:20px" id="custRoleTabs">
        ${CUST_ROLES.map((rl) => `<button class="rowbtn cust-role-btn${rl === custRole ? ' active' : ''}" data-role="${rl}" style="${rl === custRole ? 'border-color:var(--accent-line);color:var(--ink)' : ''}">${rl[0].toUpperCase() + rl.slice(1)}</button>`).join('')}
      </div>
      <div style="display:grid;grid-template-columns:1fr 340px;gap:28px;align-items:start">
        <div>
          <div class="perm-sub">Top report tiles — 3 slots, blank until set</div>
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:22px" id="custSlots"></div>

          <div class="perm-sub">Shortcut tiles — drag to reorder, uncheck to hide</div>
          <div id="custTileList" style="display:flex;flex-direction:column;gap:6px;margin-bottom:20px"></div>

          <button class="btn btn-accent" id="custSaveBtn">Save layout for ${custRole}</button>
          <span class="muted" id="custSavedNote" style="font-size:12px;margin-left:10px"></span>
        </div>
        <div>
          <div class="perm-sub">Live preview</div>
          <div id="custPreview"></div>
        </div>
      </div>
    </div>`;

  custRenderSlots();
  custRenderTileList();
  custRenderPreview();

  document.querySelectorAll('.cust-role-btn').forEach((b) => b.addEventListener('click', () => {
    custRole = b.dataset.role;
    renderCustomization();
  }));
  document.getElementById('custSaveBtn').addEventListener('click', custSave);
}

function custLoadRoleState(role) {
  const saved = custConfigs[role] || { report_slots: null, tile_order: null };
  const slots = Array.isArray(saved.report_slots) ? saved.report_slots.slice(0, 3) : [];
  while (slots.length < 3) slots.push(null);
  custSlots = slots;
  const order = Array.isArray(saved.tile_order) && saved.tile_order.length ? saved.tile_order : CUST_DEFAULT_TILE_ORDER;
  const enabledSet = new Set(order.filter((k) => CUST_TILE_CATALOG[k]));
  
  
  
  const rest = Object.keys(CUST_TILE_CATALOG).filter((k) => !enabledSet.has(k));
  custTiles = [...order.filter((k) => CUST_TILE_CATALOG[k]).map((k) => ({ key: k, enabled: true })),
               ...rest.map((k) => ({ key: k, enabled: false }))];
}

function custRenderSlots() {
  document.getElementById('custSlots').innerHTML = custSlots.map((val, i) => `
    <div class="fg">
      <label>Slot ${i + 1}</label>
      <select data-slot="${i}">
        <option value="">— Blank —</option>
        ${Object.entries(CUST_METRIC_CATALOG).map(([k, label]) => `<option value="${k}" ${val === k ? 'selected' : ''}>${esc(label)}</option>`).join('')}
      </select>
    </div>`).join('');
  document.querySelectorAll('#custSlots select').forEach((sel) => sel.addEventListener('change', () => {
    custSlots[Number(sel.dataset.slot)] = sel.value || null;
    custRenderPreview();
  }));
}

function custRenderTileList() {
  document.getElementById('custTileList').innerHTML = custTiles.map((t, i) => `
    <div class="permtog" draggable="true" data-i="${i}" style="justify-content:space-between;cursor:grab">
      <span style="display:flex;align-items:center;gap:8px">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.5"><line x1="4" y1="8" x2="20" y2="8"/><line x1="4" y1="16" x2="20" y2="16"/></svg>
        ${esc(CUST_TILE_CATALOG[t.key])}
      </span>
      <input type="checkbox" data-key="${t.key}" ${t.enabled ? 'checked' : ''} />
    </div>`).join('');

  document.querySelectorAll('#custTileList input[type=checkbox]').forEach((cb) => cb.addEventListener('change', () => {
    const row = custTiles.find((t) => t.key === cb.dataset.key);
    if (row) row.enabled = cb.checked;
    custRenderPreview();
  }));
  document.querySelectorAll('#custTileList [draggable]').forEach((el) => {
    el.addEventListener('dragstart', () => { custDragFrom = Number(el.dataset.i); });
    el.addEventListener('dragover', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => {
      e.preventDefault();
      const to = Number(el.dataset.i);
      if (custDragFrom === null || custDragFrom === to) return;
      const [moved] = custTiles.splice(custDragFrom, 1);
      custTiles.splice(to, 0, moved);
      custDragFrom = null;
      custRenderTileList();
      custRenderPreview();
    });
  });
}

function custRenderPreview() {
  const slotHtml = custSlots.map((k) => k
    ? `<div style="flex:1;background:#2a2e35;border-radius:8px;padding:8px 10px"><div style="font-size:9px;text-transform:uppercase;letter-spacing:.05em;color:#9aa1ab">${esc(CUST_METRIC_CATALOG[k].split(' (')[0])}</div><div style="font-size:15px;font-weight:800;color:#fff;margin-top:2px">—</div></div>`
    : `<div style="flex:1;border:1px dashed #454b55;border-radius:8px;min-height:44px"></div>`
  ).join('');
  const tileHtml = custTiles.filter((t) => t.enabled).map((t) => `
    <div style="background:linear-gradient(180deg,#2f343c,#1c2026);border-radius:9px;padding:10px 8px;text-align:center">
      <div style="width:26px;height:26px;border-radius:50%;background:#591a24;margin:0 auto 6px"></div>
      <div style="font-size:11px;font-weight:700;color:#fff">${esc(CUST_TILE_CATALOG[t.key])}</div>
    </div>`).join('') || `<div class="muted" style="font-size:12px;grid-column:1/-1;text-align:center;padding:14px 0">No shortcut tiles enabled</div>`;

  document.getElementById('custPreview').innerHTML = `
    <div style="background:#f4ede1;border-radius:14px;padding:14px">
      <div style="display:flex;gap:8px;margin-bottom:10px">${slotHtml}</div>
      <div style="background:#1f7a3d;border-radius:8px;padding:8px;text-align:center;color:#fff;font-size:11px;font-weight:800;margin-bottom:10px">New Sale</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">${tileHtml}</div>
    </div>`;
}

async function custSave() {
  const btn = document.getElementById('custSaveBtn');
  btn.disabled = true; btn.textContent = 'Saving…';
  const tile_order = custTiles.filter((t) => t.enabled).map((t) => t.key);
  const r = await window.portal.setLayoutConfig({ role: custRole, report_slots: custSlots, tile_order });
  btn.disabled = false; btn.textContent = `Save layout for ${custRole}`;
  if (!r.success) { toast(r.error || 'Save failed', true); return; }
  custConfigs[custRole] = { report_slots: custSlots.slice(), tile_order };
  document.getElementById('custSavedNote').textContent = 'Saved — applies on registers within a minute.';
  toast('Layout saved');
}


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
      <div class="kpi kpi-primary"><div class="lbl">Missed opportunities</div><div class="val red">${fmt(tMissed)}</div><div class="muted" style="font-size:11.5px;margin-top:2px">rebates you qualified for but didn't claim</div></div>
      <div class="kpi"><div class="lbl">Rebates claimed</div><div class="val green">${fmt(tApplied)}</div></div>
      <div class="kpi"><div class="lbl">Applied (auto / manual)</div><div class="val">${tAuto} / ${tManual}</div></div>
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


async function renderDashboard() {
  view.innerHTML =
    '<div class="kpi-row">' + '<div class="kpi"><div class="ru-skel ru-skel-text ru-w-60" style="height:11px"></div><div class="ru-skel ru-skel-text ru-w-80" style="height:22px;margin-top:8px"></div></div>'.repeat(4) + '</div>' +
    '<div class="h2">Locations</div>' + RackdUI.skeleton.cardsHtml(3);
  const { start, end } = range();
  const r = await window.portal.dashboard({ start, end });
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  
  
  const locs = currentStoreId ? r.locations.filter((l) => l.location_id === currentStoreId) : r.locations;
  
  
  
  const netOf = (l) => Number(l.net_revenue != null ? l.net_revenue : l.revenue || 0);
  const totRev = locs.reduce((s, l) => s + netOf(l), 0);
  const totFee = locs.reduce((s, l) => s + Number(l.merchant_fee_amount || 0), 0);
  const totTxn = locs.reduce((s, l) => s + Number(l.txn_count || 0), 0);
  const dayAgo = Date.now() - 86400000;

  view.innerHTML = `
    <div class="kpi-row">
      <div class="kpi kpi-primary"><div class="lbl">Business revenue</div><div class="val green">${fmt(totRev)}</div>${totFee ? `<div class="muted" style="font-size:11.5px;margin-top:2px">after ${fmt(totFee)} processing fees</div>` : ''}</div>
      <div class="kpi"><div class="lbl">Transactions</div><div class="val">${totTxn}</div></div>
      <div class="kpi"><div class="lbl">Avg sale</div><div class="val">${fmt(totTxn ? totRev / totTxn : 0)}</div></div>
      <div class="kpi"><div class="lbl">Locations</div><div class="val">${locs.length}</div></div>
    </div>
    <div class="h2">Locations <span class="muted" style="font-weight:400;font-size:13px">— click a store for its full X/Z report</span></div>
    <div class="hgrid">
      ${locs.length ? locs.map((l) => {
        const stale = !l.last_txn_at || new Date(l.last_txn_at).getTime() < dayAgo;
        const fee = Number(l.merchant_fee_amount || 0);
        return `
        <div class="card click" onclick="openLocation('${esc(l.location_id)}','${esc(nameOf[l.location_id] || l.location_name || 'Location')}')">
          <div style="font-weight:800;margin-bottom:8px">${esc(nameOf[l.location_id] || l.location_name || 'Location')}</div>
          <div class="val green" style="font-size:22px">${fmt(netOf(l))}</div>
          ${fee ? `<div class="muted" style="font-size:11.5px">after ${fmt(fee)} processing fees</div>` : ''}
          <div class="muted" style="font-size:12.5px;margin-top:6px">${l.txn_count} sales · ${l.refund_count} refunds</div>
          <div style="margin-top:8px">${stale ? '<span class="pill flag">💤 No sales 24h</span>' : `<span class="muted" style="font-size:12px">Last sale ${new Date(l.last_txn_at).toLocaleString()}</span>`}</div>
        </div>`;
      }).join('') : '<div class="card muted">No sales in this range yet.</div>'}
    </div>`;
  RackdUI.fadeIn(view);
}

async function openLocation(id, name) {
  const modal = document.getElementById('repModal');
  document.getElementById('repTitle').textContent = name;
  document.getElementById('repBody').innerHTML = RackdUI.skeleton.rowsHtml(4);
  modal.style.display = 'flex';
  const { start, end } = range();
  const [r, locsRes, salesRes] = await Promise.all([
    window.portal.locationReport({ location_id: id, start, end }),
    RackdUI.cache.get('portal:storefrontLocations', () => window.portal.storefrontLocations(), 30000),
    window.portal.locationSales({ location_id: id, start, end }),
  ]);
  if (!r.success || !r.report) { document.getElementById('repBody').innerHTML = `<div class="muted">Couldn't load: ${esc(r.error || 'no data')}</div>`; return; }
  const rep = r.report, s = rep.summary, p = rep.payments;
  const payLines = [{ lbl: 'Cash', v: p.cash }].concat(p.brands.filter((b) => b.amount).map((b) => ({ lbl: b.brand, v: b.amount })));
  if (p.other_card && p.other_card.amount) payLines.push({ lbl: 'Other card', v: p.other_card.amount });
  
  
  const netRevenue = s.net_revenue != null ? s.net_revenue : s.total_collected;
  const feeAmount = Number(s.merchant_fee_amount || 0);
  const loc = (locsRes.success ? locsRes.locations : []).find((l) => l.id === id);
  const batchTime = (loc && loc.batch_time) ? String(loc.batch_time).slice(0, 5) : '';
  const timezone = (loc && loc.timezone) || 'America/Chicago';
  document.getElementById('repBody').innerHTML = `
    <div class="kpi-row" style="margin-bottom:12px">
      <div class="kpi kpi-primary"><div class="lbl">Net collected</div><div class="val green">${fmt(netRevenue)}</div>${feeAmount ? `<div class="muted" style="font-size:11.5px;margin-top:2px">after ${fmt(feeAmount)} processing fees (${s.merchant_fee_pct}%${s.merchant_fee_flat_cents ? ' + ' + fmt(s.merchant_fee_flat_cents / 100) + '/txn' : ''})</div>` : ''}</div>
      <div class="kpi"><div class="lbl">Sales</div><div class="val">${s.count}</div></div>
      <div class="kpi"><div class="lbl">Tax</div><div class="val">${fmt(s.tax)}</div></div>
    </div>
    <div class="h2" style="font-size:14px">Payments</div>
    <table class="grid"><tbody>
      ${payLines.map((l) => `<tr><td>${esc(l.lbl)}</td><td class="num">${fmt(l.v)}</td></tr>`).join('')}
      ${feeAmount ? `<tr><td class="muted">Processing fees</td><td class="num muted">-${fmt(feeAmount)}</td></tr>` : ''}
      <tr><td class="muted">Refunds</td><td class="num">${rep.refunds.count ? fmt(rep.refunds.total) : '—'}</td></tr>
    </tbody></table>
    <div class="h2" style="font-size:14px;margin-top:14px">Top products</div>
    <table class="grid"><tbody>
      ${(rep.top_products || []).length ? rep.top_products.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${fmt(t.revenue)}</td></tr>`).join('') : '<tr><td class="muted">No sales</td></tr>'}
    </tbody></table>
    <div class="h2" style="font-size:14px;margin-top:14px">Recent Sales</div>
    <div style="max-height:280px;overflow-y:auto">
      <table class="grid"><tbody>
        ${salesRes.success && salesRes.sales.length ? salesRes.sales.map((t) => `<tr>
          <td class="muted" style="font-size:12.5px">${new Date(t.created_at).toLocaleString()}</td>
          <td class="muted" style="font-size:12.5px">${esc(t.payment_method === 'cash' ? 'Cash' : (t.card_type || 'Card'))}</td>
          <td class="num" style="${Number(t.total) < 0 ? 'color:var(--bad)' : ''}">${fmt(t.total)}</td>
        </tr>`).join('') : `<tr><td class="muted">${salesRes.success ? 'No sales in this range' : esc(salesRes.error || 'Could not load sales')}</td></tr>`}
      </tbody></table>
      ${salesRes.success && salesRes.sales.length === 200 ? '<div class="muted" style="font-size:11.5px;margin-top:4px">Showing the most recent 200 — narrow the date range to see fewer, more specific results.</div>' : ''}
    </div>
    <div class="h2" style="font-size:14px;margin-top:14px">Timezone</div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Every day-boundary calculation for this location — batch time below, X/Z reports, receipts, loyalty/promo expiry — is interpreted in this timezone.</div>
    <div class="rowflex">
      <select id="timezoneInput" style="width:auto">
        ${TIMEZONE_OPTIONS.map((tz) => `<option value="${esc(tz.value)}" ${tz.value === timezone ? 'selected' : ''}>${esc(tz.label)}</option>`).join('')}
      </select>
      <button class="btn btn-accent" id="timezoneSave" data-loc="${esc(id)}">Save</button>
    </div>
    <div class="h2" style="font-size:14px;margin-top:14px">Business day close-out <span class="muted" style="font-weight:400;font-size:12px">(${esc(timezone)} time)</span></div>
    <div class="muted" style="font-size:12px;margin-bottom:8px">Automatically runs a Z report and closes the day at this time. Leave blank to keep closing out manually on the register.</div>
    <div class="rowflex">
      <input type="time" id="batchTimeInput" value="${esc(batchTime)}" style="width:auto" />
      <button class="btn btn-accent" id="batchTimeSave" data-loc="${esc(id)}">Save</button>
    </div>`;
  document.getElementById('timezoneSave').addEventListener('click', async () => {
    const btn = document.getElementById('timezoneSave');
    const val = document.getElementById('timezoneInput').value;
    btn.disabled = true; btn.textContent = 'Saving…';
    const res = await window.portal.setTimezone({ location_id: id, timezone: val });
    btn.disabled = false; btn.textContent = 'Save';
    if (!res.success) { toast(res.error || 'Failed', true); return; }
    RackdUI.cache.invalidate('portal:storefrontLocations');
    toast(`Timezone set to ${val} — takes effect on this register's next sync`);
    openLocation(id, name);
  });
  document.getElementById('batchTimeSave').addEventListener('click', async () => {
    const btn = document.getElementById('batchTimeSave');
    const val = document.getElementById('batchTimeInput').value;
    btn.disabled = true; btn.textContent = 'Saving…';
    const res = await window.portal.setBatchTime({ location_id: id, batch_time: val || null });
    btn.disabled = false; btn.textContent = 'Save';
    if (!res.success) { toast(res.error || 'Failed', true); return; }
    RackdUI.cache.invalidate('portal:storefrontLocations');
    toast(val ? `Batch time set to ${val}` : 'Batch time cleared — closing out manually');
  });
  RackdUI.fadeIn(document.getElementById('repBody'));
}


let invCache = [];

async function renderInventory() {
  view.innerHTML = '<table class="grid"><tbody>' + RackdUI.skeleton.tableRowsHtml(7, 8) + '</tbody></table>';
  const r = await RackdUI.cache.get('portal:inventory', () => window.portal.inventory(), 30000);
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  
  invCache = currentStoreId ? r.items.filter((i) => i.location_id === currentStoreId) : r.items;
  drawInventory();
}
function drawInventory() {
  const items = invCache;
  view.innerHTML = `
    <div class="h2">Inventory <span class="muted" style="font-weight:400;font-size:13px">— ${currentStoreId ? esc(nameOf[currentStoreId] || 'this store') : 'all locations'} · adjustments sync to the register</span></div>
    <table class="grid">
      <thead><tr><th>Product</th><th>Location</th><th>Category</th><th class="num">Price</th><th class="num">Qty</th><th class="num">Reorder</th><th class="num">Adjust</th></tr></thead>
      <tbody>
        ${items.length ? items.map((i) => {
          const low = i.reorder_point != null && Number(i.quantity) <= Number(i.reorder_point);
          const canAdjust = !!i.barcode; // stock_movements match by barcode — nothing to sync against without one
          return `<tr>
            <td>${esc(i.name || '—')}</td>
            <td class="muted">${esc(nameOf[i.location_id] || '—')}</td>
            <td class="muted">${esc(i.category || '—')}</td>
            <td class="num">${fmt(i.price)}</td>
            <td class="num ${low ? 'low' : ''}" id="qty-${esc(i.id)}">${i.quantity ?? 0}</td>
            <td class="num muted">${i.reorder_point ?? '—'}</td>
            <td class="num">
              ${canAdjust ? `
                <input type="number" data-delta="${esc(i.id)}" placeholder="±qty" style="width:64px;text-align:right" />
                <button class="rowbtn" data-adjust="${esc(i.id)}">Apply</button>
              ` : '<span class="muted" title="No barcode on this item — can\'t sync an adjustment">—</span>'}
            </td>
          </tr>`;
        }).join('') : '<tr><td colspan="7" class="muted" style="padding:24px;text-align:center">No inventory synced yet.</td></tr>'}
      </tbody>
    </table>`;
  RackdUI.fadeIn(view);
  view.querySelectorAll('[data-adjust]').forEach((btn) => btn.addEventListener('click', async () => {
    const id = btn.dataset.adjust;
    const item = items.find((x) => String(x.id) === id);
    const input = view.querySelector(`[data-delta="${id}"]`);
    const delta = Number(input.value);
    if (!item || !delta) { toast('Enter a non-zero quantity change', true); return; }
    btn.disabled = true; btn.textContent = '…';
    const r = await window.portal.adjustStock({ location_id: item.location_id, barcode: item.barcode, delta });
    btn.disabled = false; btn.textContent = 'Apply';
    if (!r.success) { toast(r.error || 'Failed', true); return; }
    item.quantity = r.quantity;
    RackdUI.cache.invalidate('portal:inventory'); 
    input.value = '';
    document.getElementById(`qty-${id}`).textContent = r.quantity;
    toast(`${delta > 0 ? '+' : ''}${delta} applied — syncs to the register on its next check-in`);
  }));
}


let custCache = [];
async function renderCustomers() {
  view.innerHTML = '<div class="spin">Loading customers…</div>';
  const r = await window.portal.customers();
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  
  
  
  
  
  
  custCache = currentStoreId
    ? r.customers.filter((c) => c.location_id === currentStoreId || c.location_id == null)
    : r.customers;
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
      <td>${c.gold_member ? '<span class="pill solid-gold">Gold</span>' : ''}</td>
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


let sfLocs = [];        
let menuCache = [];     
let menuLoc = null;     

async function renderStorefront() {
  view.innerHTML = RackdUI.skeleton.cardsHtml(3);
  const r = await RackdUI.cache.get('portal:storefrontLocations', () => window.portal.storefrontLocations(), 30000);
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  sfLocs = r.locations;
  
  
  if (menuLoc == null) menuLoc = (sfLocs.find((l) => l.id === currentStoreId) || sfLocs.find((l) => l.is_storefront_enabled) || sfLocs[0])?.id || null;

  view.innerHTML = `
    <div class="h2">Storefront</div>
    <table class="grid" style="margin-bottom:22px">
      <thead><tr><th>Location</th><th>Payouts (Stripe)</th><th>Online store</th><th class="num">Tax rate</th><th></th></tr></thead>
      <tbody>
        ${sfLocs.length ? sfLocs.map((l) => {
          const onboarded = !!l.stripe_onboarding_complete;
          const payoutCell = onboarded
            ? '<span class="pill solid-good">Ready</span>'
            : (l.stripe_account_id ? '<span class="pill flag">Incomplete</span>' : '<span class="pill flag">Not set up</span>');
          return `
          <tr>
            <td><strong>${esc(l.name)}</strong></td>
            <td title="Set up by the owner in the Owner Console — not manager-editable">${payoutCell}</td>
            <td>${l.is_storefront_enabled ? '<span class="pill solid-good">Live</span>' : '<span class="pill flag">Off</span>'}</td>
            <td class="num" title="Set automatically from the store's address — not manager-editable">${((l.tax_rate ?? 0) * 100).toFixed(2)}%</td>
            <td class="num">
              <button class="rowbtn" ${onboarded ? '' : 'disabled title="The owner needs to finish Stripe payouts setup in the Owner Console first"'} onclick="toggleStore('${esc(l.id)}', ${l.is_storefront_enabled ? 'false' : 'true'})">${l.is_storefront_enabled ? 'Turn off' : 'Turn on'}</button>
              ${onboarded ? '' : '<div class="muted" style="font-size:11px;margin-top:4px;max-width:160px">Owner must finish Stripe payouts setup first</div>'}
            </td>
          </tr>`;
        }).join('') : '<tr><td colspan="5" class="muted" style="padding:24px;text-align:center">No locations.</td></tr>'}
      </tbody>
    </table>

    <div class="h2">Storefront listing</div>
    <table class="grid" style="margin-bottom:22px">
      <thead><tr><th>Location</th><th>Address</th><th>Logo</th></tr></thead>
      <tbody>
        ${sfLocs.map((l) => `
          <tr>
            <td><strong>${esc(l.name)}</strong></td>
            <td class="muted" title="Set by the owner in the Owner Console — not manager-editable">${esc(l.address || 'Not set yet — set by the owner')}</td>
            <td style="white-space:nowrap">
              <span style="display:inline-flex;align-items:center;gap:6px">
                ${l.logo_url ? `<img src="${esc(l.logo_url)}" alt="" style="width:30px;height:30px;border-radius:6px;object-fit:cover" />` : '<span class="muted">default icon</span>'}
                <button class="rowbtn" onclick="uploadLogo('${esc(l.id)}')">${l.logo_url ? 'Change' : 'Add store logo'}</button>
                ${l.logo_url ? `<button class="rowbtn" onclick="clearLogo('${esc(l.id)}')">Remove</button>` : ''}
              </span>
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
  RackdUI.cache.invalidate('portal:storefrontLocations');
  renderStorefront();
}




async function clearLogo(id) {
  if (!confirm('Remove this location\'s logo? The listing will show the default icon instead.')) return;
  const r = await window.portal.setBranding({ location_id: id, clear_logo: true });
  if (!r.success) { toast(r.error || 'Failed', true); return; }
  const l = sfLocs.find((x) => x.id === id); if (l) { l.logo_url = null; l.show_logo = false; }
  toast('Logo removed — using default icon');
  renderStorefront();
}

function resizeImageFile(file, maxDim = 800, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error('resize failed')); return; }
        const reader = new FileReader();
        reader.onload = () => resolve({ base64: String(reader.result).split(',')[1], contentType: 'image/jpeg', ext: 'jpg' });
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('could not read image')); };
    img.src = url;
  });
}

function uploadLogo(id) {
  const input = document.createElement('input'); input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files && input.files[0]; if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Image too large (max 5MB)', true); return; }
    (async () => {
      toast('Uploading logo…');
      let base64, ext, contentType;
      try { ({ base64, ext, contentType } = await resizeImageFile(file)); }
      catch { toast('Could not process that image', true); return; }
      const r = await window.portal.uploadLocationLogo({ location_id: id, base64, ext, contentType });
      if (!r.success) { toast(r.error || 'Upload failed', true); return; }
      toast('Logo updated'); RackdUI.cache.invalidate('portal:storefrontLocations'); renderStorefront();
    })();
  };
  input.click();
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
      ? `<img src="${esc(i.image_url)}" alt="" style="width:40px;height:40px;border-radius:var(--radius-sm);object-fit:cover;background:var(--panel-2)" />`
      : `<div style="width:40px;height:40px;border-radius:var(--radius-sm);background:var(--panel-2);display:grid;place-items:center;color:var(--faint)">—</div>`;
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


function uploadImage(barcode) {
  const input = document.createElement('input');
  input.type = 'file'; input.accept = 'image/*';
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('Image too large (max 5MB)', true); return; }
    (async () => {
      toast('Uploading photo…');
      let base64, ext, contentType;
      try { ({ base64, ext, contentType } = await resizeImageFile(file)); }
      catch { toast('Could not process that image', true); return; }
      const r = await window.portal.uploadProductImage({ barcode, base64, ext, contentType });
      if (!r.success) { toast(r.error || 'Upload failed', true); return; }
      const item = menuCache.find((i) => i.barcode === barcode);
      if (item) item.image_url = r.image_url;
      toast('Photo updated'); drawMenu();
    })();
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
let currentOrders = []; 
async function drawOrders() {
  
  const r = await window.portal.orders({ location_id: currentStoreId || undefined });
  if (!r.success) { view.innerHTML = `<div class="card">Couldn't load: ${esc(r.error)}</div>`; return; }
  currentOrders = r.orders;
  renderOrdersList();
}
function renderOrdersList() {
  view.innerHTML = `
    <div class="h2">Online orders <span class="muted" style="font-weight:400;font-size:13px">— pickup queue at ${currentStoreId ? esc(nameOf[currentStoreId] || 'this store') : 'all locations'} · refreshes automatically</span></div>
    ${currentOrders.length ? `<div class="hgrid">${currentOrders.map(orderCard).join('')}</div>`
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
  const order = currentOrders.find((o) => o.id === id);
  if (!order) return;
  const prevStatus = order.status;
  
  
  
  
  await RackdUI.optimistic(
    null,
    () => { order.status = status; renderOrdersList(); },
    () => window.portal.orderStatus({ order_id: id, status }),
    () => { order.status = prevStatus; renderOrdersList(); },
    'Could not update that order — change was undone'
  ).then(() => { if (status === 'ready') toast('Marked ready — customer texted'); }).catch(() => {});
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
  
  const idx = custCache.findIndex((c) => c.uid === uid);
  if (idx >= 0) custCache[idx] = { ...custCache[idx], ...fields };
  drawCustomers();
}
