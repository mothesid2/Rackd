import { getDb } from '../db/schema';

// ─────────────────────────────────────────────────────────────────────────────
//  Cash drawer control.
//
//  Two kinds of drawer are supported:
//   • 'serial'  — a standalone USB cash drawer that enumerates as a COM/serial
//                 port. We pop it by writing an ESC/POS "kick" byte sequence
//                 straight to the port. (HP/APG/generic USB drawers.)
//   • 'printer' — a drawer wired into the receipt printer's RJ12 kick port;
//                 popped through the printer (see services/printer.ts).
//
//  Settings:
//   drawer_type      'serial' | 'printer' | 'none'
//   drawer_com_port  e.g. 'COM3' (blank = auto-detect)
//   drawer_baud      e.g. '9600'
//   drawer_kick_hex  kick bytes, e.g. '1B 70 00 19 FA'
// ─────────────────────────────────────────────────────────────────────────────

type DrawerResult = { success: boolean; error?: string; via?: string; port?: string };

// Lazily require serialport so a missing/unbuilt native binding only breaks the
// drawer feature, never the whole app at startup.
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
let serialLib: any = null;
function loadSerial(): any {
  if (!serialLib) serialLib = require('serialport');
  return serialLib;
}

function getSetting(key: string, def: string): string {
  const db = getDb();
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return (row?.value ?? def) || def;
}

export async function listSerialPorts(): Promise<
  { path: string; manufacturer?: string; vendorId?: string; productId?: string; pnpId?: string }[]
> {
  try {
    const { SerialPort } = loadSerial();
    const ports = await SerialPort.list();
    return ports.map((p: any) => ({
      path: p.path,
      manufacturer: p.manufacturer,
      vendorId: p.vendorId,
      productId: p.productId,
      pnpId: p.pnpId,
    }));
  } catch {
    return [];
  }
}

async function resolvePort(configured: string): Promise<string | null> {
  if (configured) return configured;
  const ports = await listSerialPorts();
  if (!ports.length) return null;
  // Prefer an HP-vid drawer (03F0), else the first available serial port.
  const hp = ports.find((p) => (p.vendorId || '').toLowerCase() === '03f0');
  return (hp || ports[0]).path;
}

function parseKick(hex: string): Buffer {
  const bytes = hex.trim().split(/[\s,]+/).filter(Boolean).map((h) => parseInt(h, 16));
  if (!bytes.length || bytes.some((b) => isNaN(b))) {
    return Buffer.from([0x1b, 0x70, 0x00, 0x19, 0xfa]); // ESC/POS default kick
  }
  return Buffer.from(bytes);
}

async function serialKick(): Promise<DrawerResult> {
  let SerialPort: any;
  try { ({ SerialPort } = loadSerial()); }
  catch (e) { return { success: false, error: `Serial driver unavailable: ${String(e)}` }; }

  const path = await resolvePort(getSetting('drawer_com_port', ''));
  if (!path) {
    return { success: false, error: 'No USB serial cash drawer found. Plug it in, or set the COM port in Settings.' };
  }
  const baudRate = parseInt(getSetting('drawer_baud', '9600'), 10) || 9600;
  const kick = parseKick(getSetting('drawer_kick_hex', '1B 70 00 19 FA'));

  return new Promise<DrawerResult>((resolve) => {
    let done = false;
    const finish = (r: DrawerResult) => { if (!done) { done = true; resolve(r); } };

    const port = new SerialPort({ path, baudRate, autoOpen: true }, (err: Error | null) => {
      if (err) { finish({ success: false, error: `Could not open ${path}: ${err.message}`, port: path }); return; }
      port.write(kick, (werr: Error | null | undefined) => {
        if (werr) { try { port.close(); } catch { /* ignore */ } finish({ success: false, error: `Write failed on ${path}: ${werr.message}`, port: path }); return; }
        port.drain(() => { try { port.close(); } catch { /* ignore */ } finish({ success: true, via: 'serial', port: path }); });
      });
    });
    port.on('error', () => { /* surfaced via the open/write callbacks */ });
    // Safety timeout so a stuck port never hangs a sale
    setTimeout(() => { try { port.close(); } catch { /* ignore */ } finish({ success: false, error: `Timed out talking to ${path}`, port: path }); }, 4000);
  });
}

export async function popCashDrawer(): Promise<DrawerResult> {
  const type = getSetting('drawer_type', 'serial');
  if (type === 'none') return { success: false, error: 'Cash drawer is turned off in Settings.' };
  if (type === 'printer') {
    const { openCashDrawer } = await import('./printer');
    const r = await openCashDrawer();
    return { ...r, via: 'printer' };
  }
  return serialKick();
}
