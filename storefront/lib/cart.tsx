'use client';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export interface CartLine { barcode: string; name: string; price: number; qty: number }
interface CartState {
  locationId: string | null;
  tenantId: string | null;
  lines: CartLine[];
  setStore: (tenantId: string, locationId: string) => void;
  add: (line: Omit<CartLine, 'qty'>, qty?: number) => void;
  setQty: (barcode: string, qty: number) => void;
  remove: (barcode: string) => void;
  clear: () => void;
  count: number;
  subtotal: number;
}

const Ctx = createContext<CartState | null>(null);
const KEY = 'rackd_cart_v1';

export function CartProvider({ children }: { children: ReactNode }) {
  const [locationId, setLocationId] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string | null>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  
  
  
  
  
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) { const s = JSON.parse(raw); setLocationId(s.locationId); setTenantId(s.tenantId); setLines(s.lines || []); }
    } catch {  }
    setHydrated(true);
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try { localStorage.setItem(KEY, JSON.stringify({ locationId, tenantId, lines })); } catch {  }
  }, [hydrated, locationId, tenantId, lines]);

  
  function setStore(t: string, l: string) {
    if (l !== locationId) { setLines([]); }
    setTenantId(t); setLocationId(l);
  }
  function add(line: Omit<CartLine, 'qty'>, qty = 1) {
    setLines((prev) => {
      const i = prev.findIndex((x) => x.barcode === line.barcode);
      if (i >= 0) { const c = [...prev]; c[i] = { ...c[i], qty: c[i].qty + qty }; return c; }
      return [...prev, { ...line, qty }];
    });
  }
  function setQty(barcode: string, qty: number) {
    setLines((prev) => qty <= 0 ? prev.filter((x) => x.barcode !== barcode) : prev.map((x) => x.barcode === barcode ? { ...x, qty } : x));
  }
  const remove = (barcode: string) => setLines((prev) => prev.filter((x) => x.barcode !== barcode));
  const clear = () => setLines([]);

  const count = lines.reduce((s, l) => s + l.qty, 0);
  const subtotal = lines.reduce((s, l) => s + l.price * l.qty, 0);

  return (
    <Ctx.Provider value={{ locationId, tenantId, lines, setStore, add, setQty, remove, clear, count, subtotal }}>
      {children}
    </Ctx.Provider>

  );
}

export function useCart() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useCart must be used within CartProvider');
  return c;
}
