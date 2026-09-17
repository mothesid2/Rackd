import { ipcMain, app } from 'electron';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { getDb } from '../db/schema';
import { assertWritable } from '../supabase/licenseCheck';
import { getTerminal } from '../services/cardTerminal';
import type { ValorPayload } from '../services/cardTerminal';


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

  
  if (activeTerminal && key === activeKey) {
    return { terminal: activeTerminal, type };
  }
  
  const old = activeTerminal as unknown as { destroy?: () => void };
  if (old && typeof old.destroy === 'function') {
    try { old.destroy(); } catch {  }
  }
  activeTerminal = getTerminal(type, ip, port);
  activeKey = key;
  return { terminal: activeTerminal, type };
}

export function registerTerminalHandlers(): void {
  
  loadTerminal();

  
  
  ipcMain.handle('terminal:sendPayment', async (_event, payload: ValorPayload) => {
    try {
      const db = getDb();
      const type = (db.prepare("SELECT value FROM settings WHERE key = 'terminal_type'").get() as { value: string } | undefined)?.value || 'mock';

          

      const { terminal } = loadTerminal();
      const result = await terminal.sendPayment(payload);
      return { success: true, result };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('terminal:cancel', async () => {
    try {
      if (activeTerminal) await activeTerminal.cancelTransaction();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('terminal:test', async () => {
    try {
      const { terminal, type } = loadTerminal();
      if (type === 'mock') {
        return { success: true, message: 'Mock terminal always responds OK.' };
      }
      
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
      
      loadTerminal();
      return { success: true };
    } catch (err) {
      return { success: false, error: String(err) };
    }
  });

  
  ipcMain.handle('terminal:certStatus', () => {
    const certDir = path.join(app.getPath('userData'), 'valor_certs');
    
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
