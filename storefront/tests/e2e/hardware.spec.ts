import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yIssues, stubTurnstile } from './helpers';

test.beforeEach(async ({ page }) => {
  await stubTurnstile(page);
  await page.goto('/hardware/');
  await page.evaluate(() => localStorage.removeItem('rackd_hw_cart_v1'));
});

test('catalog shows the test-mode and placeholder notices and is accessible', async ({ page }) => {
  await page.goto('/hardware/');
  await expect(page.getByRole('heading', { name: 'Hardware store' })).toBeVisible();
  await expect(page.getByText(/Test mode\. Payments on this page are not real/)).toBeVisible();
  await expect(page.getByText('Placeholder catalog.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Full POS bundle' })).toBeVisible();
  await expectNoSeriousA11yIssues(page, '/hardware');
});

test('stock and limits: out-of-stock items cannot be added', async ({ page }) => {
  await page.goto('/hardware/');
  await expect(page.getByRole('button', { name: 'Out of stock: Cash drawer + RJ11 cable' })).toBeDisabled();
});

test('bundle builder swaps an item, the discount follows, and the cart persists through a reload', async ({ page }) => {
  await page.goto('/hardware/build/?bundle=full-pos-bundle');
  await expect(page.getByRole('heading', { name: /Customize: Full POS bundle/ })).toBeVisible();
  await expect(page.getByText('Bundle discount')).toBeVisible();
  await page.getByLabel(/Swap Full POS Station/).selectOption({ label: 'Counter Lite — $799.00' });   // swap_group "station"
  await expect(page.getByText('Bundle discount')).toBeVisible();                                         // still qualifies
  await page.getByRole('button', { name: 'Add to cart' }).click();
  await expect(page).toHaveURL(/\/hardware\/cart\/$/);
  await expect(page.getByText('Counter Lite')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Counter Lite')).toBeVisible();                                            // persisted
  await page.getByRole('button', { name: 'Remove Payment terminal (VP100)' }).click();
  await expect(page.getByText(/discount no longer applies/)).toBeVisible();                              // removing a required item drops it
  await expectNoSeriousA11yIssues(page, '/hardware/cart');
});

test('order end to end in test mode: checkout, pending order, pay, confirmation', async ({ page }) => {
  await page.goto('/hardware/');
  await page.getByRole('button', { name: 'Add bundle to cart: Full POS bundle' }).click();
  await page.goto('/hardware/cart/');
  await expect(page.getByText('$1,582.46')).toBeVisible();        // 1548 items - 100 discount + 15 shipping + 8.25% tax on 1448
  await page.getByRole('link', { name: 'Checkout' }).click();

  await page.getByLabel(/^Email/).fill('buyer@test.dev');
  await page.getByLabel(/^Full name/).fill('Pat Shopkeeper');
  await page.getByLabel(/^Street address/).fill('1 Main St');
  await page.getByLabel(/^City/).fill('Austin');
  await page.getByLabel(/^ZIP/).fill('78701');
  await expectNoSeriousA11yIssues(page, '/hardware/checkout');
  await page.getByRole('button', { name: 'Continue to payment' }).click();

  await expect(page).toHaveURL(/\/hardware\/order\/[0-9a-f-]{36}#t=[0-9a-f]{64}$/);   // token lives in the fragment, never sent to a server
  await expect(page.getByRole('heading', { name: 'Awaiting payment' })).toBeVisible();
  await expect(page.getByText('Test order.')).toBeVisible();
  await expect(page.getByText(/4242 4242 4242 4242/)).toBeVisible();

  await page.getByRole('button', { name: /^Pay \$/ }).click();
  await expect(page.getByRole('heading', { name: 'Confirming your payment…' })).toBeVisible();   // webhook has not landed yet
  await expect(page.getByRole('heading', { name: 'Payment received' })).toBeVisible({ timeout: 20_000 });

  // the order page is useless without its private code
  const url = new URL(page.url());
  await page.goto(url.pathname);
  await expect(page.getByRole('heading', { name: 'We could not find that order' })).toBeVisible();
});

test('bring-your-own checklist reports what is still missing', async ({ page }) => {
  await page.goto('/hardware/compatibility/');
  await expect(page.getByText(/required items still unchecked/)).toBeVisible();
  for (const box of await page.getByRole('checkbox').all()) await box.check();
  await expect(page.getByText(/You cover every required item/)).toBeVisible();
  await expectNoSeriousA11yIssues(page, '/hardware/compatibility');
});
