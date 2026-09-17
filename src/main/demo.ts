import { app, type BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { loadEnv } from './supabase/env';


let packagedFlag: boolean | null = null;
function packagedDemo(): boolean {
  if (packagedFlag !== null) return packagedFlag;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8'));
    packagedFlag = meta.rackdDemo === true || meta.rackdDemo === 'true' || meta.rackdDemo === 1;
  } catch { packagedFlag = false; }
  return packagedFlag;
}


export function isDemo(): boolean {
  loadEnv();
  return process.env.DEMO_MODE === '1' || process.env.RACKD_DEMO === '1' || packagedDemo();
}


export function applyDemoConfig(): void {
  if (!isDemo()) return;
  if (process.env.SANDBOX_SUPABASE_URL) process.env.SUPABASE_URL = process.env.SANDBOX_SUPABASE_URL;
  if (process.env.SANDBOX_SUPABASE_ANON_KEY) process.env.SUPABASE_ANON_KEY = process.env.SANDBOX_SUPABASE_ANON_KEY;
  console.log('[demo] sandbox mode — cloud isolated to the demo project.');
}

const BADGE_JS =
  `(function(){if(document.getElementById('__demo'))return;` +
  `var d=document.createElement('div');d.id='__demo';d.textContent='DEMO';` +
  `d.style.cssText='position:fixed;top:8px;right:10px;z-index:2147483647;background:#b01d2e;color:#fff;` +
  `font:700 11px system-ui,sans-serif;letter-spacing:2px;padding:4px 10px;border-radius:6px;` +
  `box-shadow:0 2px 10px rgba(0,0,0,.45);pointer-events:none';document.body.appendChild(d);})();`;


export function attachDemoBadge(win: BrowserWindow): void {
  if (!isDemo()) return;
  win.webContents.on('did-finish-load', () => {
    win.webContents.executeJavaScript(BADGE_JS).catch(() => {  });
  });
}
