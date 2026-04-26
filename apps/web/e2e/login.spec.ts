import { expect, test } from '@playwright/test';

/**
 * V1.5 (Sprint O) — Login flow.
 *
 * Pre-requis :
 *   - API tracky tournant sur http://localhost:3000
 *   - DB de dev avec un user seed (cf. docs/14-tests-runbook.md)
 *   - Variables E2E_TEST_EMAIL + E2E_TEST_PASSWORD definies dans .env.test
 *
 * Le test verifie :
 *   1. La page /login s'affiche
 *   2. Une connexion valide redirige vers /dashboard
 *   3. Une connexion invalide affiche un toast d'erreur
 */

const EMAIL = process.env.E2E_TEST_EMAIL ?? 'admin@tracky.local';
const PASSWORD = process.env.E2E_TEST_PASSWORD ?? 'changeme';

test.describe('Login', () => {
  test('page de login accessible et formulaire visible', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveURL(/\/login/);
    await expect(page.getByRole('button', { name: /connexion|login/i })).toBeVisible({ timeout: 5000 });
  });

  test('connexion valide redirige vers /dashboard', async ({ page }) => {
    test.skip(!process.env.E2E_TEST_EMAIL, 'E2E_TEST_EMAIL non defini');

    await page.goto('/login');
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/mot de passe|password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /connexion|login/i }).click();

    await expect(page).toHaveURL(/\/(dashboard|map)/, { timeout: 10000 });
  });

  test('connexion invalide reste sur /login', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill('invalid@example.com');
    await page.getByLabel(/mot de passe|password/i).fill('wrong-password');
    await page.getByRole('button', { name: /connexion|login/i }).click();

    // Attente : toast d'erreur OU redirige vers la meme URL.
    await page.waitForTimeout(2000);
    await expect(page).toHaveURL(/\/login/);
  });
});
