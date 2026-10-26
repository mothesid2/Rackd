import type { BrowserContext, Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { expect } from '@playwright/test';

// Cloudflare's widget needs the internet; tests replace it with a stub that "passes" immediately.
const TURNSTILE_STUB = `window.turnstile = {
  render: function (el, o) { setTimeout(function () { o.callback('stub-token'); }, 30); return 'w1'; },
  reset: function () {}, remove: function () {}
};`;

export async function stubTurnstile(ctx: BrowserContext | Page) {
  await ctx.route('https://challenges.cloudflare.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: TURNSTILE_STUB }));
}

/** A fake Supabase session: enough for the admin shell, whose real gate is the (mocked) admin_whoami call. */
export async function signInAsAdmin(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const exp = Math.floor(Date.now() / 1000) + 86400;
    const jwt = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'aaaaaaaa-1111-1111-1111-111111111111', role: 'authenticated', aud: 'authenticated', exp })}.sig`;
    localStorage.setItem('sb-localhost-auth-token', JSON.stringify({
      access_token: jwt, refresh_token: 'r', expires_at: exp, expires_in: 86400, token_type: 'bearer',
      user: { id: 'aaaaaaaa-1111-1111-1111-111111111111', aud: 'authenticated', role: 'authenticated', email: 'admin@r4ckd.net', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
    }));
  });
}

export async function resetMock(page: Page) {
  await page.request.post('/api/onboarding/reset', { data: {} });
}

/** WCAG 2 A/AA scan. Fails on serious or critical findings and prints what to fix. */
export async function expectNoSeriousA11yIssues(page: Page, label: string) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const bad = r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const summary = bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
  expect(summary, `${label}: accessibility violations`).toEqual([]);
}

/** A tiny but real PDF (starts with %PDF-) for upload fields. */
export const PDF = { name: 'permit.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF') };
export const JPG = { name: 'id.jpg', mimeType: 'image/jpeg', buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]) };
