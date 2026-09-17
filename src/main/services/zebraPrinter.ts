import net from 'net';

export interface ZebraProduct {
  id: number;
  name: string;
  barcode?: string | null;
  price?: number;
  qty?: number; 
}

export interface ZebraPrintResult {
  success: boolean;
  printed: number;
  error?: string;
}


function buildZpl(product: ZebraProduct): string {
  const name = (product.name || '').substring(0, 28).toUpperCase();
  const price = product.price != null ? `$${product.price.toFixed(2)}` : '';
  const barcodeData = product.barcode || String(product.id).padStart(8, '0');

  return [
    '^XA',                          
    '^CF0,28',                      
    `^FO20,10^FD${name}^FS`,        
    price ? `^CF0,22^FO20,46^FD${price}^FS` : '',  
    '^BY2,2,60',                    
    `^FO20,80^BCN,60,Y,N,N^FD${barcodeData}^FS`, 
    '^XZ',                          
  ].filter(Boolean).join('\n');
}


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
