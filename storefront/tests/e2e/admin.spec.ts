import { expect, test } from '@playwright/test';
import { expectNoSeriousA11yIssues, signInAsAdmin, stubTurnstile } from './helpers';

test.describe('signed out', () => {
  test('shows only the sign-in form, never data', async ({ page }) => {
    await page.goto('/admin/');
    await expect(page.getByRole('heading', { name: 'Rackd admin' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email me a sign-in code' })).toBeVisible();
    await expect(page.getByText('Acme Vapes LLC')).toHaveCount(0);
    await expect(page.locator('meta[name=robots]')).toHaveAttribute('content', /noindex/);
    await expectNoSeriousA11yIssues(page, '/admin sign-in');
  });
});

test.describe('signed in as a platform admin', () => {
  test.beforeEach(async ({ context, page }) => {
    await stubTurnstile(page);
    await signInAsAdmin(context);
  });

  test('applications queue lists applications with status badges', async ({ page }) => {
    await page.goto('/admin/');
    await expect(page.getByRole('heading', { name: 'Applications' })).toBeVisible();
    // the list renders as a table on desktop and cards on phones; only one is visible
    await expect(page.getByText('Acme Vapes LLC').locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('Vapor Hut Inc').locator('visible=true').first()).toBeVisible();
    await expect(page.getByText('submitted', { exact: true }).locator('visible=true').first()).toBeVisible();
    await expectNoSeriousA11yIssues(page, '/admin queue');
  });

  test('application detail: masked EIN with a logged reveal, permit flag, and a guarded approve dialog', async ({ page }) => {
    await page.goto('/admin/application/?id=5b7e2f0a-1111-4222-8333-444455556666');
    await expect(page.getByRole('heading', { name: 'Acme Vapes LLC' })).toBeVisible();
    await expect(page.getByText('••-•••6789')).toBeVisible();
    await expect(page.getByText(/Expires within 30 days/)).toBeVisible();                 // red flag for the permit 12 days out
    await page.getByRole('button', { name: /Reveal \(logged\)/ }).click();
    await expect(page.getByText('12-3456789')).toBeVisible();

    await page.getByRole('button', { name: 'Approve…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText('Approve and provision?')).toBeVisible();
    await expect(dialog.getByText(/second click returns the same business/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Approve and provision' }).click();
    await expect(dialog.getByText('RACKD-ABCD-EFGH-JKLM')).toBeVisible();
    await expect(dialog.getByText(/owner was emailed/)).toBeVisible();
    await expectNoSeriousA11yIssues(page, '/admin application');
  });

  test('requesting info needs a real message', async ({ page }) => {
    await page.goto('/admin/application/?id=5b7e2f0a-1111-4222-8333-444455556666');
    await page.getByRole('button', { name: 'Request info' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Send request' })).toBeDisabled();
    await dialog.getByLabel('What do you need from them?').fill('Please upload a clearer sales tax permit.');
    await expect(dialog.getByRole('button', { name: 'Send request' })).toBeEnabled();
  });

  test('hardware orders: ready-to-ship list and a shipping form that requires tracking', async ({ page }) => {
    await page.goto('/admin/orders/');
    await expect(page.getByRole('link', { name: 'HW-1001' })).toBeVisible();
    await page.getByRole('link', { name: 'HW-1001' }).click();
    await expect(page.getByRole('heading', { name: 'HW-1001' })).toBeVisible();
    await page.getByRole('button', { name: 'Mark shipped…' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Mark shipped' })).toBeDisabled();
    await dialog.getByLabel(/^Tracking number/).fill('1Z999AA10123456784');
    await expect(dialog.getByRole('button', { name: 'Mark shipped' })).toBeEnabled();
  });

  test('pricing and config editor loads every section; audit log is read-only', async ({ page }) => {
    await page.goto('/admin/config/');
    await expect(page.getByRole('heading', { name: 'Pricing and configuration' })).toBeVisible();
    await expect(page.getByText('Plans, add-ons and online fee')).toBeVisible();
    await expect(page.getByText('Hardware tax and shipping')).toBeVisible();
    await expect(page.getByText('Hardware products')).toBeVisible();
    await expectNoSeriousA11yIssues(page, '/admin config');
    await page.goto('/admin/audit/');
    await expect(page.getByText('ein.reveal')).toBeVisible();
    await expect(page.getByText(/Append-only/)).toBeVisible();
    await expect(page.getByRole('button', { name: /delete|edit/i })).toHaveCount(0);
  });
});
