import { app, BrowserWindow, ipcMain } from 'electron';
import { autoUpdater } from 'electron-updater';
import { getDb } from './db/schema';
import { PUBLIC_SUPABASE_URL } from './supabase/publicConfig';

/**
 * Auto-update via a public Supabase Storage bucket.
 *
 * Two channels live in the bucket as folders:
 *   app-updates/production/   <- customer installs point here (default)
 *   app-updates/staging/      <- your test machine points here
 *
 * Releasing is manual (npm run release[:staging]) — nothing ships until you run
 * it. Your test register (Owner Console → update channel = staging) gets the
 * staging build first; promote to production when you're happy.
 */
const BUCKET = 'app-updates';
// Per-app layout so the Owner Console Publish hub can promote each app
// independently: app-updates/<app>/<channel>/. This app is the POS.
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
      try { w.webContents.send('update:status', { state, ...extra }); } catch { /* window gone */ }
    }
  }
}

let started = false;

// After boot, if an update finishes downloading within this window we relaunch
// into it immediately ("auto-update on boot"). Downloads that land later — or the
// 6-hourly periodic checks — defer the install to the next quit instead, so a
// register is never force-restarted in the middle of a shift.
const BOOT_APPLY_WINDOW_MS = 3 * 60 * 1000; // 3 minutes

export function startUpdater(): void {
  if (started) return;
  started = true;
  if (!app.isPackaged) return; // never auto-update a dev run

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  try { autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl() }); } catch { /* ignore */ }

  // Open the boot-apply window; it closes shortly after launch.
  let bootApplyOpen = true;
  setTimeout(() => { bootApplyOpen = false; }, BOOT_APPLY_WINDOW_MS);

  autoUpdater.on('checking-for-update', () => broadcast('checking'));
  autoUpdater.on('update-available', (info) => broadcast('available', { version: info.version }));
  autoUpdater.on('update-not-available', () => broadcast('none'));
  autoUpdater.on('download-progress', (p) => broadcast('downloading', { percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    broadcast('ready', { version: info.version });
    // Boot-time update: relaunch straight into the new version. Outside the boot
    // window we leave autoInstallOnAppQuit to apply it on the next quit.
    if (bootApplyOpen) {
      // isSilent = true, isForceRunAfter = true -> install quietly and relaunch.
      setImmediate(() => { try { autoUpdater.quitAndInstall(true, true); } catch { /* ignore */ } });
    }
  });
  autoUpdater.on('error', (err) => broadcast('error', { error: String(err) }));

  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 3000); // check right after launch (inside the boot-apply window)
  setInterval(check, 6 * 60 * 60 * 1000); // and every 6 hours (download only; installs on quit)
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
    try { autoUpdater.setFeedURL({ provider: 'generic', url: feedUrl() }); } catch { /* ignore */ }
    return { success: true };
  });
}
