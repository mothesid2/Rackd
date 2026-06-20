import net from 'net';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { CardTerminal, TerminalResult, ValorPayload } from './cardTerminal';

// ─────────────────────────────────────────────────────────────────────────────
//  VALOR VP100 — Semi-Integration TCP Server
//
//  Architecture: POS runs a TCP server. Terminal connects TO the POS.
//  On connect the POS sends the pending transaction JSON (\n terminated).
//  Terminal responds with the result JSON.
//
//  Setup (one-time, in Valor Portal):
//    Device Management → EPI → Edit Parameter
//    → Terminal & Transaction → Valor Connect
//    → Enable Connection Type = TCP
//    → IP = <this PC's IP>  Port = 5000
//    → Save, then do a Param Download on the terminal
//
//  The terminal will then show "Server is Waiting for Transaction" when
//  it connects.
// ─────────────────────────────────────────────────────────────────────────────

export class ValorTerminal implements CardTerminal {
  private server: net.Server | null = null;
  private connectedSocket: net.Socket | null = null;
  private pendingTransaction: {
    body:          string;
    resolve:       (result: TerminalResult) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
  } | null = null;
  private cancelRequested = false;

  constructor(private listenPort: number) {
    this.startServer();
  }

  // ── Logging ──────────────────────────────────────────────────────────────

  private log(msg: string): void {
    try {
      const logPath = path.join(app.getPath('userData'), 'terminal_log.txt');
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch { /* non-fatal */ }
  }

  // ── TCP server ────────────────────────────────────────────────────────────

  private startServer(): void {
    this.server = net.createServer((socket) => {
      this.log(`Terminal connected from ${socket.remoteAddress}`);

      // Replace any stale socket
      if (this.connectedSocket && !this.connectedSocket.destroyed) {
        this.connectedSocket.destroy();
      }
      this.connectedSocket = socket;

      const chunks: Buffer[] = [];

      socket.on('data', (chunk: Buffer) => {
        this.log(`DATA (${chunk.length} bytes): ${chunk.toString('utf8').substring(0, 300)}`);
        chunks.push(chunk);

        const raw = Buffer.concat(chunks).toString('utf8').trim();
        try {
          JSON.parse(raw); // throws if incomplete
          if (this.pendingTransaction) {
            const { resolve, timeoutHandle } = this.pendingTransaction;
            this.pendingTransaction = null;
            clearTimeout(timeoutHandle);
            this.log(`RECV: ${raw}`);
            try { resolve(this.parseResponse(raw)); }
            catch (e) { resolve({ approved: false, errorMessage: `Parse error: ${String(e)}` }); }
            chunks.length = 0;
          }
        } catch { /* incomplete JSON — wait for more data */ }
      });

      socket.on('close', () => {
        this.log('Terminal disconnected');
        if (this.connectedSocket === socket) this.connectedSocket = null;
      });

      socket.on('error', (err: Error) => {
        this.log(`Socket error: ${err.message}`);
      });

      // If a transaction is already waiting, send it immediately
      if (this.pendingTransaction && !this.cancelRequested) {
        this.log('Terminal connected — sending pending transaction');
        socket.write(this.pendingTransaction.body + '\n');
      }
    });

    this.server.on('error', (err: NodeJS.ErrnoException) => {
      this.log(`Server error: ${err.code === 'EADDRINUSE'
        ? `Port ${this.listenPort} already in use — restart the app`
        : err.message}`);
    });

    this.server.listen(this.listenPort, '0.0.0.0', () => {
      this.log(`TCP server listening on 0.0.0.0:${this.listenPort} — waiting for terminal`);
    });
  }

  // ── sendPayment ───────────────────────────────────────────────────────────

  sendPayment(payload: ValorPayload): Promise<TerminalResult> {
    this.cancelRequested = false;

    const body = JSON.stringify({
      TRAN_MODE: '1',
      TRAN_CODE: '1',
      AMOUNT: payload.amount.toFixed(2),
      TAX_AMOUNT: payload.taxAmount.toFixed(2),
      ...(payload.discountAmount > 0 && { DISCOUNT_AMOUNT: payload.discountAmount.toFixed(2) }),
      TIP_ENTRY: '1',
      SIGNATURE: '1',
      PAPER_RECEIPT: '1',
      MOBILE_ENTRY: '0',
      ITEM_DESCRIPTION: payload.lineItems.map(item => ({
        ITEM_NAME: item.name.substring(0, 40),
        ITEM_QTY: String(item.qty),
        ITEM_PRICE: item.unitPrice.toFixed(2),
        ITEM_TOTAL: item.total.toFixed(2),
      })),
    });

    this.log(`SEND txn=${payload.transactionId} | ${body}`);

    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingTransaction = null;
        this.log('TIMEOUT 90s');
        resolve({
          approved: false,
          errorMessage: 'Terminal timed out. Make sure the terminal shows "Server is Waiting for Transaction".',
        });
      }, 90_000);

      this.pendingTransaction = { body, resolve, timeoutHandle };

      if (this.connectedSocket && !this.connectedSocket.destroyed) {
        this.log('Terminal already connected — sending immediately');
        this.connectedSocket.write(body + '\n');
      } else {
        this.log('No terminal connected — will send when terminal connects');
      }
    });
  }

  // ── cancelTransaction ────────────────────────────────────────────────────

  cancelTransaction(): Promise<void> {
    this.cancelRequested = true;
    if (this.pendingTransaction) {
      const { resolve, timeoutHandle } = this.pendingTransaction;
      this.pendingTransaction = null;
      clearTimeout(timeoutHandle);
      resolve({ approved: false, errorMessage: 'Transaction cancelled by cashier.' });
    }
    this.log('CANCEL requested by cashier');
    return Promise.resolve();
  }

  // ── testConnection ────────────────────────────────────────────────────────

  testConnection(): Promise<boolean> {
    const running   = this.server?.listening ?? false;
    const connected = !!(this.connectedSocket && !this.connectedSocket.destroyed);
    this.log(`TEST: server_running=${running} terminal_connected=${connected}`);
    return Promise.resolve(running);
  }

  isTerminalConnected(): boolean {
    return !!(this.connectedSocket && !this.connectedSocket.destroyed);
  }

  // ── destroy ───────────────────────────────────────────────────────────────

  destroy(): void {
    if (this.connectedSocket) { try { this.connectedSocket.destroy(); } catch { /* ignore */ } this.connectedSocket = null; }
    if (this.server)          { try { this.server.close();           } catch { /* ignore */ } this.server = null; }
    this.log('ValorTerminal server destroyed');
  }

  // ── parseResponse ─────────────────────────────────────────────────────────

  private parseResponse(raw: string): TerminalResult {
    let resp: Record<string, string>;
    try { resp = JSON.parse(raw); }
    catch { throw new Error(`Invalid JSON: ${raw.substring(0, 120)}`); }

    const result   = (resp['TRAN_RSLT'] ?? '').toUpperCase();
    const approved = result === 'APPROVAL' || result === 'APPROVED';

    if (!approved) {
      return {
        approved:     false,
        errorMessage: resp['TRAN_DESC'] || resp['ERROR_MSG'] || 'Card declined.',
      };
    }

    const rawPan    = resp['CARD_NUMBER'] ?? resp['CARD_NUM'] ?? '';
    const digits    = rawPan.replace(/\D/g, '');
    const last4     = digits.length >= 4 ? digits.slice(-4) : (rawPan.slice(-4) || undefined);
    const tipRaw    = resp['TIP_AMOUNT']  ?? resp['TIP'] ?? '';
    const tipAmount = tipRaw ? parseFloat(tipRaw) : 0;

    return {
      approved:      true,
      authCode:      resp['AUTH_CODE']      ?? undefined,
      last4:         last4 || undefined,
      cardType:      resp['CARD_TYPE']      ?? undefined,
      tipAmount:     isNaN(tipAmount) ? 0 : tipAmount,
      signatureData: resp['SIGNATURE_DATA'] ?? resp['SIGNATURE'] ?? undefined,
    };
  }
}
