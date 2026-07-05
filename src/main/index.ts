import { app, ipcMain, dialog, globalShortcut } from 'electron';
import { createMainWindow, navigateTo, getMainWindow } from './windows/main';
import { createCustomerDisplayWindow, updateCustomerDisplay } from './windows/customerDisplay';
import { getDb } from './db/schema';
import { registerAuthHandlers } from './ipc/auth';
import { registerProductHandlers } from './ipc/products';
import { registerTransactionHandlers } from './ipc/transactions';
import { registerCustomerHandlers } from './ipc/customers';
import { registerSmsHandlers } from './ipc/sms';
import { registerInvoiceHandlers } from './ipc/invoices';
import { registerXZOutHandlers } from './ipc/xzout';
import { registerReceiptHandlers } from './ipc/receipt';
import { registerSettingsHandlers } from './ipc/settings';
import { registerTerminalHandlers } from './ipc/terminal';
import { registerZebraHandlers } from './ipc/zebra';
import { registerPromoHandlers } from './ipc/promos';
import { registerLoyaltyHandlers, runPointExpiry } from './ipc/loyalty';
import { registerDrawerHandlers } from './ipc/drawer';
import { registerDatabaseHandlers } from './ipc/database';
import { registerSyncHandlers } from './ipc/sync';
import { registerLicenseHandlers } from './ipc/license';
import { registerOwnerHandlers } from './ipc/owner';
import { registerAdminHandlers } from './ipc/admin';
import { registerActivationHandlers, isActivated } from './ipc/activation';
import { isSupabaseConfigured } from './supabase/client';
import { startSyncWorker } from './supabase/sync';
import { startLicenseChecks } from './supabase/licenseCheck';
import { startTokenAutoRefresh } from './supabase/tokenManager';

app.whenReady().then(() => {
  // 1. Initialize SQLite + run pending migrations
  getDb();

  // 2-5. Load cached license, attempt a (non-blocking) Supabase check, and
  // lock/unlock features from the result. Returns immediately from cache.
  startLicenseChecks();

  // 5b. Fetch/refresh the per-install auth JWT in the background (non-blocking;
  // POS starts even if this fails). Result is logged to the settings table.
  startTokenAutoRefresh();

  // Activation must be registered before the window loads (the activation
  // screen calls it). Boot into activation when the cloud is configured but this
  // register hasn't been bound to a license yet; otherwise straight to login.
  registerActivationHandlers();
  const bootPage = isSupabaseConfigured() && !isActivated() ? 'activation' : 'login';

  // Create main window
  const win = createMainWindow(bootPage);

  // Try to create customer display on second monitor
  createCustomerDisplayWindow();

  // Register all IPC handlers
  registerAuthHandlers();
  registerProductHandlers();
  registerTransactionHandlers();
  registerCustomerHandlers();
  registerSmsHandlers();
  registerInvoiceHandlers();
  registerXZOutHandlers();
  registerReceiptHandlers();
  registerSettingsHandlers();
  registerTerminalHandlers();
  registerZebraHandlers();
  registerPromoHandlers();
  registerLoyaltyHandlers();
  registerDrawerHandlers();
  registerDatabaseHandlers();
  registerSyncHandlers();
  registerLicenseHandlers();
  registerOwnerHandlers();
  registerAdminHandlers();

  // 6. Cloud layer: start the local-first -> Supabase sync worker (no-op if
  // Supabase isn't configured; the POS runs fully on local SQLite regardless).
  startSyncWorker();

  // "Use it or lose it" — expire stale loyalty points once at startup
  try { runPointExpiry(getDb()); } catch { /* non-fatal */ }

  // Navigation handler
  ipcMain.handle('navigate', (_event, page: string) => {
    navigateTo(page);
  });

  // Print current page via native print dialog
  ipcMain.handle('printPage', () => {
    const win = getMainWindow();
    if (win) win.webContents.print({ silent: false, printBackground: false });
  });

  // File picker for PDF attachments
  ipcMain.handle('dialog:openPdf', async () => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // Customer display update handler
  ipcMain.handle('customerDisplay:update', (_event, data: object) => {
    updateCustomerDisplay(data);
  });

  // Fullscreen toggle
  ipcMain.handle('window:toggleFullscreen', () => {
    const w = getMainWindow();
    if (w) {
      const next = !w.isFullScreen();
      w.setFullScreen(next);
      return next;
    }
    return false;
  });

  // F11 global shortcut — works on every page
  globalShortcut.register('F11', () => {
    const w = getMainWindow();
    if (w) w.setFullScreen(!w.isFullScreen());
  });

  app.on('activate', () => {
    if (!win) createMainWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
