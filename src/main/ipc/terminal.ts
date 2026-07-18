import { ipcMain, app } from 'electron';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { getDb } from '../db/schema';
import { assertWritable } from '../supabase/licenseCheck';
import { getTerminal } from '../services/cardTerminal';
import type { ValorPayload } from '../services/cardTerminal';

// Singleton terminal instance — reused unless the config actually changes.
// Recreating it would respawn the TCP server and fail to rebind the port,
// which is why the Test button used to report "server not running".
let activeTerminal: ReturnType<typeof getTerminal> | null = null;
let activeKey = '';

function loadTerminal() {
  const db = getDb();
  const get = (key: string) =>
    (db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? '';

  const type = get('terminal_type') || 'mock';
  const ip   = get('terminal_ip');
  const port = parseInt(get('terminal_port') || '5000', 10);
  const transport = get('terminal_transport') || 'tcp';
  const key  = `${type}|${ip}|${port}|${transport}`;

  // Reuse the live instance (and its already-listening server) if unchanged.
  if (activeTerminal && key === activeKey) {
    return { terminal: activeTerminal, type };
  }
  // Config changed (or first run) — tear down the old server, start fresh.
  const old = activeTerminal as unknown as { destroy?: () => void };
  if (old && typeof old.destroy === 'function') {
    try { old.destroy(); } catch { /* ignore */ }
  }
  activeTerminal = getTerminal(type, ip, port);
  activeKey = key;
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
      // Client mode: can we open a connection to the terminal right now?
      const reachable = await terminal.testConnection();
      const db = getDb();
      const g2 = (k: string) => (db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value || '';
      const ipVal = g2('terminal_ip');
      const portVal = g2('terminal_port') || '5000';
      const transVal = g2('terminal_transport') || 'tcp';
      return {
        success: reachable,
        message: reachable
          ? `✓ Reached the terminal at ${ipVal}:${portVal} (${transVal}).`
          : `Could not reach the terminal at ${ipVal || '(no IP set)'}:${portVal} (${transVal}). Check the terminal's IP, that the connection type matches, and that it shows "Server is Waiting for Transaction".`,
      };
    } catch (err) {
      return { success: false, message: String(err) };
    }
  });

  // ── terminal:localIps — this PC's LAN IPv4 address(es) ────────────────────
  ipcMain.handle('terminal:localIps', () => {
    const ips: string[] = [];
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const ni of ifaces[name] || []) {
        if (ni.family === 'IPv4' && !ni.internal) ips.push(ni.address);
      }
    }
    return { success: true, ips };
  });

  // ── terminal:getConfig ───────────────────────────────────────────────────
  ipcMain.handle('terminal:getConfig', () => {
    try {
      const db = getDb();
      const keys = [
        'terminal_type', 'terminal_ip', 'terminal_port', 'terminal_transport',
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
      const w = assertWritable('settings_change'); if (!w.ok) return { success: false, error: w.error };
      const db = getDb();
      const allowed = [
        'terminal_type', 'terminal_ip', 'terminal_port', 'terminal_transport',
        'terminal_mid', 'terminal_tid',
        'terminal_epi', 'terminal_channel', 'terminal_environment',
      ];
      for (const key of allowed) {
        if (key in config) {
          db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, config[key]);
        }
      }
      // loadTerminal() detects the config change and restarts the server.
      loadTerminal();
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
