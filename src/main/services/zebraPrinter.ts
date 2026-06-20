import net from 'net';

export interface ZebraProduct {
  id: number;
  name: string;
  barcode?: string | null;
  price?: number;
  qty?: number; // how many tags to print (defaults to 1)
}

export interface ZebraPrintResult {
  success: boolean;
  printed: number;
  error?: string;
}

/**
 * Build ZPL for a 2.25" x 1.25" label (54mm x 32mm)
 * at 203 dpi = 456 x 254 dots
 *
 * Layout:
 *   Line 1: Product name (truncated)
 *   Line 2: Price
 *   Line 3: Code128 barcode + barcode text below
 */
function buildZpl(product: ZebraProduct): string {
  const name = (product.name || '').substring(0, 28).toUpperCase();
  const price = product.price != null ? `$${product.price.toFixed(2)}` : '';
  const barcodeData = product.barcode || String(product.id).padStart(8, '0');

  return [
    '^XA',                          // Start label
    '^CF0,28',                      // Default font size 28
    `^FO20,10^FD${name}^FS`,        // Product name at top
    price ? `^CF0,22^FO20,46^FD${price}^FS` : '',  // Price
    '^BY2,2,60',                    // Barcode module width=2, ratio=2, height=60
    `^FO20,80^BCN,60,Y,N,N^FD${barcodeData}^FS`, // Code128, height 60, human-readable
    '^XZ',                          // End label
  ].filter(Boolean).join('\n');
}

/**
 * Send ZPL to a Zebra printer via TCP socket.
 * Returns a promise that resolves when data is flushed.
 */
function sendZplToSocket(ip: string, port: number, zpl: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error('Zebra printer timeout (10s)'));
    }, 10000);

    client.connect(port, ip, () => {
      client.write(zpl, 'utf8', (err) => {
        clearTimeout(timeout);
        client.destroy();
        if (err) reject(err);
        else resolve();
      });
    });

    client.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

/**
 * Print barcode tags for a list of products.
 * Each product.qty determines how many copies to print (default 1).
 */
export async function printZebraTagsForProducts(
  products: ZebraProduct[],
  ip: string,
  port: number
): Promise<ZebraPrintResult> {
  let printed = 0;

  for (const product of products) {
    const copies = product.qty && product.qty > 0 ? product.qty : 1;
    const zpl = buildZpl(product);

    for (let i = 0; i < copies; i++) {
      await sendZplToSocket(ip, port, zpl);
      printed++;
    }
  }

  return { success: true, printed };
}
