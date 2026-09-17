import { app, ipcMain, dialog, globalShortcut } from 'electron';
import { createMainWindow, navigateTo, getMainWindow } from './windows/main';
import { createCustomerDisplayWindow, updateCustomerDisplay, getCustomerDisplayWindow } from './windows/customerDisplay';
import { getDb } from './db/schema';
import { registerAuthHandlers } from './ipc/auth';
import { registerSessionHandlers } from './ipc/session';
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
import { registerAIHandlers } from './ipc/ai';
import { registerAnalyticsHandlers } from './ipc/analytics';
import { registerOnboardingHandlers } from './ipc/onboarding';
import { registerCatalogHandlers } from './ipc/catalog';
import { registerBillingHandlers } from './ipc/billing';
import { registerRebateHandlers } from './ipc/rebates';
import { registerLayoutHandlers } from './ipc/layout';
import { registerPricingGroupHandlers } from './ipc/pricingGroups';
import { registerCategoryHandlers } from './ipc/categories';
import { registerPermissionHandlers } from './ipc/permissions';
import { registerTimeClockHandlers } from './ipc/timeclock';
import { registerStorefrontHandlers } from './ipc/storefront';
import { registerActivationHandlers, isActivated } from './ipc/activation';
import { isSupabaseConfigured } from './supabase/client';
import { startSyncWorker } from './supabase/sync';
import { startLicenseChecks } from './supabase/licenseCheck';
import { startTokenAutoRefresh } from './supabase/tokenManager';
import { startUpdater, registerUpdaterHandlers } from './updater';
import { startPickupPrinter } from './services/pickupPrinter';
import { startBatchScheduler } from './batchScheduler';
import { applyDemoConfig, attachDemoBadge } from './demo';
import { logBoot } from './bootDiagnostics';
import { startDiagnosticsWorker, registerDiagnosticsHandlers, reportError } from './diagnostics';


process.on('uncaughtException', (err) => {
  console.error('[main] uncaught exception:', err);
  void reportError('main', err?.message || String(err), err?.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection:', reason);
  const err = reason instanceof Error ? reason : null;
  void reportError('main', err?.message || String(reason), err?.stack);
});

app.whenReady().then(() => {
  
  
  applyDemoConfig();

  
  const db = getDb();

  
  
  
  
  
  
  
  logBoot(db);

  
  
  startLicenseChecks();

  
  
  startTokenAutoRefresh();

  
  
  
  registerActivationHandlers();
  registerUpdaterHandlers();
  registerDiagnosticsHandlers();
  startUpdater(); 
  const bootPage = isSupabaseConfigured() && !isActivated() ? 'activation' : 'login';

  
  const win = createMainWindow(bootPage);
  attachDemoBadge(win); 

  
  createCustomerDisplayWindow();

  
  registerAuthHandlers();
  registerSessionHandlers();
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
  registerAIHandlers();
  registerAnalyticsHandlers();
  registerOnboardingHandlers();
  registerCatalogHandlers();
  registerBillingHandlers();
  registerRebateHandlers();
  registerLayoutHandlers();
  registerPricingGroupHandlers();
  registerCategoryHandlers();
  registerPermissionHandlers();
  registerTimeClockHandlers();
  registerStorefrontHandlers();

  
  
  startSyncWorker();

  
  
  
  startDiagnosticsWorker();

  
  startPickupPrinter();

  
  
  startBatchScheduler();

  
  try { runPointExpiry(getDb()); } catch {  }

  
  ipcMain.handle('navigate', (_event, page: string) => {
    navigateTo(page);
  });

  
  ipcMain.handle('printPage', () => {
    const win = getMainWindow();
    if (win) win.webContents.print({ silent: false, printBackground: false });
  });

  
  ipcMain.handle('dialog:openPdf', async () => {
    const win = getMainWindow();
    const result = await dialog.showOpenDialog(win!, {
      properties: ['openFile'],
      filters: [{ name: 'PDF Files', extensions: ['pdf'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  
  ipcMain.handle('customerDisplay:update', (_event, data: object) => {
    updateCustomerDisplay(data);
  });

  
  
  ipcMain.handle('customerDisplay:consent', (_event, payload: object) => {
    getMainWindow()?.webContents.send('customer-consent', payload);
  });

  
  
  ipcMain.handle('customerDisplay:tip', (_event, payload: object) => {
    getMainWindow()?.webContents.send('customer-tip', payload);
  });

  
  ipcMain.handle('customerDisplay:isAvailable', () => !!getCustomerDisplayWindow());

  
  ipcMain.handle('window:toggleFullscreen', () => {
    const w = getMainWindow();
    if (w) {
      const next = !w.isFullScreen();
      w.setFullScreen(next);
      return next;
    }
    return false;
  });

  
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
