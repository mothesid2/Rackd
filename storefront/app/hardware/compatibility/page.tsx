'use client';
import { useState } from 'react';
import Link from 'next/link';
import { btnPrimary, Card, CheckboxField, Notice } from '@/components/onboarding/fields';

// Requirements marked TBD are confirmed with the final hardware spec; do not treat them as promises.
const GROUPS: { title: string; items: { id: string; text: string; required?: boolean }[] }[] = [
  { title: 'Computer', items: [
    { id: 'pc_os', text: 'Windows 10 or 11 (64-bit) on the register computer (exact minimum specs TBD)', required: true },
    { id: 'pc_net', text: 'Reliable internet at the counter (wired Ethernet recommended)', required: true },
    { id: 'pc_ports', text: 'At least 3 free USB ports', required: true },
  ] },
  { title: 'Receipt printer', items: [
    { id: 'rp_escpos', text: 'Thermal printer that supports ESC/POS commands', required: true },
    { id: 'rp_conn', text: 'USB, Bluetooth or WiFi connection (confirm the model with us)' },
    { id: 'rp_80', text: '80 mm paper preferred (58 mm may work; TBD)' },
  ] },
  { title: 'Cash drawer', items: [
    { id: 'cd_rj11', text: 'Drawer opens through the receipt printer using an RJ11 cable', required: true },
    { id: 'cd_volt', text: 'Drawer trigger voltage matches your printer (12V or 24V)' },
  ] },
  { title: 'Barcode scanner', items: [
    { id: 'bs_hid', text: 'Scanner works as a keyboard (USB or Bluetooth HID mode)', required: true },
    { id: 'bs_2d', text: 'Reads both 1D and 2D codes (recommended)' },
  ] },
  { title: 'ID scanner', items: [
    { id: 'id_usb', text: 'USB driver-license scanner that outputs the card data as typed text (model support TBD)' },
  ] },
  { title: 'Payments', items: [
    { id: 'pay_term', text: 'A card terminal your processor supports. Rackd’s VP100 terminal is the supported option today.', required: true },
  ] },
];

export default function Compatibility() {
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const required = GROUPS.flatMap((g) => g.items).filter((i) => i.required);
  const missing = required.filter((i) => !checked[i.id]);
  const done = missing.length === 0;
  return (
    <div className="grid gap-4">
      <div>
        <h2 className="font-display font-extrabold text-3xl tracking-tight">Bring your own hardware</h2>
        <p className="text-smoke mt-1">Tick what you already have. Items marked required must be covered for Rackd to work well.</p>
      </div>
      <Notice tone="warn">This checklist is a guide. Model-level compatibility is confirmed by our team during your application.</Notice>
      {GROUPS.map((g) => (
        <Card key={g.title}>
          <fieldset>
            <legend className="font-display font-bold text-lg mb-1">{g.title}</legend>
            {g.items.map((i) => (
              <CheckboxField key={i.id} checked={!!checked[i.id]} onChange={(v) => setChecked((p) => ({ ...p, [i.id]: v }))}
                label={<>{i.text}{i.required && <span className="ml-2 text-xs text-ember">required</span>}</>} />
            ))}
          </fieldset>
        </Card>
      ))}
      <Card>
        <div role="status" aria-live="polite">
          {done
            ? <p className="text-green-400 font-semibold">✓ You cover every required item. You are ready to apply.</p>
            : <p className="text-amber-300 font-semibold">{missing.length} required item{missing.length === 1 ? '' : 's'} still unchecked. Rackd hardware can fill the gaps.</p>}
        </div>
        <div className="mt-3 flex flex-wrap gap-3">
          <Link href="/get-started/" className={btnPrimary}>Apply to Rackd</Link>
          <Link href="/hardware/" className="inline-flex items-center min-h-[44px] px-4 underline text-smoke">Browse Rackd hardware</Link>
        </div>
      </Card>
    </div>
  );
}
