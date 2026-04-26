import { Page } from '@playwright/test';

/**
 * V1.6 (P4) — Helper de login Playwright partage par tous les flows.
 *
 * Lit E2E_TEST_EMAIL + E2E_TEST_PASSWORD depuis l'env. Le test appelant
 * doit faire `test.skip(...)` si les vars manquent (sinon le flow plante).
 */
export async function login(page: Page, email?: string, password?: string): Promise<void> {
  const e = email ?? process.env.E2E_TEST_EMAIL ?? '';
  const p = password ?? process.env.E2E_TEST_PASSWORD ?? '';
  if (!e || !p) {
    throw new Error('E2E_TEST_EMAIL / E2E_TEST_PASSWORD manquants');
  }
  await page.goto('/login');
  await page.getByLabel(/email/i).fill(e);
  await page.getByLabel(/mot de passe|password/i).fill(p);
  await page.getByRole('button', { name: /connexion|login/i }).click();
  await page.waitForURL((url) => /\/(dashboard|map)/.test(url.pathname), { timeout: 10000 });
}
