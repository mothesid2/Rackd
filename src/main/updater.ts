import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { getDb } from './db/schema';
import { PUBLIC_SUPABASE_URL } from './supabase/publicConfig';
import { isIdleLocked } from './daySession';
import { getCurrentSession } from './ipc/auth';


const BUCKET = 'app-updates';

const APP = 'pos';

function channel(): 'production' | 'staging' {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'update_channel'").get() as { value: string } | undefined;
    return row?.value === 'staging' ? 'staging' : 'production';
  } catch {
    return 'production';
  }
}

function feedUrl(): string {
  return `${PUBLIC_SUPABASE_URL.replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/${APP}/${channel()}`;
}

function broadcast(state: string, extra: Record<string, unknown> = {}): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) {
      try { w.webContents.send('update:status', { state, ...extra }); } catch {  }
    }
  }
}

let started = false;


const BOOT_APPLY_WINDOW_MS = 3 * 60 * 1000; 
const IDLE_RESTART_CHECK_MS = 2 * 60 * 1000; 
let updateReady = false;


function isSafeToRestart(): boolean {
  return !getCurrentSession() || isIdleLocked();
}

export function startUpdater(): void {
  if (started) return;
  started = true;
  if (!app.isPackaged) return; 

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  try { autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl() }); } catch {  }

  
  let bootApplyOpen = true;
  setTimeout(() => { bootApplyOpen = false; }, BOOT_APPLY_WINDOW_MS);

  autoUpdater.on('checking-for-update', () => broadcast('checking'));
  autoUpdater.on('update-available', (info) => broadcast('available', { version: info.version }));
  autoUpdater.on('update-not-available', () => broadcast('none'));
  autoUpdater.on('download-progress', (p) => broadcast('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    broadcast('ready', { version: info.version });
    
    if (bootApplyOpen) {
      
      setImmediate(() => { try { autoUpdater.quitAndInstall(true, true); } catch {  } });
      return;
    }
    
    
    
    updateReady = true;
  });
  autoUpdater.on('error', (err) => broadcast('error', { error: String(err) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 3000); 
  setInterval(check, 6 * 60 * 60 * 1000); 

  
  
  setInterval(() => {
    if (!updateReady) return;
    if (!isSafeToRestart()) return;
    updateReady = false; 
    try { autoUpdater.quitAndInstall(true, true); } catch {  }
  }, IDLE_RESTART_CHECK_MS);
}

export function registerUpdaterHandlers(): void {
  ipcMain.handle('update:check', () => {
    if (app.isPackaged) autoUpdater.checkForUpdates().catch(() => {});
    return { success: true, packaged: app.isPackaged };
  });
  ipcMain.handle('update:install', () => {
    autoUpdater.quitAndInstall();
    return { success: true };
  });
  ipcMain.handle('update:getChannel', () => ({ success: true, channel: channel() }));
  ipcMain.handle('update:setChannel', (_e, ch: string) => {
    getDb()
      .prepare("INSERT INTO settings (key, value) VALUES ('update_channel', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(ch === 'staging' ? 'staging' : 'production');
    try { autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl() }); } catch {  }
    return { success: true };
  });
}
