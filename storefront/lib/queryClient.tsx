'use client';
import { useState, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

/**
 * One QueryClient for the whole storefront. Defaults here are intentionally
 * conservative for a shop that must never oversell:
 *
 * - staleTime 20s: the store page already polled every 25s for
 *   near-real-time stock (see the old setInterval in app/store/page.tsx,
 *   removed in favor of this) — keep roughly that cadence rather than
 *   inventing a longer one, so this cache change doesn't make stock look
 *   staler than it already did.
 * - The client cache is a UX layer only. The real oversell guard lives
 *   server-side in the storefront-checkout function (reserve_online_order),
 *   which re-checks stock atomically at reservation time regardless of what
 *   any client has cached — this file does not change that.
 * - refetchOnWindowFocus stays on: a customer coming back to a backgrounded
 *   tab should see current stock before tapping Add.
 */
export function AppQueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 20_000,
            refetchOnWindowFocus: true,
            retry: 1,
          },
        },
      })
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
