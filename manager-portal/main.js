


const { app, BrowserWindow, ipcMain, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const bcrypt = require('bcryptjs');
const cfg = require('./config');


let pkgMeta = {};
try { pkgMeta = require('./package.json'); } catch {  }
const DEMO = process.env.RACKD_DEMO === '1' || pkgMeta.rackdDemo === true;
const SUPABASE_URL = (DEMO && process.env.SANDBOX_SUPABASE_URL) || cfg.SUPABASE_URL;
const SUPABASE_ANON_KEY = (DEMO && process.env.SANDBOX_SUPABASE_ANON_KEY) || cfg.SUPABASE_ANON_KEY;


function updaterChannel() { return process.env.RACKD_CHANNEL === 'staging' ? 'staging' : 'production'; }
function startUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: `${cfg.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/app-updates/manager/${updaterChannel()}` });
  } catch {  }
  let bootApply = true;
  setTimeout(() => { bootApply = false; }, 3 * 60 * 1000);
  autoUpdater.on('update-downloaded', () => { if (bootApply) { try { autoUpdater.quitAndInstall(true, true); } catch {  } } });
  autoUpdater.on('error', () => {  });
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}


function attachDemoBadge(win) {
  if (!DEMO) return;
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(
      `(function(){if(document.getElementById('__demo'))return;var d=document.createElement('div');d.id='__demo';d.textContent='DEMO';d.style.cssText='position:fixed;top:10px;right:12px;z-index:2147483647;background:#b01d2e;color:#fff;font:700 11px system-ui;letter-spacing:2px;padding:4px 10px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.4);pointer-events:none';document.body.appendChild(d);})();`
    ).catch(() => {});
  });
}


let token = null;
let session = null; 

let currentLocationId = null;


const STORE_PATH = () => path.join(app.getPath('userData'), 'portal.json');
let portalStore = { businessKey: null };
try { portalStore = { ...portalStore, ...JSON.parse(fs.readFileSync(STORE_PATH(), 'utf8')) }; } catch {  }
function savePortalStore() { try { fs.writeFileSync(STORE_PATH(), JSON.stringify(portalStore), { mode: 0o600 }); } catch (e) { console.error(e); } }

function decode(jwt) {
  try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString()); } catch { return {}; }
}


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


ipcMain.handle('portal:status', () => ({ success: true, hasBusiness: !!portalStore.businessKey, session, currentLocationId }));


ipcMain.handle('portal:setCurrentLocation', (_e, locationId) => {
  currentLocationId = locationId || null;
  return { success: true };
});


ipcMain.handle('portal:setBusiness', async (_e, key) => {
  const businessKey = String(key || '').trim();
  if (!businessKey) return { success: false, error: 'Enter your business key.' };
  try {
    
    const r = await sb('/functions/v1/jwt-issuer', { method: 'POST', body: { license_key: businessKey, list_locations: true } });
    if (!r) return { success: false, error: 'Business key was rejected.' };
    portalStore.businessKey = businessKey; savePortalStore();
    return { success: true };
  } catch (e) { return { success: false, error: /401|invalid/i.test(String(e)) ? 'Business key invalid or inactive.' : String(e.message || e) }; }
});


ipcMain.handle('portal:login', async (_e, { username, password } = {}) => {
  if (!portalStore.businessKey) return { success: false, error: 'Enter your business key first.' };
  try {
    const data = await sb('/functions/v1/staff-login', {
      method: 'POST', body: { license_key: portalStore.businessKey, username: String(username || '').trim(), password: password || '' },
    });
    if (!data || !data.token) return { success: false, error: 'Sign-in failed.' };
    token = data.token;
    const claims = decode(token);
    
    
    
    session = { tenant_id: claims.tenant_id, kind: claims.kind, exp: claims.exp, username: String(username || '').trim(), features: claims.features || [] };
    return { success: true, session: { tenant_id: claims.tenant_id }, must_change_password: !!data.must_change_password, name: data.name };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


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

ipcMain.handle('portal:clearBusiness', () => {
  token = null; session = null; currentLocationId = null;
  portalStore.businessKey = null; savePortalStore();
  return { success: true };
});
ipcMain.handle('portal:session', () => ({ success: true, session, currentLocationId }));


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

ipcMain.handle('portal:locationSales', async (_e, { location_id, start, end } = {}) => {
  try {
    requireAuth();
    if (!location_id) throw new Error('missing location_id');
    const endExclusive = end ? `${end}T23:59:59.999` : '';
    const qs = [
      `location_id=eq.${encodeURIComponent(location_id)}`,
      `payment_status=eq.completed`,
      start ? `created_at=gte.${encodeURIComponent(start)}` : null,
      end ? `created_at=lte.${encodeURIComponent(endExclusive)}` : null,
      'select=id,register_id,cashier_id,created_at,subtotal,discount_amount,tax_amount,total,payment_method,card_type',
      'order=created_at.desc',
      'limit=200',
    ].filter(Boolean).join('&');
    const rows = await sb(`/rest/v1/transactions_cloud?${qs}`);
    return { success: true, sales: rows || [] };
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


ipcMain.handle('portal:inventory', async () => {
  try {
    requireAuth();
    const rows = await sb('/rest/v1/inventory_cloud?select=id,location_id,barcode,name,category,price,quantity,reorder_point,updated_at&order=name');
    return { success: true, items: rows || [] };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


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
    
    
    const rows = await sb(`/rest/v1/inventory_cloud?location_id=eq.${encodeURIComponent(location_id)}&barcode=eq.${encodeURIComponent(barcode)}&select=id,quantity`);
    const row = rows && rows[0];
    let newQty = null;
    if (row) {
      newQty = Math.max(0, Number(row.quantity || 0) + d);
      
      
      
      
      await sb(
        `/rest/v1/inventory_cloud?location_id=eq.${encodeURIComponent(location_id)}&barcode=eq.${encodeURIComponent(barcode)}`,
        { method: 'PATCH', body: { quantity: newQty } }
      );
    }
    return { success: true, quantity: newQty };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


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
    
    
    const patch = { ...fields, register_id: 'manager' };
    const rows = await sb(`/rest/v1/customers_cloud?uid=eq.${encodeURIComponent(uid)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch,
    });
    return { success: true, customer: (rows && rows[0]) || null };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


function genPin() { return Array.from({ length: 4 }, () => Math.floor(Math.random() * 10)).join(''); }
function genPassword() {
  const a = 'abcdefghjkmnpqrstuvwxyz', d = '23456789';
  const pick = (s, n) => Array.from({ length: n }, () => s[Math.floor(Math.random() * s.length)]).join('');
  return `${pick(a, 6)}-${pick(d, 4)}`;
}


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
      must_change_pin: !String(pin || '').trim(), 
    };
    const rows = await sb('/rest/v1/employees_cloud', {
      method: 'POST', headers: { Prefer: 'return=representation' }, body: row,
    });
    return { success: true, staff: (rows && rows[0]) || null, pin: p };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


ipcMain.handle('portal:updateCashier', async (_e, { uid, name, is_active, pin, password } = {}) => {
  try {
    requireAuth();
    if (!uid) throw new Error('missing staff id');
    const patch = { register_id: 'manager' };
    if (name !== undefined) patch.name = String(name).trim();
    if (is_active !== undefined) patch.is_active = !!is_active;
    let newPin = null;
    if (pin !== undefined && pin !== null) {
      
      
      
      
      
      
      const typed = String(pin).trim();
      const p = typed || genPin();
      if (!/^\d{4}$/.test(p)) throw new Error('PIN must be exactly 4 digits');
      patch.pin_hash = bcrypt.hashSync(p, 10);
      patch.must_change_pin = !typed;
      newPin = p;
    }
    let newPassword = null;
    if (password !== undefined && password !== null) {
      const [existing] = await sb(`/rest/v1/employees_cloud?uid=eq.${encodeURIComponent(uid)}&select=role`);
      if (existing?.role === 'cashier') throw new Error('Cashiers sign in with a PIN only — reset their PIN instead.');
      const typed = String(password).trim();
      const pw = typed || genPassword();
      if (pw.length < 4) throw new Error('Password must be at least 4 characters');
      patch.password_hash = bcrypt.hashSync(pw, 10);
      patch.must_change_password = !typed;
      newPassword = pw;
    }
    const rows = await sb(`/rest/v1/employees_cloud?uid=eq.${encodeURIComponent(uid)}`, {
      method: 'PATCH', headers: { Prefer: 'return=representation' }, body: patch,
    });
    return { success: true, staff: (rows && rows[0]) || null, pin: newPin, password: newPassword };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


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


ipcMain.handle('portal:reactivateStaff', async (_e, { uid } = {}) => {
  try {
    requireAuth();
    if (!uid) throw new Error('missing staff id');
    await sb(`/rest/v1/employees_cloud?uid=eq.${encodeURIComponent(uid)}`, {
      method: 'PATCH', body: { is_active: true, register_id: 'manager' },
    });
    return { success: true };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


ipcMain.handle('portal:permanentlyDeleteStaff', async (_e, { uid } = {}) => {
  try {
    requireAuth();
    if (!uid) throw new Error('missing staff id');
    const rows = await sb(`/rest/v1/employees_cloud?uid=eq.${encodeURIComponent(uid)}&select=uid,is_active`);
    const row = rows && rows[0];
    if (!row) throw new Error('Staff member not found');
    if (row.is_active) throw new Error('Deactivate this staff member before permanently deleting them.');
    await sb(`/rest/v1/employees_cloud?uid=eq.${encodeURIComponent(uid)}`, { method: 'DELETE' });
    return { success: true };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


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


ipcMain.handle('portal:storefrontLocations', async () => {
  try {
    requireAuth();
    
    
    
    let rows;
    try {
      rows = await sb('/rest/v1/locations?select=id,name,is_storefront_enabled,tax_rate,stripe_account_id,stripe_onboarding_complete,address,zip,logo_url,show_logo,batch_time,timezone&order=name');
    } catch (e) {
      if (!/column|does not exist|42703/i.test(String(e.message || e))) throw e;
      rows = await sb('/rest/v1/locations?select=id,name,is_storefront_enabled,tax_rate,stripe_account_id,stripe_onboarding_complete,address,zip,logo_url,show_logo,batch_time&order=name');
    }
    return { success: true, locations: rows || [] };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


ipcMain.handle('portal:setBatchTime', async (_e, { location_id, batch_time } = {}) => {
  try {
    requireAuth();
    if (!location_id) throw new Error('pick a location');
    const rows = await sb('/rest/v1/rpc/set_location_batch_time', {
      method: 'POST',
      body: { p_location: location_id, p_batch_time: batch_time || null },
    });
    return { success: true, location: Array.isArray(rows) ? rows[0] : rows };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


ipcMain.handle('portal:getLayoutConfig', async () => {
  try {
    requireAuth();
    const rows = await sb(
      `/rest/v1/pos_layout_config_cloud?tenant_id=eq.${encodeURIComponent(session.tenant_id)}&select=role,report_slots,tile_order,updated_at`
    );
    return { success: true, configs: rows || [] };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});
ipcMain.handle('portal:setLayoutConfig', async (_e, { role, report_slots, tile_order } = {}) => {
  try {
    requireAuth();
    if (!['cashier', 'manager', 'admin'].includes(role)) throw new Error('invalid role');
    const row = {
      tenant_id: session.tenant_id, role,
      report_slots: report_slots ?? null,
      tile_order: tile_order ?? null,
      updated_at: new Date().toISOString(),
    };
    const rows = await sb('/rest/v1/pos_layout_config_cloud?on_conflict=tenant_id,role', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
      body: row,
    });
    return { success: true, config: Array.isArray(rows) ? rows[0] : rows };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


ipcMain.handle('portal:setTimezone', async (_e, { location_id, timezone } = {}) => {
  try {
    requireAuth();
    if (!location_id) throw new Error('pick a location');
    if (!timezone) throw new Error('pick a timezone');
    const rows = await sb('/rest/v1/rpc/set_location_timezone', {
      method: 'POST',
      body: { p_location: location_id, p_timezone: timezone },
    });
    return { success: true, location: Array.isArray(rows) ? rows[0] : rows };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});




ipcMain.handle('portal:setBranding', async (_e, { location_id, logo_url, show_logo, clear_logo } = {}) => {
  try {
    requireAuth();
    if (!location_id) throw new Error('pick a location');
    const rows = await sb('/rest/v1/rpc/set_storefront_branding', {
      method: 'POST',
      body: {
        p_location: location_id, p_address: null, p_logo_url: logo_url ?? null,
        p_show_logo: show_logo ?? null, p_zip: null, p_clear_logo: !!clear_logo,
      },
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
    
    await sb('/rest/v1/rpc/set_storefront_branding', {
      method: 'POST', body: { p_location: location_id, p_address: null, p_logo_url: logoUrl, p_show_logo: true },
    });
    return { success: true, logo_url: logoUrl };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


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
    
    const imageUrl = `${base}/storage/v1/object/public/product-images/${objectPath}?v=${Date.now()}`;
    await sb('/rest/v1/product_images?on_conflict=tenant_id,barcode', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: { tenant_id: session.tenant_id, barcode, image_url: imageUrl },
    });
    return { success: true, image_url: imageUrl };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

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
