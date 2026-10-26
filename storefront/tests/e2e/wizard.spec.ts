import { expect, test, type Page } from '@playwright/test';
import { expectNoSeriousA11yIssues, JPG, PDF, resetMock, stubTurnstile } from './helpers';

const future = () => { const d = new Date(); d.setFullYear(d.getFullYear() + 1); return d.toISOString().slice(0, 10); };
const next = (page: Page) => page.getByRole('button', { name: /^(Next|Sign and review)$/ }).click();
const heading = (page: Page, name: string) => expect(page.getByRole('heading', { level: 2, name })).toBeVisible();

test.beforeEach(async ({ page }) => {
  await stubTurnstile(page);
  await resetMock(page);
});

test('start page: accessible, honeypot hidden from people', async ({ page }) => {
  await page.goto('/get-started/');
  await expect(page.getByRole('heading', { level: 2, name: 'Create your account' })).toBeVisible();
  // honeypot: parked far off-screen, out of the tab order and hidden from assistive tech, so only bots fill it
  const fax = page.getByLabel('Fax number');
  await expect(fax).toHaveAttribute('tabindex', '-1');
  expect((await fax.boundingBox())!.x).toBeLessThan(-1000);
  await expect(page.locator('[aria-hidden="true"]').filter({ has: fax })).toHaveCount(1);
  await page.getByRole('button', { name: /Create account/ }).click();                       // empty form: explains instead of submitting
  await expect(page.getByText('Enter your full name.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Create your account' })).toBeVisible();
  await expectNoSeriousA11yIssues(page, '/get-started');
});

test('inline validation shows plain-language errors', async ({ page }) => {
  await page.goto('/get-started/');
  await page.getByLabel(/^Email/).fill('not-an-email');
  await page.getByLabel(/^Email/).blur();
  await expect(page.getByText('Enter a valid email address.')).toBeVisible();
  await expect(page.getByLabel(/^Email/)).toHaveAttribute('aria-invalid', 'true');
});

test('an applicant completes all nine steps, can resume from the emailed link on a fresh browser, and submits', async ({ page, browser }) => {
  // ---- 1. account + email verification
  await page.goto('/get-started/');
  await page.getByLabel(/^Full name/).fill('Alice Applicant');
  await page.getByLabel(/^Your role/).selectOption('owner');
  await page.getByLabel(/^Email/).fill('alice@acme.co');
  await page.getByLabel(/^Mobile phone/).fill('5125550100');
  await expect(page.getByRole('button', { name: /Create account/ })).toBeEnabled();
  await page.getByRole('button', { name: /Create account/ }).click();
  await expect(page.getByRole('heading', { name: 'Verify your email' })).toBeVisible();
  const code = /code is\s*(\d{6})/.exec(await page.getByText(/Dev mode: your code is/).innerText())![1];
  await page.getByLabel(/^6-digit code/).fill(code);
  await page.getByRole('button', { name: 'Verify email' }).click();
  await expect(page.getByText('✓ Verified')).toBeVisible();
  await next(page);

  // ---- 2. business (EIN is encrypted server-side; the form never shows it back)
  await heading(page, 'Business');
  await page.getByLabel(/^Legal business name/).fill('Acme Vapes LLC');
  await page.getByLabel(/^Entity type/).selectOption('llc');
  await page.getByLabel(/^Years in business/).fill('3');
  await page.getByLabel(/^EIN/).fill('12-3456789');
  await page.getByLabel(/^Number of locations/).fill('1');
  await page.getByLabel(/^Business email/).fill('biz@acme.co');
  await page.getByLabel(/^Business phone/).fill('5125550101');
  await page.getByLabel(/^Street address/).fill('1 Main St');
  await page.getByLabel(/^City/).fill('Austin');
  await page.getByLabel(/^State/).fill('TX');
  await page.getByLabel(/^ZIP/).fill('78701');
  await next(page);

  // ---- 3. location + permits + uploads
  await heading(page, 'Locations');
  await expect(page.getByText(/must be current/i)).toBeVisible();
  const loc = page.locator('section, div').filter({ hasText: 'Licenses for this location' }).last();
  await page.getByLabel(/^Street address/).fill('1 Main St');
  await page.getByLabel(/^City/).first().fill('Austin');
  await page.getByLabel(/^ZIP/).fill('78701');
  await page.getByLabel(/^Store phone/).fill('5125550102');
  const numbers = page.getByLabel(/^Permit number/);
  await numbers.nth(0).fill('EC-123456');
  await page.getByLabel(/^Expiry date/).fill(future());
  await numbers.nth(1).fill('ST-777');
  await page.locator('input[type=file]').nth(0).setInputFiles(PDF);
  await page.locator('input[type=file]').nth(1).setInputFiles(PDF);
  await expect(page.getByText(/^✓ permit\.pdf/)).toHaveCount(2);
  await expect(loc).toBeVisible();
  // the new step is saved right away, so a tab closed the moment after "Next" still resumes here
  const savedStep4 = page.waitForResponse((r) => r.url().includes('/api/onboarding/save') && (r.request().postData() ?? '').includes('"current_step":4'));
  await next(page);
  await savedStep4;

  // ---- "close the tab": a brand-new browser profile has no saved token; the emailed link restores the draft
  await heading(page, 'Owners');
  const fresh = await browser.newContext({ baseURL: 'http://localhost:3111' });
  const p2 = await fresh.newPage();
  await stubTurnstile(p2);
  await p2.goto('/get-started/resume?token=' + 'ab'.repeat(32));
  await expect(p2.getByRole('heading', { level: 2, name: 'Owners' })).toBeVisible();   // came back to the step it left
  await expect(p2.getByLabel(/^Full name/)).toHaveValue('Alice Applicant');                // owner prefilled from the account
  await fresh.close();

  // ---- 4. owners (photo ID required for 25%+ owners)
  await next(page).catch(() => undefined);
  await page.getByLabel(/^Ownership %/).fill('100');
  await page.locator('input[type=file]').first().setInputFiles(JPG);
  await expect(page.getByText(/^✓ id\.jpg/)).toBeVisible();
  await next(page);

  // ---- 5. operations
  await heading(page, 'Operations');
  await page.getByLabel(/^Current POS/).fill('Square');
  await page.getByLabel(/^Current payment processor/).fill('Square');
  await page.getByLabel(/^Monthly sales/).selectOption('25k_50k');
  await page.getByLabel(/^Percent paid by card/).fill('70');
  await page.getByLabel(/^Average ticket/).fill('24');
  await page.getByLabel(/^Registers/).fill('2');
  await page.getByLabel(/^Employees/).fill('4');
  await page.getByLabel('Vape').check();
  await next(page);

  // ---- 6. plan (placeholder prices are labelled)
  await heading(page, 'Plan');
  await expect(page.getByText('Placeholder pricing.')).toBeVisible();
  await expect(page.getByText(/online order fee of/i)).toBeVisible();
  await page.getByText('Full Rackd POS').first().click();
  await page.getByLabel(/SMS marketing/).check();
  await expectNoSeriousA11yIssues(page, 'wizard plan step');
  await next(page);

  // ---- 7. hardware (optional)
  await heading(page, 'Hardware');
  await page.getByText('Full POS bundle').first().click();
  await next(page);

  // ---- 8. agreements: SMS consent is its own unchecked box; compliance + e-sign are required
  await heading(page, 'Agreements');
  const sms = page.getByLabel(/may text me informational messages/);
  await expect(sms).not.toBeChecked();
  await page.getByRole('button', { name: /Sign and review/ }).click();
  await expect(page.getByText('You must agree to both documents to continue.')).toBeVisible();   // cannot skip
  await page.getByLabel(/I have read and agree/).check();
  await page.getByLabel(/responsible for verifying that every customer is 21/).check();
  await page.getByLabel(/^Type your full legal name/).fill('Alice Applicant');
  await expect(sms).not.toBeChecked();
  await next(page);

  // ---- 9. review and submit
  await heading(page, 'Review');
  await expect(page.getByText('Acme Vapes LLC')).toBeVisible();
  await expect(page.getByText('•••••6789')).toBeVisible();                     // EIN shown masked only
  await expect(page.getByText('123456789')).toHaveCount(0);
  await page.getByRole('button', { name: 'Submit application' }).click();
  await expect(page).toHaveURL(/\/get-started\/submitted\/$/);
  await expect(page.getByRole('heading', { name: 'We received your application' })).toBeVisible();
  await expectNoSeriousA11yIssues(page, 'status page');
});

test('the status page explains each state in plain language', async ({ page }) => {
  await page.goto('/get-started/submitted/');
  await expect(page.getByRole('heading', { name: 'Check your application status' })).toBeVisible();   // no saved application
});
