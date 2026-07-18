/* ===== Shared renderer utilities ===== */

// Format currency
function fmt(n) {
  return '$' + Number(n || 0).toFixed(2);
}

const TZ = 'America/Chicago';

// Format date/time — always interprets stored timestamps as Central Time
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

function nowCTString() {
  return new Date().toLocaleString('en-US', {
    weekday: 'short', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: TZ
  });
}

function fmtDateFull(d) {
  return d.toLocaleDateString('en-US', {
    weekday: 'short', month: 'long', day: 'numeric', year: 'numeric', timeZone: TZ
  });
}

// Update status bar
async function updateStatusBar() {
  const res = await window.api.getSession();
  const session = res.session;
  const leftEl = document.getElementById('status-left');
  const rightEl = document.getElementById('status-right');

  if (leftEl) {
    leftEl.innerHTML = session
      ? `Logged in: <span class="status-role">${capitalize(session.role)}</span> &nbsp;|&nbsp; <strong>${fmtDateFull(new Date())}</strong>`
      : 'Not logged in';
  }

  if (rightEl) {
    rightEl.textContent = nowCTString();
  }
}

function capitalize(str) {
  return str ? str.charAt(0).toUpperCase() + str.slice(1) : '';
}

// Toast notifications
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

// Navigate
async function navigate(page) {
  await window.api.navigate(page);
}

// Modal helpers
function openModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'flex';
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

// Escape HTML
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Sort table
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

// SVG icons (inline)
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

// Start status bar clock
setInterval(updateStatusBar, 1000);
document.addEventListener('DOMContentLoaded', updateStatusBar);

/* ===== Session idle guard (item 2) =====
 * After 15 minutes of inactivity the acting employee must re-enter their PIN
 * before doing anything else. Enforced server-side on gated actions; this overlay
 * makes it a hard, visible lock on every authenticated screen. No-ops on the
 * login/activation screens (no employee session). */
(function sessionIdleGuard() {
  if (!window.api || !window.api.sessionState || !window.api.sessionReauth) return;

  let overlay = null;
  let pin = '';
  let locked = false;
  let lastTouch = 0;

  function buildOverlay() {
    const el = document.createElement('div');
    el.id = 'idleLockOverlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;background:rgba(10,12,16,0.92);backdrop-filter:blur(3px)';
    el.innerHTML = `
      <div style="width:340px;background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,0.4);padding:28px;text-align:center">
        <div style="font-size:18px;font-weight:800;color:#1a1a1a;margin-bottom:4px">Session locked</div>
        <div style="font-size:13px;color:#666;margin-bottom:18px">Inactive for a while. Enter your PIN to continue — <span id="idleEmp" style="font-weight:600"></span></div>
        <div id="idleDots" style="font-size:26px;letter-spacing:6px;height:34px;color:#333;margin-bottom:10px">– – – –</div>
        <div id="idleKeypad" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;max-width:260px;margin:0 auto"></div>
        <div id="idleErr" style="display:none;background:#fee2e2;color:#991b1b;border-radius:8px;padding:8px 12px;font-size:13px;margin-top:12px"></div>
      </div>`;
    document.body.appendChild(el);
    const dots = el.querySelector('#idleDots');
    const err = el.querySelector('#idleErr');
    const keypad = el.querySelector('#idleKeypad');
    const render = () => { dots.textContent = pin ? pin.split('').map(() => '●').join('  ') : '– – – –'; };
    async function submit() {
      if (pin.length < 4) return;
      const res = await window.api.sessionReauth(pin);
      if (res && res.success) { pin = ''; render(); err.style.display = 'none'; hide(); lastTouch = Date.now(); return; }
      err.textContent = (res && res.error) || 'Incorrect PIN'; err.style.display = 'block';
      pin = ''; render();
    }
    function key(k) {
      err.style.display = 'none';
      if (k === '⌫') pin = pin.slice(0, -1);
      else if (k === '✓') return submit();
      else if (pin.length < 8) pin += k;
      render();
    }
    keypad.innerHTML = ['1','2','3','4','5','6','7','8','9','⌫','0','✓']
      .map((k) => `<button class="idlekey" style="border:1px solid #e2e2e2;border-radius:12px;background:#fafafa;font-size:20px;font-weight:700;padding:14px 0;cursor:pointer">${k}</button>`).join('');
    [...keypad.children].forEach((b) => b.addEventListener('click', () => key(b.textContent)));
    el.addEventListener('keydown', (e) => {
      if (/^[0-9]$/.test(e.key)) key(e.key);
      else if (e.key === 'Backspace') key('⌫');
      else if (e.key === 'Enter') key('✓');
    });
    return el;
  }

  function show(empName) {
    if (!overlay) overlay = buildOverlay();
    overlay.querySelector('#idleEmp').textContent = empName || '';
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
    if (!s || !s.success || !s.employee) { hide(); return; } // login screen / logged out
    if (s.idleLocked) { if (!locked) show(s.employee.username); }
    else hide();
  }

  // Activity heartbeat: extend a live session (throttled). Ignored server-side once
  // idle-locked, so it can't defeat the lock.
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
