import { ipcMain } from 'electron';
import { getDb } from '../db/schema';
import { printZebraTagsForProducts, ZebraProduct } from '../services/zebraPrinter';

export function registerZebraHandlers(): void {
  ipcMain.handle('zebra:printTags', async (_event, products: ZebraProduct[]) => {
    try {
      const db = getDb();

      const ipRow = db.prepare("SELECT value FROM settings WHERE key = 'zebra_ip'").get() as { value: string } | undefined;
      const portRow = db.prepare("SELECT value FROM settings WHERE key = 'zebra_port'").get() as { value: string } | undefined;

      const ip = ipRow?.value?.trim();
      const port = parseInt(portRow?.value || '9100');

      if (!ip) {
        
        return { success: false, error: 'Zebra printer IP not configured. Go to Settings → Zebra Printer.', fallback: true };
      }

      const result = await printZebraTagsForProducts(products, ip, port);
      return result;
    } catch (err) {
      return { success: false, error: String(err), printed: 0 };
    }
  });
}
