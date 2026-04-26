import { expect, test } from '@playwright/test';

/**
 * V1.5 (Sprint O) — Wizard onboarding (Sprint J).
 *
 * Verifie que le wizard apparait au premier login d'un user dont
 * `User.onboardingCompletedAt = null`, et permet de naviguer step par step
 * jusqu'a la fin.
 *
 * Pre-requis :
 *   - User seed avec onboardingCompletedAt = null avant chaque run.
 */

const EMAIL = process.env.E2E_NEW_USER_EMAIL ?? '';
const PASSWORD = process.env.E2E_NEW_USER_PASSWORD ?? '';

test.describe('Onboarding wizard', () => {
  test.skip(!EMAIL, 'E2E_NEW_USER_EMAIL non defini — skip pour eviter de polluer un compte existant');

  test('wizard apparait au premier login + navigation 5 steps', async ({ page }) => {
    await page.goto('/login');
    await page.getByLabel(/email/i).fill(EMAIL);
    await page.getByLabel(/mot de passe|password/i).fill(PASSWORD);
    await page.getByRole('button', { name: /connexion|login/i }).click();

    // Step 1 : Bienvenue
    await expect(page.getByRole('dialog', { name: /Bienvenue/i })).toBeVisible({ timeout: 8000 });
    await page.getByRole('button', { name: /Commencer/i }).click();

    // Step 2 : Profil — on peut skipper
    await expect(page.getByText(/Votre profil/i)).toBeVisible();
    await page.getByRole('button', { name: /Passer/i }).click();

    // Step 3 : Premier vehicule
    await expect(page.getByText(/Votre premier vehicule/i)).toBeVisible();
    await page.getByRole('button', { name: /Passer/i }).click();

    // Step 4 : Inviter un collegue
    await expect(page.getByText(/Inviter un collegue/i)).toBeVisible();
    await page.getByRole('button', { name: /Passer/i }).click();

    // Step 5 : Termine
    await expect(page.getByText(/Tout est pret/i)).toBeVisible();
    await page.getByRole('button', { name: /Aller au tableau de bord/i }).click();

    await expect(page).toHaveURL(/\/dashboard/);
  });
});
