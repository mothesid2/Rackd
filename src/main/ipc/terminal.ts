import { ipcMain, app } from 'electron';
import path from 'path';
import fs from 'fs';
import { getDb } from '../db/schema';
import { getTerminal } from '../services/cardTerminal';
import type { ValorPayload } from '../services/cardTerminal';

// Singleton terminal instance — replaced whenever config changes
let activeTerminal: ReturnType<typeof getTerminal> | null = null;

function loadTerminal() {
  const db = getDb();
  const get = (key: string) =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '';

  const type = get('terminal_type') || 'mock';
  const ip   = get('terminal_ip');
  const port = parseInt(get('terminal_port') || '5000', 10);

  activeTerminal = getTerminal(type, ip, port);
  return { terminal: activeTerminal, type };
}

export function registerTerminalHandlers(): void {
  // Start the terminal server eagerly so the VP100 can connect before any sale
  loadTerminal();

  // ── terminal:sendPayment ─────────────────────────────────────────────────
  // Accepts a ValorPayload object; routes to whichever terminal is configured.
  ipcMain.handle('terminal:sendPayment', async (_event, payload: ValorPayload) => {
    try {
      const db = getDb();
      const type = (db.prepare("SELECT value FROM settings WHERE key = 'terminal_type'").get() as { value: string } | undefined)?.value || 'mock';

          // Guard: nothing required for valor_vp100 server mode — port defaults to 5000

      const { terminal } = loadTerminal();
      const result = await terminal.sendPayment(payload);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── terminal:cancel ──────────────────────────────────────────────────────
  ipcMain.handle('terminal:cancel', async () => {
    try {
      if (activeTerminal) await activeTerminal.cancelTransaction();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── terminal:test ────────────────────────────────────────────────────────
  ipcMain.handle('terminal:test', async () => {
    try {
      const { terminal, type } = loadTerminal();
      if (type === 'mock') {
        return { success: true, message: 'Mock terminal always responds OK.' };
      }
      const serverRunning = await terminal.testConnection();
      const termConnected = typeof (terminal as any).isTerminalConnected === 'function'
        && (terminal as any).isTerminalConnected();
      return {
        success: serverRunning,
        message: !serverRunning
          ? 'Server not running — restart the app.'
          : termConnected
            ? '✓ Server running — terminal is connected.'
            : 'Server running — terminal not yet connected. Complete Valor Portal setup and do a Param Download on the terminal.',
      };
    } catch (err) {
      return { success: false, message: String(err) };
    }
  });

  // ── terminal:getConfig ───────────────────────────────────────────────────
  ipcMain.handle('terminal:getConfig', () => {
    try {
      const db = getDb();
      const keys = [
        'terminal_type', 'terminal_ip', 'terminal_port',
        'terminal_mid', 'terminal_tid',
        'terminal_epi', 'terminal_channel', 'terminal_environment',
      ];
      const config: Record<string, string> = {};
      for (const key of keys) {
        const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
        config[key] = row?.value ?? '';
      }
      return { success: true, config };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── terminal:saveConfig ──────────────────────────────────────────────────
  ipcMain.handle('terminal:saveConfig', (_event, config: Record<string, string>) => {
    try {
      const db = getDb();
      const allowed = [
        'terminal_type', 'terminal_ip', 'terminal_port',
        'terminal_mid', 'terminal_tid',
        'terminal_epi', 'terminal_channel', 'terminal_environment',
      ];
      for (const key of allowed) {
        if (key in config) {
          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, config[key]);
        }
      }
      // Destroy old terminal (closes TCP server) then start fresh
      if (activeTerminal && typeof (activeTerminal as any).destroy === 'function') {
        (activeTerminal as any).destroy();
      }
      activeTerminal = null;
      loadTerminal(); // restart server with new port if changed
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  // ── terminal:certStatus ──────────────────────────────────────────────────
  ipcMain.handle('terminal:certStatus', () => {
    const certDir = path.join(app.getPath('userData'), 'valor_certs');
    // ca.crt and ca-chain.crt are both accepted as the CA certificate
    const caFile = fs.existsSync(path.join(certDir, 'ca.crt')) ? 'ca.crt'
      : fs.existsSync(path.join(certDir, 'ca-chain.crt')) ? 'ca-chain.crt'
      : null;
    const required = ['client.crt', 'client.key'];
    const present: string[] = [];
    const missing: string[] = [];
    if (caFile) present.push(caFile); else missing.push('ca.crt (or ca-chain.crt)');
    for (const f of required) {
      if (fs.existsSync(path.join(certDir, f))) present.push(f); else missing.push(f);
    }
    return { certDir, present, missing };
  });
}
