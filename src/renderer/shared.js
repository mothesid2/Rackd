


(function remoteErrorCapture() {
  if (!window.api || !window.api.reportError) return;
  function send(message, stack) {
    try { window.api.reportError({ message: String(message || 'Unknown error'), stack: stack ? String(stack) : undefined, page: location.pathname }); }
    catch {  }
  }
  window.addEventListener('error', (e) => {
    send(e.message, e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    send(reason && reason.message ? reason.message : String(reason), reason && reason.stack);
  });
})();


function fmt(n) {
  return '$' + Number(n || 0).toFixed(2);
}

const TZ = 'America/Chicago';


function fmtDate(str) {
  if (!str) return '';
  return new Date(str).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', timeZone: TZ
  });
}

function fmtTime(str) {
  if (!str) return '';
  return new Date(str).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', timeZone: TZ
  });
}

function fmtDateTime(str) {
  if (!str) return '';
  return fmtDate(str) + '  ' + fmtTime(str);
}

function nowCTTimeString() {
  return new Date().toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ
  });
}

function nowCTDateString() {
  return new Date().toLocaleDateString('en-US', {
    weekday: 'short', year: 'numeric', month: 'long', day: 'numeric', timeZone: TZ
  });
}


let _lastStatusDateStr = null;
async function updateStatusBar() {
  const res = await window.api.getSession();
  const session = res.session;
  const leftEl = document.getElementById('status-left');
  const rightEl = document.getElementById('status-right');

  if (leftEl) {
    leftEl.innerHTML = session
      ? `Logged in: <span class="status-role">${session.name || session.username}</span>`
      : 'Not logged in';
  }

  if (rightEl) {
    
    
    let timeEl = rightEl.querySelector('.status-time');
    let dateEl = rightEl.querySelector('.status-date');
    if (!timeEl || !dateEl) {
      rightEl.innerHTML = '<span class="status-time"></span>&nbsp;&nbsp;<span class="status-date"></span>';
      timeEl = rightEl.querySelector('.status-time');
      dateEl = rightEl.querySelector('.status-date');
    }
    timeEl.textContent = nowCTTimeString();
    const dateStr = nowCTDateString();
    if (dateStr !== _lastStatusDateStr) {
      dateEl.textContent = dateStr;
      _lastStatusDateStr = dateStr;
    }
  }
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}


let _featuresCache = null;
async function loadFeatures() {
  if (_featuresCache) return _featuresCache;
  try {
    const r = await window.api.licenseStatus();
    _featuresCache = (r.success && r.status && r.status.features) || [];
  } catch { _featuresCache = []; }
  return _featuresCache;
}
function isFeatureEnabled(feature) {
  
  
  
  
  
  
  if (!_featuresCache || _featuresCache.length === 0) return true;
  return _featuresCache.includes(feature);
}


async function enforceMenuAccess(key) {
  try {
    const me = await window.api.permsMe();
    if (me.success && me.menuAccess && me.menuAccess[key] === false) {
      window.api.navigate('main-menu');
      return false;
    }
  } catch {  }
  return true;
}


function showToast(message, type = 'info', duration = 3500) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = `toast ${type === 'error' ? 'error' : type === 'success' ? 'success' : type === 'warning' ? 'warning' : ''}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}


async function navigate(page) {
  await window.api.navigate(page);
}


function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}


function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


function buildAddProductPayload() {
  return {
    barcode: document.getElementById('ap-barcode').value.trim() || undefined,
    name: document.getElementById('ap-name').value.trim(),
    category: document.getElementById('ap-category').value.trim() || undefined,
    vendor: document.getElementById('ap-vendor').value.trim() || undefined,
    price: parseFloat(document.getElementById('ap-price').value) || 0,
    cost: parseFloat(document.getElementById('ap-cost').value) || 0,
    stock_qty: parseInt(document.getElementById('ap-stock').value) || 0,
    low_stock_threshold: parseInt(document.getElementById('ap-threshold').value) || 5,
    age_restricted: document.getElementById('ap-age').checked ? 1 : 0,
    low_stock_alert: document.getElementById('ap-lowalert').checked ? 1 : 0,
    is_taxable: document.getElementById('ap-taxable').checked ? 1 : 0,
  };
}


async function catalogAutoFill(barcodeElId, statusElId) {
  const barcode = document.getElementById(barcodeElId).value.trim();
  const statusEl = document.getElementById(statusElId);
  if (!barcode) { statusEl.textContent = ''; return; }
  const res = await window.api.catalogLookup({ barcode });
  if (!res || !res.success) { statusEl.textContent = ''; return; }
  if (res.confidence === 'not_found' || !res.item) {
    statusEl.innerHTML = '<span style="color:var(--warn)">Not in catalog — enter details manually.</span>';
    return;
  }
  const it = res.item;
  const fill = (id, val) => { const el = document.getElementById(id); if (el && !el.value && val != null && val !== '') el.value = val; };
  fill('ap-name', it.product_name);
  fill('ap-category', it.category);
  fill('ap-vendor', it.brand);
  if (it.suggested_retail_price != null) fill('ap-price', it.suggested_retail_price);
  if (it.unit_cost != null) fill('ap-cost', it.unit_cost);
  statusEl.innerHTML = `<span style="color:var(--good)">✓ Auto-filled from <strong>${esc(it.source)}</strong> catalog${res.confidence === 'fuzzy' ? ' (fuzzy — verify)' : ''}.</span>`;
}


async function loadProductCategoryOptions(selectId) {
  const res = await window.api.categoryNames();
  const names = (res.success && res.names) || [];
  const sel = document.getElementById(selectId);
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Select category —</option>' + names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  sel.value = prev;
}


function makeSortable(tableEl, dataFn) {
  const headers = tableEl.querySelectorAll('th[data-sort]');
  let currentSort = { key: null, dir: 1 };

  headers.forEach(th => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (currentSort.key === key) {
        currentSort.dir *= -1;
      } else {
        currentSort.key = key;
        currentSort.dir = 1;
      }
      headers.forEach(h => h.classList.remove('sorted'));
      th.classList.add('sorted');
      const icon = th.querySelector('.sort-icon');
      if (icon) icon.textContent = currentSort.dir === 1 ? '▲' : '▼';
      dataFn(key, currentSort.dir);
    });
  });
}


const ICONS = {
  receipt: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  package: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="16.5" y1="9.4" x2="7.5" y2="4.21"/><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>`,
  user: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
  logout: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`,
  register: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  arrow: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
  back: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`,
  print: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>`,
  plus: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`,
  search: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>`,
  cart: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/></svg>`,
  warning: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  edit: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
  invoice: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
  sms: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`,
};


setInterval(updateStatusBar, 1000);
document.addEventListener('DOMContentLoaded', updateStatusBar);


(function sessionIdleGuard() {
  if (!window.api || !window.api.sessionState || !window.api.sessionReauth) return;

  let overlay = null;
  let pin = '';
  let locked = false;
  let lastTouch = 0;
  let selectedUserId = null;

  function buildOverlay() {
    const el = document.createElement('div');
    el.id = 'idleLockOverlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;background:rgba(10,12,16,0.92);backdrop-filter:blur(3px)';
    el.innerHTML = `
      <style>
        @keyframes idleShake { 10%,90%{transform:translateX(-1px)} 20%,80%{transform:translateX(2px)} 30%,50%,70%{transform:translateX(-5px)} 40%,60%{transform:translateX(5px)} }
        #idleCard.idle-error { animation: idleShake 0.4s ease; }
        /* !important needed: #idleDots carries an inline color style, which a
           plain class selector can never override on its own. */
        #idleDots.idle-error { color: #dc2626 !important; }
      </style>
      <div id="idleCard" style="width:340px;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,0.4);padding:28px;text-align:center">
        <div style="font-size:18px;font-weight:800;color:#1a1a1a;margin-bottom:4px">Session locked</div>
        <div style="font-size:13px;color:#666;margin-bottom:16px">Inactive for a while. Any authorized staff member can unlock it.</div>
        <div id="idleWho">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#999;margin-bottom:8px;text-align:left">Who's this?</div>
          <div id="idleUserList" style="display:flex;flex-direction:column;gap:6px;max-height:280px;overflow-y:auto"></div>
        </div>
        <div id="idlePinPane" style="display:none">
          <div style="font-size:13px;color:#666;margin-bottom:10px">Enter PIN — <span id="idleEmp" style="font-weight:600"></span> <a href="#" id="idleBack" style="font-size:12px;color:#888;margin-left:6px">(not you?)</a></div>
          <div id="idleDots" style="font-size:26px;letter-spacing:6px;height:34px;color:#333;margin-bottom:10px">– – – –</div>
          <div id="idleKeypad" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:260px;margin:0 auto"></div>
        </div>
        <div id="idleErr" style="display:none;background:#fee2e2;color:#991b1b;border-radius:8px;padding:8px 12px;font-size:13px;margin-top:12px"></div>
      </div>`;
    document.body.appendChild(el);
    const card = el.querySelector('#idleCard');
    const dots = el.querySelector('#idleDots');
    const err = el.querySelector('#idleErr');
    const keypad = el.querySelector('#idleKeypad');
    const whoPane = el.querySelector('#idleWho');
    const pinPane = el.querySelector('#idlePinPane');
    const userList = el.querySelector('#idleUserList');
    const render = () => { dots.textContent = pin ? pin.split('').map(() => '●').join('  ') : '– – – –'; };

    async function loadUsers() {
      userList.innerHTML = '<div style="font-size:13px;color:#999">Loading…</div>';
      let r;
      try { r = await window.api.sessionListUnlockUsers(); } catch { r = null; }
      if (!r || !r.success || !r.users.length) { userList.innerHTML = '<div style="font-size:13px;color:#999">No staff found</div>'; return; }
      userList.innerHTML = r.users.map((u) => `
        <button class="idle-user-btn" data-id="${u.id}" data-name="${(u.name || '').replace(/"/g, '&quot;')}"
          style="border:1px solid #e2e2e2;border-radius:10px;background:#fafafa;padding:10px 14px;font-size:14px;font-weight:600;text-align:left;cursor:pointer;display:flex;justify-content:space-between;align-items:center">
          <span>${u.name}</span><span style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase">${u.role}</span>
        </button>`).join('');
      [...userList.querySelectorAll('.idle-user-btn')].forEach((b) => b.addEventListener('click', () => selectUser(Number(b.dataset.id), b.dataset.name)));
    }
    function selectUser(id, name) {
      selectedUserId = id;
      err.style.display = 'none'; pin = ''; render();
      el.querySelector('#idleEmp').textContent = name || '';
      whoPane.style.display = 'none';
      pinPane.style.display = 'block';
    }
    el.querySelector('#idleBack').addEventListener('click', (e) => {
      e.preventDefault();
      selectedUserId = null; pin = ''; render(); err.style.display = 'none';
      pinPane.style.display = 'none';
      whoPane.style.display = 'block';
    });

    
    
    
    function flashError(msg) {
      err.textContent = msg || 'Incorrect PIN'; err.style.display = 'block';
      pin = ''; render();
      card.classList.remove('idle-error'); dots.classList.remove('idle-error');
      void card.offsetWidth;
      card.classList.add('idle-error'); dots.classList.add('idle-error');
      setTimeout(() => { card.classList.remove('idle-error'); dots.classList.remove('idle-error'); }, 400);
    }

    async function submit() {
      if (pin.length !== 4 || !selectedUserId) return;
      const res = await window.api.sessionReauth(selectedUserId, pin);
      if (res && res.success) { pin = ''; render(); err.style.display = 'none'; hide(); lastTouch = Date.now(); return; }
      flashError(res && res.error);
    }
    function key(k) {
      err.style.display = 'none';
      if (k === '⌫') { pin = pin.slice(0, -1); render(); return; }
      if (k === '✓') return submit();
      if (pin.length < 4) pin += k;
      render();
      if (pin.length === 4) submit(); 
    }
    keypad.innerHTML = ['1','2','3','4','5','6','7','8','9','⌫','0','✓']
      .map((k) => `<button class="idlekey" style="border:1px solid #e2e2e2;border-radius:12px;background:#fafafa;font-size:20px;font-weight:700;padding:14px 0;cursor:pointer">${k}</button>`).join('');
    [...keypad.children].forEach((b) => b.addEventListener('click', () => key(b.textContent)));
    el.addEventListener('keydown', (e) => {
      if (pinPane.style.display === 'none') return; 
      if (/^[0-9]$/.test(e.key)) key(e.key);
      else if (e.key === 'Backspace') key('⌫');
      else if (e.key === 'Enter') key('✓');
    });
    el._loadUsers = loadUsers;
    el._resetToWho = () => { selectedUserId = null; pin = ''; render(); whoPane.style.display = 'block'; pinPane.style.display = 'none'; };
    return el;
  }

  function show() {
    if (!overlay) overlay = buildOverlay();
    overlay._resetToWho();
    overlay._loadUsers();
    overlay.style.display = 'flex';
    overlay.setAttribute('tabindex', '-1');
    overlay.focus();
    locked = true;
  }
  function hide() {
    if (overlay) overlay.style.display = 'none';
    locked = false;
  }

  async function check() {
    let s;
    try { s = await window.api.sessionState(); } catch { return; }
    if (!s || !s.success || !s.employee) { hide(); return; } 
    if (s.idleLocked) { if (!locked) show(); }
    else hide();
  }

  
  
  function onActivity() {
    if (locked) return;
    const now = Date.now();
    if (now - lastTouch < 30000) return;
    lastTouch = now;
    window.api.sessionTouch().then((r) => { if (r && r.idleLocked) check(); }).catch(() => {});
  }
  ['click', 'keydown', 'mousemove', 'touchstart', 'wheel'].forEach((ev) =>
    document.addEventListener(ev, onActivity, { passive: true })
  );

  setInterval(check, 20000);
  document.addEventListener('DOMContentLoaded', check);
  check();
})();


function formatMoneyInput(el) {
  const digits = el.value.replace(/\D/g, '');
  if (!digits) { el.value = ''; return; }
  const padded = digits.padStart(3, '0');
  const whole = padded.slice(0, -2).replace(/^0+(?=\d)/, '');
  el.value = `${whole}.${padded.slice(-2)}`;
  const pos = el.value.length;
  try { el.setSelectionRange(pos, pos); } catch {  }
}

document.addEventListener('input', (e) => {
  if (e.target && e.target.matches && e.target.matches('[data-money]')) formatMoneyInput(e.target);
}, true);

function pinMoneyCursorToEnd(e) {
  if (!(e.target && e.target.matches && e.target.matches('[data-money]'))) return;
  const el = e.target;
  const pos = el.value.length;
  try { el.setSelectionRange(pos, pos); } catch {  }
}
document.addEventListener('focus', pinMoneyCursorToEnd, true);
document.addEventListener('mouseup', pinMoneyCursorToEnd, true);


(function () {
  let enabled = false;
  let target = null;
  let shift = false;
  let mode = 'letters'; 
  let numericOnly = false; 
  let el = null;
  let valueAtFocus = '';

  const ROWS_LETTERS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '.'],
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '⌫'],
  ];
  const ROWS_SYMBOLS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['@', '#', '$', '%', '&', '*', '-', '+', '(', ')'],
    ['!', '"', "'", ':', ';', '/', '?', ',', '.'],
    ['⇧', '_', '=', '[', ']', '{', '}', '\\', '⌫'],
  ];
  
  
  
  
  const ROWS_NUMERIC = [
    ['1', '2', '3'],
    ['4', '5', '6'],
    ['7', '8', '9'],
    ['.', '0', '⌫'],
  ];
  
  
  
  
  function isNumericField(node) {
    const im = (node.inputMode || node.getAttribute?.('inputmode') || '').toLowerCase();
    return im === 'decimal' || im === 'numeric' || (node.tagName === 'INPUT' && (node.type || '').toLowerCase() === 'number');
  }

  
  
  
  
  
  
  function isVisible(node) {
    const cs = getComputedStyle(node);
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const rect = node.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) return false;
    return true;
  }

  function eligible(node) {
    if (!node || !node.tagName) return false;
    if (node.disabled || node.readOnly) return false;
    if (node.closest && node.closest('[data-no-osk]')) return false;
    const tag = node.tagName.toLowerCase();
    if (tag !== 'textarea' && tag !== 'input') return false;
    if (tag === 'input') {
      const type = (node.type || 'text').toLowerCase();
      if (!['text', 'search', 'email', 'tel', 'number', 'password', 'url'].includes(type)) return false;
    }
    return isVisible(node);
  }

  function insert(ch) {
    if (!target) return;
    
    
    
    
    
    
    
    
    if (target.matches && target.matches('[data-money]')) {
      target.value = (target.value ?? '') + ch;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      if (shift) { shift = false; render(); }
      return;
    }
    const val = target.value ?? '';
    const start = target.selectionStart ?? val.length;
    const end = target.selectionEnd ?? val.length;
    target.value = val.slice(0, start) + ch + val.slice(end);
    const pos = start + ch.length;
    try { target.setSelectionRange(pos, pos); } catch {  }
    target.dispatchEvent(new Event('input', { bubbles: true }));
    if (shift) { shift = false; render(); }
  }

  function backspace() {
    if (!target) return;
    if (target.matches && target.matches('[data-money]')) {
      target.value = (target.value ?? '').slice(0, -1);
      target.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    const val = target.value ?? '';
    const start = target.selectionStart ?? val.length;
    const end = target.selectionEnd ?? val.length;
    if (start !== end) {
      target.value = val.slice(0, start) + val.slice(end);
      try { target.setSelectionRange(start, start); } catch {  }
    } else if (start > 0) {
      target.value = val.slice(0, start - 1) + val.slice(start);
      try { target.setSelectionRange(start - 1, start - 1); } catch {  }
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function key(label, cls, handler) {
    const b = document.createElement('div');
    b.className = 'osk-key' + (cls ? ' ' + cls : '');
    b.textContent = label;
    b.addEventListener('pointerdown', (e) => { e.preventDefault(); handler(); });
    return b;
  }

  function build() {
    el = document.createElement('div');
    el.className = 'osk';
    document.body.appendChild(el);
    render();
  }

  function render() {
    if (!el) return;
    el.innerHTML = '';
    if (numericOnly) {
      ROWS_NUMERIC.forEach((row) => {
        const rowEl = document.createElement('div');
        rowEl.className = 'osk-row';
        row.forEach((k) => {
          rowEl.appendChild(k === '⌫' ? key('⌫', 'osk-wide', backspace) : key(k, '', () => insert(k)));
        });
        el.appendChild(rowEl);
      });
      const doneRow = document.createElement('div');
      doneRow.className = 'osk-row';
      doneRow.appendChild(key('Done', 'osk-done', hide));
      el.appendChild(doneRow);
      return;
    }
    const rows = mode === 'symbols' ? ROWS_SYMBOLS : ROWS_LETTERS;
    rows.forEach((row, i) => {
      const rowEl = document.createElement('div');
      rowEl.className = 'osk-row';
      row.forEach((k) => {
        if (k === '⇧') {
          rowEl.appendChild(key('⇧', 'osk-wide' + (shift ? ' osk-active' : ''), () => { shift = !shift; render(); }));
        } else if (k === '⌫') {
          rowEl.appendChild(key('⌫', 'osk-wide', backspace));
        } else {
          const ch = shift ? k.toUpperCase() : k;
          rowEl.appendChild(key(ch, '', () => insert(ch)));
        }
      });
      el.appendChild(rowEl);
    });
    const bottom = document.createElement('div');
    bottom.className = 'osk-row';
    bottom.appendChild(key(mode === 'symbols' ? 'ABC' : '123', 'osk-wide', () => { mode = mode === 'symbols' ? 'letters' : 'symbols'; render(); }));
    bottom.appendChild(key('', 'osk-key osk-space', () => insert(' ')));
    bottom.appendChild(key('Done', 'osk-done', hide));
    el.appendChild(bottom);
  }

  
  
  
  
  
  
  
  
  
  
  
  function adjustForKeyboard() {
    if (!target || !el) return;
    const kbTopWhenOpen = window.innerHeight - el.offsetHeight;
    const rect = target.getBoundingClientRect();
    const margin = 16;
    const overlap = rect.bottom + margin - kbTopWhenOpen;
    document.body.style.marginTop = overlap > 0 ? `-${Math.round(overlap)}px` : '';
  }

  function show(node) {
    target = node;
    valueAtFocus = node.value ?? '';
    numericOnly = isNumericField(node);
    mode = 'letters';
    shift = false;
    if (!el) build(); else render();
    el.classList.add('open');
    adjustForKeyboard();
  }
  function hide() {
    const prev = target;
    target = null;
    if (el) el.classList.remove('open');
    document.body.style.marginTop = '';
    if (prev) {
      
      
      
      
      
      
      
      
      
      if (prev.value !== valueAtFocus) prev.dispatchEvent(new Event('change', { bubbles: true }));
      if (prev.blur) prev.blur();
    }
  }

  document.addEventListener('focusin', (e) => {
    if (!enabled) return;
    if (eligible(e.target)) show(e.target);
  });
  document.addEventListener('focusout', (e) => {
    if (!enabled) return;
    setTimeout(() => {
      const active = document.activeElement;
      if (!eligible(active) && !(el && el.contains(active))) hide();
    }, 80);
  });

  async function init() {
    try {
      const r = await window.api.getSettings();
      enabled = !!(r && r.success && r.settings && r.settings.onscreen_keyboard_enabled === '1');
    } catch { enabled = false; }
  }
  document.addEventListener('DOMContentLoaded', init);
  init();
})();
