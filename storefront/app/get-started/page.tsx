import type { Metadata } from 'next';
import Wizard from '@/components/onboarding/Wizard';

export const metadata: Metadata = {
  title: 'Get started — Rackd',
  description: 'Apply to put your shop on Rackd: POS, online storefront and reporting.',
};

export default function GetStartedPage() {
  return <Wizard />;
}
