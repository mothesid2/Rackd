// Rackd Storefront — desktop wrapper.
//
// The storefront is a public WEB app (deployed to Cloudflare Pages). This is a thin
// Electron shell that loads it in a phone-shaped window — handy for demoing to
// prospects without opening a browser. The Production build loads the real
// storefront; the Demo build loads the preview/sandbox deployment and watermarks
// itself "DEMO". Nothing customer-facing depends on this wrapper.

const { app, BrowserWindow, shell } = require('electron');
const cfg = require('./config');

let pkgMeta = {};
try { pkgMeta = require('./package.json'); } catch { /* ignore */ }
const DEMO = process.env.RACKD_DEMO === '1' || pkgMeta.rackdDemo === true;
const TARGET_URL = DEMO ? (cfg.DEMO_URL || cfg.PROD_URL) : cfg.PROD_URL;

const BADGE_JS =
  `(function(){if(document.getElementById('__demo'))return;var d=document.createElement('div');d.id='__demo';` +
  `d.textContent='DEMO';d.style.cssText='position:fixed;top:8px;right:10px;z-index:2147483647;background:#b01d2e;` +
  `color:#fff;font:700 11px system-ui,sans-serif;letter-spacing:2px;padding:4px 10px;border-radius:6px;` +
  `box-shadow:0 2px 10px rgba(0,0,0,.45);pointer-events:none';document.body.appendChild(d);})();`;

function createWindow() {
  const win = new BrowserWindow({
    width: 460, height: 880, minWidth: 360, minHeight: 640, backgroundColor: '#f5f2ed',
    title: DEMO ? 'Rackd Storefront (Demo)' : 'Rackd Storefront',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.loadURL(TARGET_URL).catch(() => {});
  // External links (e.g. Stripe) open in the real browser.
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  if (DEMO) win.webContents.on('did-finish-load', () => win.webContents.executeJavaScript(BADGE_JS).catch(() => {}));
  return win;
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
