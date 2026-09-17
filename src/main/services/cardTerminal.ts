import net from 'net';
import http from 'http';

export interface TerminalResult {
  approved: boolean;
  authCode?: string;
  last4?: string;
  cardType?: string;
  tipAmount?: number;
  signatureData?: string;
  errorMessage?: string;
}

export interface ValorLineItem {
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
}

export interface ValorPayload {
  amount: number;
  transactionId: string;
  merchantId: string;
  terminalId: string;
  lineItems: ValorLineItem[];
  taxAmount: number;
  taxRate: number;
  discountAmount: number;
}

export interface CardTerminal {
  sendPayment(payload: ValorPayload): Promise<TerminalResult>;
  cancelTransaction(): Promise<void>;
  testConnection(): Promise<boolean>;
}


class MockTerminal implements CardTerminal {
  sendPayment(_payload: ValorPayload): Promise<TerminalResult> {
    return new Promise((resolve) => {
      setTimeout(() => {
        const approved = Math.random() < 0.85;
        resolve(
          approved
            ? {
                approved: true,
                authCode: Math.random().toString(36).substring(2, 8).toUpperCase(),
                last4: String(Math.floor(1000 + Math.random() * 9000)),
                cardType: ['VISA', 'MASTERCARD', 'AMEX', 'DISCOVER'][Math.floor(Math.random() * 4)],
                tipAmount: Math.random() < 0.5 ? parseFloat((Math.random() * 5).toFixed(2)) : 0,
                signatureData: 'MOCK_SIG_' + Date.now(),
              }
            : { approved: false, errorMessage: 'Card declined' }
        );
      }, 2000);
    });
  }

  cancelTransaction(): Promise<void> {
    return Promise.resolve();
  }

  testConnection(): Promise<boolean> {
    return Promise.resolve(true);
  }
}


class PaxTerminal implements CardTerminal {
  private static refNum = 1;

  constructor(private ip: string, private port: number = 10009) {}

  cancelTransaction(): Promise<void> { return Promise.resolve(); }

  testConnection(): Promise<boolean> {
    return new Promise((resolve) => {
      const client = new net.Socket();
      const t = setTimeout(() => { client.destroy(); resolve(false); }, 5000);
      client.connect(this.port, this.ip, () => { clearTimeout(t); client.destroy(); resolve(true); });
      client.on('error', () => { clearTimeout(t); resolve(false); });
    });
  }

  sendPayment(payload: ValorPayload): Promise<TerminalResult> {
    return new Promise((resolve) => {
      const amount = payload.amount;
      const amountCents = String(Math.round(amount * 100));
      const refNum = String(PaxTerminal.refNum++).padStart(6, '0');

      
      const FS = '\x1C';
      const fields = [
        'T00',       
        '1.28',      
        '01',        
        amountCents, 
        '0',         
        '0',         
        '',          
        refNum,      
        '',          
        '',          
        refNum,      
        '',          
        '',          
        '',          
        '',          
        '',          
        '',          
      ];

      const data = fields.join(FS);
      const dataBytes = Buffer.from(data, 'ascii');

      
      const STX = 0x02;
      const ETX = 0x03;
      const lenHi = (dataBytes.length >> 8) & 0xff;
      const lenLo = dataBytes.length & 0xff;

      const frameWithoutLrc = Buffer.concat([
        Buffer.from([STX, lenHi, lenLo]),
        dataBytes,
        Buffer.from([ETX]),
      ]);

      
      let lrc = 0;
      for (const b of frameWithoutLrc) lrc ^= b;

      const frame = Buffer.concat([frameWithoutLrc, Buffer.from([lrc])]);

      const client = new net.Socket();
      const chunks: Buffer[] = [];

      const timeout = setTimeout(() => {
        client.destroy();
        resolve({ approved: false, errorMessage: 'Terminal timeout (60s)' });
      }, 60000);

      client.connect(this.port, this.ip, () => {
        client.write(frame);
      });

      client.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });

      client.on('end', () => {
        clearTimeout(timeout);
        try {
          resolve(parsePaxResponse(Buffer.concat(chunks)));
        } catch (e) {
          resolve({ approved: false, errorMessage: `Parse error: ${String(e)}` });
        }
      });

      client.on('close', () => {
        clearTimeout(timeout);
        if (chunks.length > 0) {
          try {
            resolve(parsePaxResponse(Buffer.concat(chunks)));
          } catch {
            
          }
        }
      });

      client.on('error', (err) => {
        clearTimeout(timeout);
        resolve({
          approved: false,
          errorMessage: `Connection failed: ${err.message}. Check terminal IP/port in Settings.`,
        });
      });
    });
  }
}

function parsePaxResponse(buf: Buffer): TerminalResult {
  
  
  const stxIdx = buf.indexOf(0x02);
  if (stxIdx === -1) throw new Error('No STX in response');

  const lenHi = buf[stxIdx + 1];
  const lenLo = buf[stxIdx + 2];
  const dataLen = (lenHi << 8) | lenLo;
  const dataStart = stxIdx + 3;
  const dataEnd = dataStart + dataLen;
  const data = buf.slice(dataStart, dataEnd).toString('ascii');

  const FS = '\x1C';
  const fields = data.split(FS);

  
  const resultCode = fields[2] || '';
  const approved = resultCode === '000000';

  const authCode = fields[4]?.trim() || undefined;
  const maskedPan = fields[11]?.trim() || '';
  const last4 = maskedPan.length >= 4 ? maskedPan.slice(-4) : undefined;
  const cardType = fields[10]?.trim() || undefined;
  const resultText = fields[3]?.trim() || 'Declined';

  return {
    approved,
    authCode: approved ? authCode : undefined,
    last4: approved ? last4 : undefined,
    cardType: approved ? cardType : undefined,
    errorMessage: !approved ? resultText : undefined,
  };
}


class DejavooTerminal implements CardTerminal {
  private static reqId = 1;

  constructor(private ip: string, private port: number = 8080) {}

  cancelTransaction(): Promise<void> { return Promise.resolve(); }

  testConnection(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.request(
        { hostname: this.ip, port: this.port, path: '/', method: 'GET', timeout: 5000 },
        () => resolve(true)
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
      req.end();
    });
  }

  sendPayment(payload: ValorPayload): Promise<TerminalResult> {
    const amountCents = String(Math.round(payload.amount * 100));
    const reqId = String(DejavooTerminal.reqId++);

    const xmlBody = [
      '<?xml version="1.0" encoding="utf-8"?>',
      '<ZLink_Packet>',
      `  <Request_ID>${reqId}</Request_ID>`,
      '  <TPDUHeader>600000000000</TPDUHeader>',
      '  <FuncCode>1000</FuncCode>',       
      `  <Amount>${amountCents}</Amount>`,
      '  <TipAmount>0</TipAmount>',
      '  <CashBackAmount>0</CashBackAmount>',
      `  <InvoiceNum>${reqId}</InvoiceNum>`,
      `  <ECRRefNum>${reqId}</ECRRefNum>`,
      '  <PaymentType>CREDIT</PaymentType>',
      '</ZLink_Packet>',
    ].join('\n');

    return new Promise((resolve) => {
      const options: http.RequestOptions = {
        hostname: this.ip,
        port: this.port,
        path: '/api/v2/Pay',
        method: 'POST',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(xmlBody),
        },
        timeout: 60000,
      };

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve(parseDejavooResponse(body));
          } catch (e) {
            resolve({ approved: false, errorMessage: `Parse error: ${String(e)}` });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ approved: false, errorMessage: 'Terminal timeout (60s)' });
      });

      req.on('error', (err) => {
        resolve({
          approved: false,
          errorMessage: `Connection failed: ${err.message}. Check terminal IP/port in Settings.`,
        });
      });

      req.write(xmlBody);
      req.end();
    });
  }
}

function parseDejavooResponse(xml: string): TerminalResult {
  const get = (tag: string): string => {
    const m = xml.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`, 'i'));
    return m?.[1]?.trim() ?? '';
  };

  
  const respCode = get('RespCode');
  const approved = respCode === '00' || respCode === '000';

  const authCode = get('AuthCode') || undefined;
  const maskedPan = get('AcctNum');
  const last4 = maskedPan.length >= 4 ? maskedPan.slice(-4) : undefined;
  const cardType = get('CardType') || undefined;
  const respMsg = get('RespMsg') || 'Declined';

  return {
    approved,
    authCode: approved ? authCode : undefined,
    last4: approved ? last4 : undefined,
    cardType: approved ? cardType : undefined,
    errorMessage: !approved ? respMsg : undefined,
  };
}


export function getTerminal(
  type: string,
  ip?: string,
  port?: number,
  mid?: string,
  tid?: string,
  channelId?: string,
  epi?: string,
  environment?: string
): CardTerminal {
  switch (type) {
    case 'valor_vp100': {
      
      
      const { ValorTerminal } = require('./valorTerminal') as typeof import('./valorTerminal');
      return new ValorTerminal(ip || '', port || 5000);
    }
    case 'pax':
      return new PaxTerminal(ip || '192.168.1.100', port || 10009);
    case 'dejavoo':
      return new DejavooTerminal(ip || '192.168.1.101', port || 8080);
    default:
      return new MockTerminal();
  }
}
