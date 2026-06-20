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

app.whenReady().then(() => {
  // Initialize DB
  getDb();

  // Create main window
  const win = createMainWindow();

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
