import { expect, test } from '@playwright/test';
import { login } from './helpers/auth';

/**
 * V1.6 (P4) — User-flow : creer un vehicule + l'associer a un tracker.
 *
 * Pre-requis :
 *   - User authentifie (E2E_TEST_EMAIL/PASSWORD)
 *   - Au moins 1 tracker non assigne en base (le wizard add-vehicle propose
 *     les trackers libres dans son etape 2)
 *
 * Plate de test : `E2E-${timestamp}` (unique par run).
 */

const PLATE = `E2E-${Date.now().toString().slice(-6)}`;

test.describe('Create vehicle flow', () => {
  test.skip(!process.env.E2E_TEST_EMAIL, 'E2E_TEST_EMAIL non defini');

  test('creer un vehicule depuis /vehicles', async ({ page }) => {
    await login(page);

    await page.goto('/vehicles');
    await expect(page).toHaveURL(/\/vehicles/);

    // Ouvrir le modal "Ajouter un vehicule"
    await page.getByRole('button', { name: /ajouter|nouveau vehicule/i }).first().click();

    // Etape 1 : remplir la plaque + type
    await page.getByLabel(/plaque|plate/i).fill(PLATE);
    await page.getByRole('button', { name: /suivant|continuer/i }).click();

    // Etape 2 : optionnellement assigner un tracker (skippable)
    await page.getByRole('button', { name: /terminer|valider|creer/i }).click();

    // Verification : le nouveau vehicule apparait dans la liste
    await expect(page.getByText(PLATE)).toBeVisible({ timeout: 5000 });
  });
});
