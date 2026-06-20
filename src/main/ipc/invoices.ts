import { ipcMain, shell } from 'electron';
import { getDb } from '../db/schema';
import { getCurrentSession } from './auth';
import { nowCT, todayCT } from '../utils/time';

interface InvoiceItem {
  product_id: number;
  qty_received: number;
  unit_cost: number;
}

export function registerInvoiceHandlers(): void {
  ipcMain.handle('invoices:getAll', async (_event, filters?: { supplier?: string; start_date?: string; end_date?: string }) => {
    try {
      const db = getDb();
      let sql = `
        SELECT i.*, u.username AS received_by_name
        FROM invoices i
        LEFT JOIN users u ON i.received_by = u.id
        WHERE 1=1
      `;
      const params: (string | number)[] = [];
      if (filters?.supplier) {
        sql += ' AND i.supplier LIKE ?';
        params.push(`%${filters.supplier}%`);
      }
      if (filters?.start_date) {
        sql += ' AND i.date >= ?';
        params.push(filters.start_date);
      }
      if (filters?.end_date) {
        sql += ' AND i.date <= ?';
        params.push(filters.end_date);
      }
      sql += ' ORDER BY i.created_at DESC LIMIT 100';
      const invoices = db.prepare(sql).all(...params);
      return { success: true, invoices };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('invoices:getOne', async (_event, id: number) => {
    try {
      const db = getDb();
      const invoice = db.prepare(`
        SELECT i.*, u.username AS received_by_name
        FROM invoices i
        LEFT JOIN users u ON i.received_by = u.id
        WHERE i.id = ?
      `).get(id);
      if (!invoice) return { success: false, error: 'Invoice not found' };
      const items = db.prepare(`
        SELECT ii.*, p.name AS product_name, p.barcode
        FROM invoice_items ii
        LEFT JOIN products p ON ii.product_id = p.id
        WHERE ii.invoice_id = ?
      `).all(id);
      return { success: true, invoice, items };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('invoices:delete', async (_event, id: number) => {
    try {
      const session = getCurrentSession();
      if (session?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      db.transaction(() => {
        db.prepare(`DELETE FROM invoice_items WHERE invoice_id = ?`).run(id);
        db.prepare(`DELETE FROM invoices WHERE id = ?`).run(id);
      })();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('invoices:openPdf', async (_event, id: number) => {
    try {
      const db = getDb();
      const row = db.prepare(`SELECT pdf_path FROM invoices WHERE id = ?`).get(id) as { pdf_path: string } | undefined;
      if (!row?.pdf_path) return { success: false, error: 'No PDF attached to this invoice' };
      const result = await shell.openPath(row.pdf_path);
      if (result) return { success: false, error: result };
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('invoices:attachPdf', async (_event, id: number, pdfPath: string) => {
    try {
      const session = getCurrentSession();
      if (session?.role !== 'manager') return { success: false, error: 'Manager access required' };
      const db = getDb();
      db.prepare('UPDATE invoices SET pdf_path = ? WHERE id = ?').run(pdfPath, id);
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  ipcMain.handle('invoices:create', async (_event, data: {
    supplier: string; invoice_number?: string; date?: string; items: InvoiceItem[];
  }) => {
    try {
      const db = getDb();
      const session = getCurrentSession();
      if (session?.role !== 'manager') return { success: false, error: 'Manager access required' };

      const txn = db.transaction(() => {
        const totalCost = data.items.reduce((s, i) => s + i.qty_received * i.unit_cost, 0);

        const result = db.prepare(`
          INSERT INTO invoices (supplier, invoice_number, date, total_cost, received_by)
          VALUES (?, ?, ?, ?, ?)
        `).run(
          data.supplier,
          data.invoice_number || null,
          data.date || todayCT(),
          totalCost,
          session?.userId || null
        );

        const invoiceId = result.lastInsertRowid;

        for (const item of data.items) {
          db.prepare(`
            INSERT INTO invoice_items (invoice_id, product_id, qty_received, unit_cost)
            VALUES (?, ?, ?, ?)
          `).run(invoiceId, item.product_id, item.qty_received, item.unit_cost);

          db.prepare(`
            UPDATE products
            SET stock_qty = stock_qty + ?, cost = ?, updated_at = ?
            WHERE id = ?
          `).run(item.qty_received, item.unit_cost, nowCT(), item.product_id);
        }

        return invoiceId;
      });

      const invoiceId = txn();
      return { success: true, id: invoiceId };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });
}
