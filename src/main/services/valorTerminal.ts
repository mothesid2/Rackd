import net from 'net';
import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import type { CardTerminal, TerminalResult, ValorPayload } from './cardTerminal';

// ─────────────────────────────────────────────────────────────────────────────
//  VALOR VP100 — Semi-Integration over TCP (POS is the SERVER)
//
//  Per the Valor engineer's reference script: the POS runs a TCP server; the
//  VP100 connects TO the POS, and the POS pushes the transaction JSON on the
//  open socket. The terminal processes the card and replies with the result.
//
//  The VP100's Valor Connect target (in the Valor Portal / EPI) must point at
//  THIS PC's IP and port. Listen port defaults to 5000.
// ─────────────────────────────────────────────────────────────────────────────

export class ValorTerminal implements CardTerminal {
  private server: net.Server | null = null;
  private connectedSocket: net.Socket | null = null;
  private pendingTransaction: {
    body:          string;
    resolve:       (result: TerminalResult) => void;
    timeoutHandle: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(private listenPort: number) {
    this.startServer();
  }

  private log(msg: string): void {
    try {
      const logPath = path.join(app.getPath('userData'), 'terminal_log.txt');
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`, 'utf8');
    } catch { /* non-fatal */ }
  }

  private startServer(): void {
    this.server = net.createServer((socket) => {
      this.log(`Terminal connected from ${socket.remoteAddress}`);

      if (this.connectedSocket && !this.connectedSocket.destroyed) {
        this.connectedSocket.destroy();
      }
      this.connectedSocket = socket;

      const chunks: Buffer[] = [];

      socket.on('data', (chunk: Buffer) => {
        this.log(`DATA (${chunk.length} bytes): ${chunk.toString('utf8').substring(0, 400)}`);
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

      // If a sale is already waiting, push it the moment the terminal connects
      if (this.pendingTransaction) {
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

  sendPayment(payload: ValorPayload): Promise<TerminalResult> {
    // Minimal request matching the Valor engineer's reference (AMOUNT = cents).
    const body = JSON.stringify({
      TRAN_MODE: '1',
      TRAN_CODE: '1',
      AMOUNT: String(Math.round(payload.amount * 100)),
    });

    this.log(`SEND txn=${payload.transactionId} | ${body}`);

    return new Promise((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingTransaction = null;
        this.log('TIMEOUT 90s');
        resolve({
          approved: false,
          errorMessage: 'Terminal timed out. Make sure the VP100 is pointed at this PC and shows "Server is Waiting for Transaction".',
        });
      }, 90_000);

      this.pendingTransaction = { body, resolve, timeoutHandle };

      if (this.connectedSocket && !this.connectedSocket.destroyed) {
        this.log('Terminal already connected — sending immediately');
        this.connectedSocket.write(body + '\n');
      } else {
        this.log('No terminal connected yet — will send when it connects');
      }
    });
  }

  cancelTransaction(): Promise<void> {
    if (this.pendingTransaction) {
      const { resolve, timeoutHandle } = this.pendingTransaction;
      this.pendingTransaction = null;
      clearTimeout(timeoutHandle);
      resolve({ approved: false, errorMessage: 'Transaction cancelled by cashier.' });
    }
    this.log('CANCEL requested by cashier');
    return Promise.resolve();
  }

  testConnection(): Promise<boolean> {
    const running   = this.server?.listening ?? false;
    const connected = !!(this.connectedSocket && !this.connectedSocket.destroyed);
    this.log(`TEST: server_running=${running} terminal_connected=${connected}`);
    return Promise.resolve(running);
  }

  isTerminalConnected(): boolean {
    return !!(this.connectedSocket && !this.connectedSocket.destroyed);
  }

  destroy(): void {
    if (this.connectedSocket) { try { this.connectedSocket.destroy(); } catch { /* ignore */ } this.connectedSocket = null; }
    if (this.server)          { try { this.server.close();           } catch { /* ignore */ } this.server = null; }
    this.log('ValorTerminal server destroyed');
  }

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
