


const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');
const cfg = require('./config');


function updaterChannel() { return process.env.RACKD_CHANNEL === 'staging' ? 'staging' : 'production'; }
function startUpdater() {
  if (!app.isPackaged) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  try {
    autoUpdater.setFeedURL({ provider: 'generic', url: `${cfg.SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/app-updates/owner/${updaterChannel()}` });
  } catch {  }
  let bootApply = true;
  setTimeout(() => { bootApply = false; }, 3 * 60 * 1000);
  autoUpdater.on('update-downloaded', () => { if (bootApply) { try { autoUpdater.quitAndInstall(true, true); } catch {  } } });
  autoUpdater.on('error', () => {  });
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 3000);
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}


let pkgMeta = {};
try { pkgMeta = require('./package.json'); } catch {  }
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


const STORE_PATH = () => path.join(app.getPath('userData'), 'owner.json');
let store = { admin_secret: null };
let unlocked = false; 

function loadStore() {
  try { store = { ...store, ...JSON.parse(fs.readFileSync(STORE_PATH(), 'utf8')) }; } catch {  }
}
function saveStore() {
  try { fs.writeFileSync(STORE_PATH(), JSON.stringify(store), { mode: 0o600 }); } catch (e) { console.error('save failed', e); }
}

const isActivated = () => !!store.admin_secret;


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


async function callAdmin(action, payload = {}) {
  if (!unlocked) throw new Error('Locked — sign in first');
  if (!store.admin_secret) throw new Error('Not activated');
  return sb('/functions/v1/admin', { method: 'POST', body: { admin_secret: store.admin_secret, action, ...payload } });
}


function createWindow() {
  const win = new BrowserWindow({
    width: 1240, height: 860, minWidth: 940, minHeight: 620, backgroundColor: '#0e1116',
    title: 'Rackd — Owner Console',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  
  
  
  win.loadFile(path.join(__dirname, 'renderer', isActivated() ? 'console.html' : 'login.html'));
  attachDemoBadge(win);
  return win;
}
app.whenReady().then(() => {
  loadStore();
  if (isActivated()) unlocked = true;
  createWindow(); startUpdater();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });


ipcMain.handle('owner:status', () => ({ success: true, activated: isActivated(), unlocked }));


ipcMain.handle('owner:activate', async (_e, { secret } = {}) => {
  try {
    const s = String(secret || '').trim();
    if (!s) return { success: false, error: 'Enter your owner key.' };
    
    try { await sb('/functions/v1/admin', { method: 'POST', body: { admin_secret: s, action: 'list' } }); }
    catch (e) { return { success: false, error: /unauthorized|401/i.test(String(e)) ? 'That owner key was rejected.' : `Could not verify: ${String(e.message || e)}` }; }
    store.admin_secret = s;
    saveStore();
    unlocked = true;
    return { success: true };
  } catch (e) { return { success: false, error: String(e.message || e) }; }
});


ipcMain.handle('owner:businesses', async () => wrap(() => callAdmin('list')));
ipcMain.handle('owner:createBusiness', async (_e, payload) => wrap(() => callAdmin('createBusiness', payload || {})));
ipcMain.handle('owner:deleteBusiness', async (_e, tenantId) => wrap(() => callAdmin('deleteBusiness', { tenant_id: tenantId })));
ipcMain.handle('owner:locations', async (_e, tenantId) => wrap(() => callAdmin('locations', { tenant_id: tenantId })));
ipcMain.handle('owner:addLocation', async (_e, tenantId, name, address, zip) => wrap(() => callAdmin('addLocation', { tenant_id: tenantId, name, address, zip })));
ipcMain.handle('owner:renameLocation', async (_e, locationId, name) => wrap(() => callAdmin('renameLocation', { location_id: locationId, name })));


ipcMain.handle('owner:setLocationAddress', async (_e, locationId, address, zip) => wrap(() => callAdmin('setLocationAddress', { location_id: locationId, address, zip })));
ipcMain.handle('owner:setLocationMerchantFee', async (_e, locationId, fees) => wrap(() => callAdmin('setLocationMerchantFee', { location_id: locationId, ...(fees || {}) })));
ipcMain.handle('owner:setLocationContact', async (_e, locationId, phone, email) => wrap(() => callAdmin('setLocationContact', { location_id: locationId, phone, email })));
ipcMain.handle('owner:setBusinessContact', async (_e, tenantId, contact_email, contact_phone) => wrap(() => callAdmin('setBusinessContact', { tenant_id: tenantId, contact_email, contact_phone })));
ipcMain.handle('owner:setFeatures', async (_e, tenantId, features) => wrap(() => callAdmin('setFeatures', { tenant_id: tenantId, features })));
ipcMain.handle('owner:setTwilioConfig', async (_e, tenantId, cfg) => wrap(() => callAdmin('setTwilioConfig', { tenant_id: tenantId, ...cfg })));

ipcMain.handle('owner:setMaxRegisters', async (_e, licenseKey, maxRegisters) => wrap(() => callAdmin('update', { license_key: licenseKey, max_registers: maxRegisters })));
ipcMain.handle('owner:setAds', async (_e, licenseKey, displayConfig) => wrap(() => callAdmin('setAds', { license_key: licenseKey, display_config: displayConfig })));
ipcMain.handle('owner:createManager', async (_e, tenantId, username, name) => wrap(() => callAdmin('createManager', { tenant_id: tenantId, username, name })));
ipcMain.handle('owner:createStaffUser', async (_e, tenantId, payload) => wrap(() => callAdmin('createStaffUser', { tenant_id: tenantId, ...(payload || {}) })));


ipcMain.handle('owner:kiosks', async (_e, tenantId) => wrap(() => callAdmin('kiosks', { tenant_id: tenantId })));
ipcMain.handle('owner:resetKiosk', async (_e, tenantId, machineId) => wrap(() => callAdmin('resetKiosk', { tenant_id: tenantId, machine_id: machineId })));
ipcMain.handle('owner:cancelReset', async (_e, tenantId, machineId) => wrap(() => callAdmin('cancelReset', { tenant_id: tenantId, machine_id: machineId })));


ipcMain.handle('owner:onlineOrders', async (_e, tenantId) => wrap(() => callAdmin('onlineOrders', { tenant_id: tenantId || null })));


ipcMain.handle('owner:staff', async (_e, tenantId) => wrap(() => callAdmin('staff', { tenant_id: tenantId })));
ipcMain.handle('owner:setStaffPermission', async (_e, payload) => wrap(() => callAdmin('setStaffPermission', payload || {})));
ipcMain.handle('owner:resetStaffPassword', async (_e, tenantId, employeeUid) => wrap(() => callAdmin('resetStaffPassword', { tenant_id: tenantId, employee_uid: employeeUid })));
ipcMain.handle('owner:resetStaffPin', async (_e, tenantId, employeeUid) => wrap(() => callAdmin('resetStaffPin', { tenant_id: tenantId, employee_uid: employeeUid })));
ipcMain.handle('owner:promoteToAdmin', async (_e, tenantId, employeeUid) => wrap(() => callAdmin('setStaffRole', { tenant_id: tenantId, employee_uid: employeeUid, role: 'admin' })));
ipcMain.handle('owner:revenueByLocation', async (_e, tenantId) => wrap(() => callAdmin('revenueByLocation', { tenant_id: tenantId })));
ipcMain.handle('owner:auditLog', async (_e, tenantId) => wrap(() => callAdmin('auditLog', { tenant_id: tenantId })));


ipcMain.handle('owner:publishStatus', async () => wrap(() => callAdmin('publishStatus')));
ipcMain.handle('owner:publish', async (_e, appId) => wrap(() => callAdmin('publish', { app: appId })));


async function wrap(fn) {
  try { const data = await fn(); return { success: true, ...(data && typeof data === 'object' ? data : { data }) }; }
  catch (e) { return { success: false, error: String(e.message || e) }; }
}
