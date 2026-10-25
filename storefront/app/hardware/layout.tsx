import type { Metadata } from 'next';
import { HardwareNav, TestModeBanner } from '@/components/hardware/shared';

export const metadata: Metadata = {
  title: 'Hardware — Rackd',
  description: 'POS stations, scanners, printers and accessories for Rackd shops.',
};

export default function HardwareLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-3">
        <p className="eyebrow text-red-400">Rackd hardware</p>
        <h1 className="font-display font-extrabold text-3xl tracking-tight">Hardware store</h1>
      </div>
      <HardwareNav />
      <TestModeBanner />
      {children}
    </div>
  );
}
