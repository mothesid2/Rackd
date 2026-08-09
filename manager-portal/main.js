// rackd Manager Portal — Electron main process.
//
// A read + light-management console for a whole BUSINESS (tenant), separate from
// the POS. It signs in with a manager code (kind='manager' license), which the
// jwt-issuer turns into a tenant-wide JWT (no location claim). All data goes
// through Supabase with that token; RLS scopes it to the manager's business and
// lets it see/edit every location. This is NOT a POS — no selling.

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const cfg = require('./config');

// Demo/sandbox build: isolated data (a separate Supabase project via env) so a demo
// session can never touch real business records. Clearly watermarked "DEMO". A
// packaged demo installer injects rackdDemo:true into package.json (build-desktop.js).
let pkgMeta = {};
try { pkgMeta = require('./package.json'); } catch { /* ignore */ }
const DEMO = process.env.RACKD_DEMO === '1' || pkgMeta.rackdDemo === true;
const SUPABASE_URL = (DEMO && process.env.SANDBOX_SUPABASE_URL) || cfg.SUPABASE_URL;
const SUPABASE_ANON_KEY = (DEMO && process.env.SANDBOX_SUPABASE_ANON_KEY) || cfg.SUPABASE_ANON_KEY;

// Auto-update from the per-app channel (app-updates/manager/<channel>). The staging
// build (my preview) sets RACKD_CHANNEL=staging; production is the default.
function updaterChannel() { return process.env.RACKD_CHANNEL === 'staging' ? 'staging' : 'production'; }
function startUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: `${cfg.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/app-updates/manager/${updaterChannel()}` });
  } catch { /* ignore */ }
  let bootApply = true;
  setTimeout(() => { bootApply = false; }, 3 * 60 * 1000);
  autoUpdater.on('update-downloaded', () => { if (bootApply) { try { autoUpdater.quitAndInstall(true, true); } catch { /* ignore */ } } });
  autoUpdater.on('error', () => { /* non-fatal */ });
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

// Inject a "DEMO" badge on every page of a demo build.
function attachDemoBadge(win) {
  if (!DEMO) return;
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(
      `(function(){if(document.getElementById('__demo'))return;var d=document.createElement('div');d.id='__demo';d.textContent='DEMO';d.style.cssText='position:fixed;top:10px;right:12px;z-index:2147483647;background:#b01d2e;color:#fff;font:700 11px system-ui;letter-spacing:2px;padding:4px 10px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.4);pointer-events:none';document.body.appendChild(d);})();`
    ).catch(() => {});
  });
}

// In-memory session (never persisted to disk — a portal re-login is cheap).
let token = null;
let session = null; // { tenant_id, kind, exp }
// Which store this session is focused on (item 10: chosen at login, like the
// POS's own location picker at activation — not a topbar dropdown). Cleared on
// logout/business change; "Change store" re-visits the picker without a full
// re-login since the session token is still valid.
let currentLocationId = null;

// The business key binds this portal to a business ONCE (like installing it for
// them). Managers then sign in with their username + password. Persisted so it's
// entered a single time.
const STORE_PATH = () => path.join(app.getPath('userData'), 'portal.json');
let portalStore = { businessKey: null };
try { portalStore = { ...portalStore, ...JSON.parse(fs.readFileSync(STORE_PATH(), 'utf8')) }; } catch { /* first run */ }
function savePortalStore() { try { fs.writeFileSync(STORE_PATH(), JSON.stringify(portalStore), { mode: 0o600 }); } catch (e) { console.error(e); } }

function decode(jwt) {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString()); } catch { return {}; }
}

// Thin Supabase REST/RPC caller with the current token (or anon before login).
async function sb(pathname, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}${pathname}`, {
    method,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${token || SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
  return data;
}

function requireAuth() {
  if (!token) throw new Error('Not signed in');
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1220,
    height: 840,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1f232a',
    title: 'Rackd — Management Portal',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  attachDemoBadge(win);
  return win;
}

app.whenReady().then(() => {
  createWindow();
  startUpdater();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── auth ─────────────────────────────────────────────────────────────────────
// First-run: is this portal bound to a business yet?
ipcMain.handle('portal:status', () => ({ success: true, hasBusiness: !!portalStore.businessKey, session, currentLocationId }));

// Item 10: the store picker lives on the login flow, not the topbar. Set once
// after choosing (or re-choosing via "Change store"); read back on portal.html boot.
ipcMain.handle('portal:setCurrentLocation', (_e, locationId) => {
  currentLocationId = locationId || null;
  return { success: true };
});

// Bind the portal to a business (validate the key, then remember it).
ipcMain.handle('portal:setBusiness', async (_e, key) => {
  const businessKey = String(key || '').trim();
  if (!businessKey) return { success: false, error: 'Enter your business key.' };
  try {
    // A harmless probe that the key is valid: list_locations on jwt-issuer.
    const r = await sb('/functions/v1/jwt-issuer', { method: 'POST', body: { license_key: businessKey, list_locations: true } });
    if (!r) return { success: false, error: 'Business key was rejected.' };
    portalStore.businessKey = businessKey; savePortalStore();
    return { success: true };
  } catch (e) { return { success: false, error: /401|invalid/i.test(String(e)) ? 'Business key invalid or inactive.' : String(e.message || e) }; }
});

// Manager/admin sign-in with the SAME username + password as the POS.
ipcMain.handle('portal:login', async (_e, { username, password } = {}) => {
  if (!portalStore.businessKey) return { success: false, error: 'Enter your business key first.' };
  try {
    const data = await sb('/functions/v1/staff-login', {
      method: 'POST', body: { license_key: portalStore.businessKey, username: String(username || '').trim(), password: password || '' },
    });
    if (!data || !data.token) return { success: false, error: 'Sign-in failed.' };
    token = data.token;
    const claims = decode(token);
    // Item 6: staff-login already bakes the business's feature list into the JWT
    // (supabase/functions/staff-login) — carry it through so the portal can gate
    // its own nav on it (e.g. Rebates, Storefront) without another round trip.
    session = { tenant_id: claims.tenant_id, kind: claims.kind, exp: claims.exp, username: String(username || '').trim(), features: claims.features || [] };
    return { success: true, session: { tenant_id: claims.tenant_id }, must_change_password: !!data.must_change_password, name: data.name };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Forced/voluntary password change (unifies with the POS credential).
ipcMain.handle('portal:changePassword', async (_e, { username, oldPassword, newPassword } = {}) => {
  if (!portalStore.businessKey) return { success: false, error: 'No business set.' };
  try {
    await sb('/functions/v1/staff-change-password', {
      method: 'POST',
      body: { license_key: portalStore.businessKey, username: String(username || '').trim(), old_password: oldPassword || '', new_password: newPassword || '' },
    });
    return { success: true };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

ipcMain.handle('portal:logout', () => { token = null; session = null; currentLocationId = null; return { success: true }; });
// Disconnect from the current business so a new business key can be entered.
ipcMain.handle('portal:clearBusiness', () => {
  token = null; session = null; currentLocationId = null;
  portalStore.businessKey = null; savePortalStore();
  return { success: true };
});
ipcMain.handle('portal:session', () => ({ success: true, session, currentLocationId }));

// ── reporting ────────────────────────────────────────────────────────────────
ipcMain.handle('portal:dashboard', async (_e, { start, end } = {}) => {
  try {
    requireAuth();
    const rows = await sb('/rest/v1/rpc/tenant_location_report', {
      method: 'POST', body: { p_start: start, p_end: end },
    });
    return { success: true, locations: rows || [] };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});
ipcMain.handle('portal:locationReport', async (_e, { location_id, start, end } = {}) => {
  try {
    requireAuth();
    const report = await sb('/rest/v1/rpc/manager_location_report', {
      method: 'POST', body: { p_location: location_id, p_start: start, p_end: end },
    });
    return { success: true, report };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});
ipcMain.handle('portal:rebates', async (_e, { start, end } = {}) => {
  try {
    requireAuth();
    const rows = await sb('/rest/v1/rpc/tenant_rebate_summary', {
      method: 'POST', body: { p_start: start, p_end: end },
    });
    return { success: true, manufacturers: rows || [] };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

ipcMain.handle('portal:locations', async () => {
  try {
    requireAuth();
    const rows = await sb('/rest/v1/locations?select=id,name&order=name');
    return { success: true, locations: rows || [] };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// ── inventory (read + edit, item 5) ───────────────────────────────────────────
ipcMain.handle('portal:inventory', async () => {
  try {
    requireAuth();
    const rows = await sb('/rest/v1/inventory_cloud?select=id,location_id,barcode,name,category,price,quantity,reorder_point,updated_at&order=name');
    return { success: true, items: rows || [] };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Adjust stock for one item at one location. inventory_cloud is a reporting
// MIRROR (the POS's local SQLite is the source of truth) with no pull path back
// down — writing here directly would just get overwritten by the next POS-side
// sale/snapshot. So this rides the same stock_movements_cloud delta log the POS
// already peer-pulls and applies (src/main/supabase/sync.ts, applyStockMovement,
// matched by barcode) — the exact mechanism registers use to share stock with
// each other. No new POS code needed; it converges on its next 60s sync.
ipcMain.handle('portal:adjustStock', async (_e, { location_id, barcode, delta, reason } = {}) => {
  try {
    requireAuth();
    if (!location_id || !barcode) throw new Error('location_id + barcode required');
    const d = Number(delta);
    if (!d) throw new Error('delta must be a non-zero number');
    await sb('/rest/v1/stock_movements_cloud', {
      method: 'POST',
      body: {
        movement_uid: randomUUID(), tenant_id: session.tenant_id, location_id,
        register_id: 'manager', barcode, delta: d, reason: (reason || 'manual'),
      },
    });
    // Reflect the change in inventory_cloud immediately too, so the portal's own
    // view doesn't wait on a round trip through the POS's next sync cycle.
    const rows = await sb(`/rest/v1/inventory_cloud?location_id=eq.${encodeURIComponent(location_id)}&barcode=eq.${encodeURIComponent(barcode)}&select=id,quantity`);
    const row = rows && rows[0];
    let newQty = null;
    if (row) {
      newQty = Math.max(0, Number(row.quantity || 0) + d);
      await sb(`/rest/v1/inventory_cloud?id=eq.${row.id}`, { method: 'PATCH', body: { quantity: newQty } });
    }
    return { success: true, quantity: newQty };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// ── customers (read + light-management edit that syncs down to registers) ─────
ipcMain.handle('portal:customers', async () => {
  try {
    requireAuth();
    const rows = await sb('/rest/v1/customers_cloud?select=uid,location_id,first_name,last_name,phone,email,loyalty_points,gold_member,updated_at&order=updated_at.desc&limit=500');
    return { success: true, customers: rows || [] };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});
ipcMain.handle('portal:createCustomer', async (_e, { location_id, fields } = {}) => {
  try {
    requireAuth();
    if (!location_id) throw new Error('Pick a location for the customer');
    if (!fields || !String(fields.first_name || '').trim()) throw new Error('First name is required');
    // Identity is a fresh uid; tenant comes from the manager session (not the
    // renderer). register_id='manager' so every register at that location pulls it.
    const row = {
      uid: randomUUID(),
      tenant_id: session.tenant_id,
      location_id,
      register_id: 'manager',
      ...fields,
    };
    const rows = await sb('/rest/v1/customers_cloud', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: row,
    });
    return { success: true, customer: (rows && rows[0]) || null };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

ipcMain.handle('portal:updateCustomer', async (_e, { uid, fields } = {}) => {
  try {
    requireAuth();
    if (!uid) throw new Error('missing customer id');
    // register_id='manager' so EVERY register pulls this edit down (a register
    // skips only rows tagged with its own id). updated_at is bumped by a trigger.
    const patch = { ...fields, register_id: 'manager' };
    const rows = await sb(`/rest/v1/customers_cloud?uid=eq.${encodeURIComponent(uid)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch,
    });
    return { success: true, customer: (rows && rows[0]) || null };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// ── staff: cashier add/edit (syncs down to every register) ────────────────────
// Managers manage CASHIERS from the portal. The account is written to
// employees_cloud (RLS: tenant-scoped, managers may write); each register pulls it
// and the cashier can then sign in by PIN. Managers/admins are provisioned on the
// POS by an admin.
function genPin() { return Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join(''); }

// Item 4 (reverses the earlier "Staff stays tenant-wide" decision, explicitly
// overridden by the user): scoped to the selected store, but a row with no
// location_id (the admin account, and any staff created before this change)
// stays visible under every store rather than silently disappearing.
// Also returns each employee's permission grants (batch 5, item 5) — same
// employee_permissions_cloud table Owner Console and the POS already read/
// write, so all three stay in sync automatically; this just adds the missing
// UI surface here.
ipcMain.handle('portal:staff', async () => {
  try {
    requireAuth();
    const filter = currentLocationId
      ? `&or=(location_id.eq.${encodeURIComponent(currentLocationId)},location_id.is.null)`
      : '';
    const [rows, perms] = await Promise.all([
      sb(`/rest/v1/employees_cloud?select=uid,name,username,role,is_active,must_change_pin,must_change_password,location_id,updated_at&order=role,name${filter}`),
      sb('/rest/v1/employee_permissions_cloud?select=employee_uid,permission_key,is_granted,value'),
    ]);
    const byEmp = {};
    for (const p of perms || []) {
      (byEmp[p.employee_uid] ||= {})[p.permission_key] = { is_granted: !!p.is_granted, value: p.value ?? null };
    }
    const staff = (rows || []).map((r) => ({ ...r, permissions: byEmp[r.uid] || {} }));
    return { success: true, staff };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Grant/revoke a single permission or menu-access key for one employee —
// check-then-branch (no natural upsert target on this table), same approach
// the admin Edge Function's setStaffPermission action uses.
ipcMain.handle('portal:setStaffPermission', async (_e, { employee_uid, permission_key, is_granted, value } = {}) => {
  try {
    requireAuth();
    if (!employee_uid || !permission_key) throw new Error('missing employee_uid/permission_key');
    const [emp] = await sb(`/rest/v1/employees_cloud?uid=eq.${encodeURIComponent(employee_uid)}&select=location_id,register_id`);
    if (!emp) throw new Error('employee not found');
    const [existing] = await sb(
      `/rest/v1/employee_permissions_cloud?tenant_id=eq.${encodeURIComponent(session.tenant_id)}&employee_uid=eq.${encodeURIComponent(employee_uid)}&permission_key=eq.${encodeURIComponent(permission_key)}&select=uid`
    );
    const nowIso = new Date().toISOString();
    if (existing?.uid) {
      await sb(`/rest/v1/employee_permissions_cloud?uid=eq.${encodeURIComponent(existing.uid)}`, {
        method: 'PATCH', body: { is_granted: !!is_granted, value: value ?? null, updated_at: nowIso },
      });
    } else {
      await sb('/rest/v1/employee_permissions_cloud', {
        method: 'POST', body: {
          uid: randomUUID(), tenant_id: session.tenant_id, location_id: emp.location_id, register_id: emp.register_id,
          employee_uid, permission_key, is_granted: !!is_granted, value: value ?? null, created_at: nowIso, updated_at: nowIso,
        },
      });
    }
    return { success: true };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Create a cashier (name + optional 4-digit PIN; blank auto-generates). Returns the
// PIN once to hand over. The cashier must change it on first sign-in.
ipcMain.handle('portal:createCashier', async (_e, { name, pin } = {}) => {
  try {
    requireAuth();
    const nm = String(name || '').trim();
    if (!nm) throw new Error('Enter the cashier’s name');
    const p = String(pin || '').trim() || genPin();
    if (!/^\d{4}$/.test(p)) throw new Error('PIN must be exactly 4 digits');
    const row = {
      uid: randomUUID(), tenant_id: session.tenant_id, register_id: 'manager', location_id: currentLocationId || null,
      name: nm, role: 'cashier', username: null,
      pin_hash: bcrypt.hashSync(p, 10), is_active: true,
      must_change_pin: !String(pin || '').trim(), // forced change only when auto-generated
    };
    const rows = await sb('/rest/v1/employees_cloud', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: row,
    });
    return { success: true, staff: (rows && rows[0]) || null, pin: p };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Edit a cashier or manager: rename / activate-deactivate, and optionally reset
// the PIN (cashier) or password (manager). Cashiers are PIN-only, full stop —
// guarded server-side (not just by the UI only offering a PIN reset for
// cashier rows) so this can never hand one a password_hash/must_change_password,
// which is exactly the shape of the bug that forced a credential-change prompt
// on every single cashier login instead of just the first (see auth.ts).
ipcMain.handle('portal:updateCashier', async (_e, { uid, name, is_active, pin, password } = {}) => {
  try {
    requireAuth();
    if (!uid) throw new Error('missing staff id');
    const patch = { register_id: 'manager' };
    if (name !== undefined) patch.name = String(name).trim();
    if (is_active !== undefined) patch.is_active = !!is_active;
    let newPin = null;
    if (pin !== undefined && pin !== null && String(pin).trim() !== '') {
      const p = String(pin).trim();
      if (!/^\d{4}$/.test(p)) throw new Error('PIN must be exactly 4 digits');
      patch.pin_hash = bcrypt.hashSync(p, 10);
      patch.must_change_pin = false;
      newPin = p;
    }
    let newPassword = null;
    if (password !== undefined && password !== null && String(password).trim() !== '') {
      const [existing] = await sb(`/rest/v1/employees_cloud?uid=eq.${encodeURIComponent(uid)}&select=role`);
      if (existing?.role === 'cashier') throw new Error('Cashiers sign in with a PIN only — reset their PIN instead.');
      const pw = String(password).trim();
      if (pw.length < 4) throw new Error('Password must be at least 4 characters');
      patch.password_hash = bcrypt.hashSync(pw, 10);
      patch.must_change_password = false;
      newPassword = pw;
    }
    const rows = await sb(`/rest/v1/employees_cloud?uid=eq.${encodeURIComponent(uid)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch,
    });
    return { success: true, staff: (rows && rows[0]) || null, pin: newPin, password: newPassword };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Create a manager (item 2): username + password, same login the POS and this
// portal both use. Always forces a password change on first sign-in.
ipcMain.handle('portal:createManager', async (_e, { name, username, password } = {}) => {
  try {
    requireAuth();
    const nm = String(name || '').trim();
    const un = String(username || '').trim();
    if (!nm) throw new Error('Enter the manager’s name');
    if (!un) throw new Error('Enter a username');
    const pw = String(password || '').trim();
    if (pw.length < 4) throw new Error('Password must be at least 4 characters');
    const row = {
      uid: randomUUID(), tenant_id: session.tenant_id, register_id: 'manager', location_id: currentLocationId || null,
      name: nm, role: 'manager', username: un,
      password_hash: bcrypt.hashSync(pw, 10), is_active: true, must_change_password: true,
    };
    const rows = await sb('/rest/v1/employees_cloud', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: row,
    });
    return { success: true, staff: (rows && rows[0]) || null };
  } catch (e) {
    const msg = String(e.message || e);
    return { success: false, error: /duplicate|unique/i.test(msg) ? 'That username is already taken.' : msg };
  }
});

// Delete = deactivate (item 2). employees_cloud has no pull-based delete
// propagation to the POS (the peer-pull cursor only sees updated_at changes),
// so a hard delete here would just orphan the local copy on every kiosk forever
// instead of actually removing access — deactivating is the real "delete".
ipcMain.handle('portal:deleteStaff', async (_e, { uid } = {}) => {
  try {
    requireAuth();
    if (!uid) throw new Error('missing staff id');
    await sb(`/rest/v1/employees_cloud?uid=eq.${encodeURIComponent(uid)}`, {
      method: 'PATCH', body: { is_active: false, register_id: 'manager' },
    });
    return { success: true };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// ── timesheets (item 8) — aggregate time_clock_cloud punches per employee ─────
// A manager token's select policy sees every punch tenant-wide (time_clock_cloud
// RLS: is_manager() bypasses the location_id restriction), so this is a plain
// range query + client-side aggregation, no new RPC needed.
ipcMain.handle('portal:timesheet', async (_e, { start, end } = {}) => {
  try {
    requireAuth();
    const startIso = new Date(`${start}T00:00:00`).toISOString();
    const endIso = new Date(`${end}T23:59:59.999`).toISOString();
    const rows = await sb(
      `/rest/v1/time_clock_cloud?select=uid,location_id,employee_uid,employee_name,clock_in,clock_out` +
      `&deleted=eq.false` +
      `&clock_in=gte.${encodeURIComponent(startIso)}&clock_in=lte.${encodeURIComponent(endIso)}&order=clock_in.asc`
    );
    return { success: true, punches: rows || [] };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Log a brand-new shift the register never saw a punch for — an employee forgot
// to clock in/out, or a manager needs to backfill hours manually. clock_out may
// be omitted to log them as still clocked in. Same sync path as every other
// punch (peer-pull by uid), so this reaches the register + feeds tip-pool hours
// and X/Z reports exactly like a real punch would.
ipcMain.handle('portal:addTimeClock', async (_e, { employee_uid, employee_name, clock_in, clock_out } = {}) => {
  try {
    requireAuth();
    if (!employee_uid || !clock_in) throw new Error('Pick an employee and a clock-in time');
    const inMs = new Date(clock_in).getTime();
    if (Number.isNaN(inMs)) throw new Error('Invalid clock-in time');
    if (clock_out) {
      const outMs = new Date(clock_out).getTime();
      if (Number.isNaN(outMs)) throw new Error('Invalid clock-out time');
      if (outMs < inMs) throw new Error('Clock-out cannot be before clock-in');
    }
    await sb('/rest/v1/time_clock_cloud', {
      method: 'POST',
      body: {
        uid: randomUUID(), tenant_id: session.tenant_id, location_id: currentLocationId || null,
        register_id: 'manager', employee_uid, employee_name: employee_name || null,
        clock_in: new Date(clock_in).toISOString(), clock_out: clock_out ? new Date(clock_out).toISOString() : null,
      },
    });
    return { success: true };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Soft-delete: sets deleted=true rather than a real DELETE. The peer-pull sync
// (src/main/supabase/sync.ts pullCycle) is purely additive/upsert-by-uid with
// no way to notice a row vanishing upstream — a real DELETE here would leave a
// stale, still-counted copy on any kiosk that already pulled this punch. The
// tombstone rides the same UPDATE path as a normal correction, and
// applyTimeClock turns it into a real local delete once it reaches the kiosk.
ipcMain.handle('portal:deleteTimeClock', async (_e, { uid } = {}) => {
  try {
    requireAuth();
    if (!uid) throw new Error('missing uid');
    await sb(`/rest/v1/time_clock_cloud?uid=eq.${encodeURIComponent(uid)}`, {
      method: 'PATCH', body: { deleted: true },
    });
    return { success: true };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Correct a punch's clock-in/out (batch 5, item 8). clock_out may be null (still
// clocked in). Flows back down to every register at that location via the same
// peer-pull the POS's own punches use (src/main/supabase/sync.ts applyTimeClock,
// upserted by uid), so the correction lands on the kiosk that owns the punch too.
ipcMain.handle('portal:adjustTimeClock', async (_e, { uid, clock_in, clock_out } = {}) => {
  try {
    requireAuth();
    if (!uid || !clock_in) throw new Error('missing uid/clock_in');
    const inMs = new Date(clock_in).getTime();
    if (Number.isNaN(inMs)) throw new Error('Invalid clock-in time');
    if (clock_out) {
      const outMs = new Date(clock_out).getTime();
      if (Number.isNaN(outMs)) throw new Error('Invalid clock-out time');
      if (outMs < inMs) throw new Error('Clock-out cannot be before clock-in');
    }
    await sb(`/rest/v1/time_clock_cloud?uid=eq.${encodeURIComponent(uid)}`, {
      method: 'PATCH', body: { clock_in: new Date(clock_in).toISOString(), clock_out: clock_out ? new Date(clock_out).toISOString() : null },
    });
    return { success: true };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// ── storefront (online store) ─────────────────────────────────────────────────
// Which of the tenant's locations are online, and their tax rate. locations is
// service-role-write-only, so the toggle goes through set_storefront_settings().
ipcMain.handle('portal:storefrontLocations', async () => {
  try {
    requireAuth();
    const rows = await sb('/rest/v1/locations?select=id,name,is_storefront_enabled,tax_rate,stripe_account_id,stripe_onboarding_complete,address,zip,logo_url,show_logo&order=name');
    return { success: true, locations: rows || [] };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Stripe Connect (Express) onboarding for a location. 'onboard' returns a hosted
// link (opened in the browser); 'status' refreshes + persists onboarding state.
ipcMain.handle('portal:stripeConnect', async (_e, { action, location_id } = {}) => {
  try {
    requireAuth();
    if (!location_id) throw new Error('pick a location');
    const res = await sb('/functions/v1/stripe-connect', {
      method: 'POST', body: { action: action || 'status', location_id, return_url: 'https://rackd.io/connect' },
    });
    return { success: true, ...res };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});
ipcMain.handle('portal:openExternal', (_e, url) => { if (url) shell.openExternal(String(url)); return { success: true }; });

// Storefront listing branding (item 2): address shown on the listing + optional
// per-location logo (else a default shopping-bag icon).
// Address/zip are owner-only (item 10) — this never forwards them, even if a
// caller passes them; only logo fields are manager-settable.
ipcMain.handle('portal:setBranding', async (_e, { location_id, logo_url, show_logo } = {}) => {
  try {
    requireAuth();
    if (!location_id) throw new Error('pick a location');
    const rows = await sb('/rest/v1/rpc/set_storefront_branding', {
      method: 'POST',
      body: { p_location: location_id, p_address: null, p_logo_url: logo_url ?? null, p_show_logo: show_logo ?? null, p_zip: null },
    });
    return { success: true, location: Array.isArray(rows) ? rows[0] : rows };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});
ipcMain.handle('portal:uploadLocationLogo', async (_e, { location_id, base64, ext, contentType } = {}) => {
  try {
    requireAuth();
    if (!location_id || !base64) throw new Error('missing logo');
    const e = (String(ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase()) || 'png';
    const objectPath = `${session.tenant_id}/logo-${location_id}.${e}`;
    const base = SUPABASE_URL.replace(/\/$/, '');
    const up = await fetch(`${base}/storage/v1/object/product-images/${objectPath}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': contentType || 'image/png', 'x-upsert': 'true' },
      body: Buffer.from(base64, 'base64'),
    });
    if (!up.ok) throw new Error(`upload failed: ${(await up.text()) || up.status}`);
    const logoUrl = `${base}/storage/v1/object/public/product-images/${objectPath}?v=${Date.now()}`;
    // Persist the URL + turn the logo on.
    await sb('/rest/v1/rpc/set_storefront_branding', {
      method: 'POST', body: { p_location: location_id, p_address: null, p_logo_url: logoUrl, p_show_logo: true },
    });
    return { success: true, logo_url: logoUrl };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Product photo upload (item 11). Business-wide by barcode: uploads to the
// product-images bucket at <tenant>/<barcode>.<ext>, then upserts the public URL
// into product_images so every location + the storefront shows it.
ipcMain.handle('portal:uploadProductImage', async (_e, { barcode, base64, ext, contentType } = {}) => {
  try {
    requireAuth();
    if (!barcode || !base64) throw new Error('missing image');
    const safe = String(barcode).replace(/[^A-Za-z0-9._-]/g, '_');
    const e = (String(ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase()) || 'jpg';
    const objectPath = `${session.tenant_id}/${safe}.${e}`;
    const base = SUPABASE_URL.replace(/\/$/, '');
    const up = await fetch(`${base}/storage/v1/object/product-images/${objectPath}`, {
      method: 'POST',
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${token}`, 'Content-Type': contentType || 'image/jpeg', 'x-upsert': 'true' },
      body: Buffer.from(base64, 'base64'),
    });
    if (!up.ok) throw new Error(`upload failed: ${(await up.text()) || up.status}`);
    // Cache-bust so a replaced image refreshes on clients.
    const imageUrl = `${base}/storage/v1/object/public/product-images/${objectPath}?v=${Date.now()}`;
    await sb('/rest/v1/product_images?on_conflict=tenant_id,barcode', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { tenant_id: session.tenant_id, barcode, image_url: imageUrl },
    });
    return { success: true, image_url: imageUrl };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});
// Tax rate is owner/address-derived only (item 11) — never forwarded from here,
// even if a caller passes one; a manager may only toggle the store on/off.
ipcMain.handle('portal:setStorefront', async (_e, { location_id, enabled } = {}) => {
  try {
    requireAuth();
    if (!location_id) throw new Error('pick a location');
    const rows = await sb('/rest/v1/rpc/set_storefront_settings', {
      method: 'POST',
      body: { p_location: location_id, p_enabled: enabled, p_tax_rate: null },
    });
    return { success: true, location: Array.isArray(rows) ? rows[0] : rows };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Menu builder for one location: every product that HAS a barcode (online
// identity) joined with its opt-in row. Merged client-side from two tenant reads.
ipcMain.handle('portal:menu', async (_e, { location_id } = {}) => {
  try {
    requireAuth();
    if (!location_id) throw new Error('pick a location');
    const loc = encodeURIComponent(location_id);
    const [inv, opt, imgs] = await Promise.all([
      sb(`/rest/v1/inventory_cloud?location_id=eq.${loc}&barcode=not.is.null&select=barcode,name,category,price,quantity&order=name`),
      sb(`/rest/v1/storefront_products?location_id=eq.${loc}&select=barcode,is_visible,override_price`),
      sb(`/rest/v1/product_images?tenant_id=eq.${encodeURIComponent(session.tenant_id)}&select=barcode,image_url`),
    ]);
    const optBy = {};
    for (const o of opt || []) optBy[o.barcode] = o;
    const imgBy = {};
    for (const im of imgs || []) imgBy[im.barcode] = im.image_url;
    // Dedup inventory by barcode (variants can repeat one), keeping the first seen.
    const seen = {};
    const items = [];
    for (const i of inv || []) {
      if (!i.barcode || seen[i.barcode]) continue;
      seen[i.barcode] = true;
      const o = optBy[i.barcode];
      items.push({
        barcode: i.barcode, name: i.name, category: i.category,
        price: i.price, quantity: i.quantity,
        is_visible: o ? !!o.is_visible : false,
        override_price: o ? o.override_price : null,
        image_url: imgBy[i.barcode] || null,
      });
    }
    return { success: true, items };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});
// Opt a product in/out or set an override price. Upsert on (location_id, barcode).
ipcMain.handle('portal:setMenuItem', async (_e, { location_id, barcode, is_visible, override_price } = {}) => {
  try {
    requireAuth();
    if (!location_id || !barcode) throw new Error('missing location or product');
    const row = {
      tenant_id: session.tenant_id, location_id, barcode,
      is_visible: !!is_visible,
      override_price: (override_price === '' || override_price == null) ? null : Number(override_price),
    };
    const rows = await sb('/rest/v1/storefront_products?on_conflict=location_id,barcode', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: row,
    });
    return { success: true, item: (rows && rows[0]) || null };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

// Order queue for a location (or the whole tenant when location omitted).
ipcMain.handle('portal:orders', async (_e, { location_id } = {}) => {
  try {
    requireAuth();
    let q = '/rest/v1/online_orders?select=id,order_number,location_id,status,subtotal,tax,total,created_at,ready_at,online_order_items(name,qty)';
    q += "&status=in.(new,preparing,ready)&order=created_at.asc";
    if (location_id) q += `&location_id=eq.${encodeURIComponent(location_id)}`;
    const rows = await sb(q);
    return { success: true, orders: rows || [] };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});
// Advance an order (preparing|ready|cancelled). Routes through the edge function
// so the customer SMS (and refund/stock-restore on cancel) happen server-side.
ipcMain.handle('portal:orderStatus', async (_e, { order_id, status, cancel_reason } = {}) => {
  try {
    requireAuth();
    if (!order_id || !status) throw new Error('missing order or status');
    const res = await sb('/functions/v1/storefront-order-ready', {
      method: 'POST', body: { order_id, status, cancel_reason },
    });
    return { success: true, result: res };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});
