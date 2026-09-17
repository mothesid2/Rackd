import net from 'net';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { getDb } from '../db/schema';
import type { CardTerminal, TerminalResult, ValorPayload } from './cardTerminal';



type Transport = 'tcp' | 'websocket';
const RESPONSE_TIMEOUT_MS = 90_000;

function readTransport(): Transport {
  try {
    const row = getDb().prepare("SELECT value FROM settings WHERE key = 'terminal_transport'").get() as { value: string } | undefined;
    return row?.value === 'websocket' ? 'websocket' : 'tcp';
  } catch { return 'tcp'; }
}

export class ValorTerminal implements CardTerminal {
  private transport: Transport;
  
  private activeConn: any = null; 

  constructor(private host: string, private port: number) {
    this.transport = readTransport();
  }

  private log(msg: string): void {
    try {
      const logPath = path.join(app.getPath('userData'), 'terminal_log.txt');
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch {  }
  }

  
  
  
  private finalResult(raw: string): TerminalResult | null {
    let obj: Record<string, unknown>;
    try { obj = JSON.parse(raw); } catch { return null; }
    const isFinal =
      'AUTH_RSP_TEXT' in obj || 'ERROR_MSG' in obj || 'TXN_ID' in obj || 'MASKED_PAN' in obj ||
      obj.STATE === '-1' || (obj.STATE === '0' && 'TRAN_METHOD' in obj);
    return isFinal ? this.parseResponse(raw) : null;
  }

  sendPayment(payload: ValorPayload): Promise<TerminalResult> {
    
    const cents = Math.round(payload.amount * 100);
    const isRefund = cents < 0;
    const body = JSON.stringify({
      TRAN_MODE: '1',
      TRAN_CODE: isRefund ? '5' : '1', 
      AMOUNT: String(Math.abs(cents)),
    });
    if (!this.host) {
      return Promise.resolve({ approved: false, errorMessage: 'Terminal IP not set. Enter it in Settings → Card Terminal.' });
    }
    this.log(`SEND (${this.transport}) -> ${this.host}:${this.port} txn=${payload.transactionId} ${isRefund ? 'REFUND ' : ''}| ${body}`);
    return this.transport === 'websocket' ? this.sendWs(body) : this.sendTcp(body);
  }

  private sendWs(body: string): Promise<TerminalResult> {
    return new Promise((resolve) => {
      
      const WebSocket = require('ws') as typeof import('ws');
      const url = `ws://${this.host}:${this.port}`;
      const ws = new WebSocket(url);
      this.activeConn = ws;
      let settled = false;
      const done = (r: TerminalResult) => {
        if (settled) return; settled = true; clearTimeout(timer);
        try { ws.close(); } catch {  }
        this.activeConn = null; resolve(r);
      };
      const timer = setTimeout(() => { this.log('TIMEOUT 90s'); done({ approved: false, errorMessage: 'Terminal timed out. Make sure the VP100 shows "Server is Waiting for Transaction".' }); }, RESPONSE_TIMEOUT_MS);

      ws.on('open', () => { this.log('WS connected — sending transaction'); ws.send(body); });
      
      ws.on('message', (data: any) => {
        const raw = (typeof data === 'string' ? data : Buffer.from(data).toString('utf8')).trim();
        if (!raw) return;
        const fin = this.finalResult(raw);
        if (fin) { this.log(`RECV(final,WS): ${raw}`); done(fin); }
        else this.log(`RECV(status,WS): ${raw}`);
      });
      ws.on('error', (err: Error) => { this.log(`WS error: ${err.message}`); done({ approved: false, errorMessage: `Could not reach the terminal at ${url} — ${err.message}` }); });
      ws.on('close', () => { if (!settled) done({ approved: false, errorMessage: 'Terminal closed the connection before responding.' }); });
    });
  }

  private sendTcp(body: string): Promise<TerminalResult> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      this.activeConn = socket;
      socket.setNoDelay(true);
      let settled = false;
      let buffer = '';
      const done = (r: TerminalResult) => {
        if (settled) return; settled = true; clearTimeout(timer);
        try { socket.destroy(); } catch {  }
        this.activeConn = null; resolve(r);
      };
      const timer = setTimeout(() => { this.log('TIMEOUT 90s'); done({ approved: false, errorMessage: 'Terminal timed out. Make sure the VP100 shows "Server is Waiting for Transaction".' }); }, RESPONSE_TIMEOUT_MS);

      socket.connect(this.port, this.host, () => { this.log('TCP connected — sending transaction'); socket.write(body + '\n'); });
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8');
        this.log(`DATA(TCP): ${chunk.toString('utf8').substring(0, 400)}`);
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1);
          if (!line) continue;
          const fin = this.finalResult(line);
          if (fin) { this.log(`RECV(final,TCP): ${line}`); done(fin); return; }
          this.log(`RECV(status,TCP): ${line}`);
        }
        const rest = buffer.trim();
        if (rest) { const fin = this.finalResult(rest); if (fin) { this.log(`RECV(final,TCP): ${rest}`); done(fin); } }
      });
      socket.on('error', (err: Error) => { this.log(`TCP error: ${err.message}`); done({ approved: false, errorMessage: `Could not reach the terminal at ${this.host}:${this.port} — ${err.message}` }); });
      socket.on('close', () => { if (!settled) done({ approved: false, errorMessage: 'Terminal closed the connection before responding.' }); });
    });
  }

  cancelTransaction(): Promise<void> {
    this.log('CANCEL requested by cashier');
    if (this.activeConn) {
      try { if (typeof this.activeConn.terminate === 'function') this.activeConn.terminate(); else this.activeConn.destroy(); } catch {  }
      this.activeConn = null;
    }
    return Promise.resolve();
  }

  
  testConnection(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.host) { resolve(false); return; }
      if (this.transport === 'websocket') {
        
        const WebSocket = require('ws') as typeof import('ws');
        const ws = new WebSocket(`ws://${this.host}:${this.port}`);
        let done = false;
        const finish = (ok: boolean) => { if (done) return; done = true; try { ws.close(); } catch {  } resolve(ok); };
        const t = setTimeout(() => finish(false), 5000);
        ws.on('open', () => { clearTimeout(t); this.log(`TEST WS OK ${this.host}:${this.port}`); finish(true); });
        ws.on('error', (e: Error) => { clearTimeout(t); this.log(`TEST WS error ${e.message}`); finish(false); });
      } else {
        const socket = new net.Socket(); let done = false;
        const finish = (ok: boolean) => { if (done) return; done = true; try { socket.destroy(); } catch {  } resolve(ok); };
        socket.setTimeout(5000);
        socket.once('connect', () => { this.log(`TEST TCP OK ${this.host}:${this.port}`); finish(true); });
        socket.once('timeout', () => finish(false));
        socket.once('error', () => finish(false));
        socket.connect(this.port, this.host);
      }
    });
  }

  isTerminalConnected(): boolean { return false; } 

  destroy(): void {
    if (this.activeConn) { try { if (typeof this.activeConn.terminate === 'function') this.activeConn.terminate(); else this.activeConn.destroy(); } catch {  } this.activeConn = null; }
  }

  
  
  
  
  private parseResponse(raw: string): TerminalResult {
    let resp: Record<string, string>;
    try { resp = JSON.parse(raw); }
    catch { throw new Error(`Invalid JSON: ${raw.substring(0, 120)}`); }

    const authText = resp['AUTH_RSP_TEXT'] || '';
    const errorMsg = resp['ERROR_MSG'] || '';
    const state    = resp['STATE'] ?? '';
    
    
    const approved = !errorMsg && (authText ? /APPROV/i.test(authText) : state === '0');

    if (!approved) {
      return { approved: false, errorMessage: errorMsg || authText.trim() || 'Card declined.' };
    }

    const masked = resp['MASKED_PAN'] ?? resp['CARD_NUMBER'] ?? resp['CARD_NUM'] ?? '';
    const digits = masked.replace(/\D/g, '');
    const last4  = digits.length >= 4 ? digits.slice(-4) : undefined;

    const amt   = parseInt(resp['AMOUNT'] || '0', 10) || 0;
    const total = parseInt(resp['TOTAL_AMOUNT'] || resp['AMOUNT'] || '0', 10) || 0;
    const tipCents = Math.max(0, total - amt);

    const authCode = resp['CODE'] || (authText.match(/APPROVAL\s+(\S+)/i)?.[1]) || undefined;

    return {
      approved:      true,
      authCode,
      last4,
      cardType:      resp['ISSUER'] ?? resp['CARD_TYPE'] ?? undefined,
      tipAmount:     tipCents / 100,
      signatureData: resp['SIGNATURE_DATA'] ?? resp['SIGNATURE'] ?? undefined,
    };
  }
}
