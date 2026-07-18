// Rackd Owner Console — Electron main process.
//
// A PRIVATE cockpit for the platform owner (never shipped to clients). It holds
// the master ADMIN_SECRET (the "owner key") entered once at activation, gated
// behind a local username/password. Everything it does — provisioning businesses
// & locations, listing/resetting kiosks, viewing online orders, and PUBLISHING
// app updates (staging → production) — goes through the service-role `admin` Edge
// Function, authorized by that secret. No client build ever contains it.

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const cfg = require('./config');

// Demo build: watermarked "DEMO" + isolated local data (separate productName ->
// separate userData). A packaged demo installer injects rackdDemo:true. Cloud
// isolation is opt-in via SANDBOX_SUPABASE_URL.
let pkgMeta = {};
try { pkgMeta = require('./package.json'); } catch { /* ignore */ }
const DEMO = process.env.RACKD_DEMO === '1' || pkgMeta.rackdDemo === true;
const SUPABASE_URL = (DEMO && process.env.SANDBOX_SUPABASE_URL) || cfg.SUPABASE_URL;
const SUPABASE_ANON_KEY = (DEMO && process.env.SANDBOX_SUPABASE_ANON_KEY) || cfg.SUPABASE_ANON_KEY;

function attachDemoBadge(win) {
  if (!DEMO) return;
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(
      `(function(){if(document.getElementById('__demo'))return;var d=document.createElement('div');d.id='__demo';d.textContent='DEMO';d.style.cssText='position:fixed;top:8px;right:10px;z-index:2147483647;background:#b01d2e;color:#fff;font:700 11px system-ui;letter-spacing:2px;padding:4px 10px;border-radius:6px;box-shadow:0 2px 10px rgba(0,0,0,.45);pointer-events:none';document.body.appendChild(d);})();`
    ).catch(() => {});
  });
}

// ── local credential store (OS userData, never in the build) ─────────────────
const STORE_PATH = () => path.join(app.getPath('userData'), 'owner.json');
let store = { admin_secret: null, owner_user: null, owner_pass: null }; // owner_pass = "salt:hash"
let unlocked = false; // set true after a successful login/activation this session

function loadStore() {
  try { store = { ...store, ...JSON.parse(fs.readFileSync(STORE_PATH(), 'utf8')) }; } catch { /* first run */ }
}
function saveStore() {
  try { fs.writeFileSync(STORE_PATH(), JSON.stringify(store), { mode: 0o600 }); } catch (e) { console.error('save failed', e); }
}
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return `${salt}:${crypto.scryptSync(String(pw), salt, 32).toString('hex')}`;
}
function verifyPw(pw, stored) {
  const [salt, h] = String(stored || '').split(':');
  if (!salt || !h) return false;
  const test = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(test, 'hex')); } catch { return false; }
}
const isActivated = () => !!store.admin_secret && !!store.owner_pass;

// ── thin Supabase caller ─────────────────────────────────────────────────────
async function sb(pathname, { method = 'GET', headers = {}, body } = {}) {
  const res = await fetch(`${SUPABASE_URL.replace(/\/$/, '')}${pathname}`, {
    method,
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`, 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
  return data;
}

// All owner powers run through the service-role admin function, authorized by the
// stored secret. Requires the console to be unlocked this session.
async function callAdmin(action, payload = {}) {
  if (!unlocked) throw new Error('Locked — sign in first');
  if (!store.admin_secret) throw new Error('Not activated');
  return sb('/functions/v1/admin', { method: 'POST', body: { admin_secret: store.admin_secret, action, ...payload } });
}

// ── window ───────────────────────────────────────────────────────────────────
function createWindow() {
  const win = new BrowserWindow({
    width: 1240, height: 860, minWidth: 940, minHeight: 620, backgroundColor: '#0e1116',
    title: 'Rackd — Owner Console',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  attachDemoBadge(win);
  return win;
}
app.whenReady().then(() => { loadStore(); createWindow(); app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); }); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── auth ─────────────────────────────────────────────────────────────────────
ipcMain.handle('owner:status', () => ({ success: true, activated: isActivated(), unlocked }));

// First-run activation: verify the owner key (ADMIN_SECRET) actually works, then
// store it behind a username/password of the owner's choosing.
ipcMain.handle('owner:activate', async (_e, { secret, username, password } = {}) => {
  try {
    const s = String(secret || '').trim();
    if (!s) return { success: false, error: 'Enter your owner key.' };
    if (!username || !password || String(password).length < 6) return { success: false, error: 'Choose a username and a password (6+ characters).' };
    // Prove the secret is valid by calling a harmless admin action.
    try { await sb('/functions/v1/admin', { method: 'POST', body: { admin_secret: s, action: 'list' } }); }
    catch (e) { return { success: false, error: /unauthorized|401/i.test(String(e)) ? 'That owner key was rejected.' : `Could not verify: ${String(e.message || e)}` }; }
    store.admin_secret = s;
    store.owner_user = String(username).trim();
    store.owner_pass = hashPw(password);
    saveStore();
    unlocked = true;
    return { success: true };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});

ipcMain.handle('owner:login', (_e, { username, password } = {}) => {
  if (!isActivated()) return { success: false, error: 'Not activated yet.' };
  if (String(username || '').trim() !== store.owner_user || !verifyPw(password, store.owner_pass)) {
    return { success: false, error: 'Wrong username or password.' };
  }
  unlocked = true;
  return { success: true };
});
ipcMain.handle('owner:logout', () => { unlocked = false; return { success: true }; });

// ── provisioning ──────────────────────────────────────────────────────────────
ipcMain.handle('owner:businesses', async () => wrap(() => callAdmin('list')));
ipcMain.handle('owner:createBusiness', async (_e, payload) => wrap(() => callAdmin('createBusiness', payload || {})));
ipcMain.handle('owner:locations', async (_e, tenantId) => wrap(() => callAdmin('locations', { tenant_id: tenantId })));
ipcMain.handle('owner:addLocation', async (_e, tenantId, name) => wrap(() => callAdmin('addLocation', { tenant_id: tenantId, name })));
ipcMain.handle('owner:renameLocation', async (_e, locationId, name) => wrap(() => callAdmin('renameLocation', { location_id: locationId, name })));

// ── kiosks (remote reset, item 5) ──────────────────────────────────────────────
ipcMain.handle('owner:kiosks', async (_e, tenantId) => wrap(() => callAdmin('kiosks', { tenant_id: tenantId })));
ipcMain.handle('owner:resetKiosk', async (_e, tenantId, machineId) => wrap(() => callAdmin('resetKiosk', { tenant_id: tenantId, machine_id: machineId })));
ipcMain.handle('owner:cancelReset', async (_e, tenantId, machineId) => wrap(() => callAdmin('cancelReset', { tenant_id: tenantId, machine_id: machineId })));

// ── online orders overview ──────────────────────────────────────────────────
ipcMain.handle('owner:onlineOrders', async (_e, tenantId) => wrap(() => callAdmin('onlineOrders', { tenant_id: tenantId || null })));

// ── publish (staging -> production) ────────────────────────────────────────────
ipcMain.handle('owner:publishStatus', async () => wrap(() => callAdmin('publishStatus')));
ipcMain.handle('owner:publish', async (_e, appId) => wrap(() => callAdmin('publish', { app: appId })));

// helper: normalize {success,...}/error for the renderer
async function wrap(fn) {
  try { const data = await fn(); return { success: true, ...(data && typeof data === 'object' ? data : { data }) }; }
  catch (e) { return { success: false, error: String(e.message || e) }; }
}
