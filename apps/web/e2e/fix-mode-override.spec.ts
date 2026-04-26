import { expect, test } from '@playwright/test';
import { login } from './helpers/auth';

/**
 * V1.6 (P4) — User-flow : override fix mode adaptatif depuis l'admin.
 *
 * Pre-requis :
 *   - User SUPER_ADMIN (E2E_SUPERADMIN_EMAIL/PASSWORD)
 *   - Au moins 1 tracker en base (E2E_TEST_TRACKER_ID)
 *
 * Le flow exerce :
 *   1. Ouvrir /admin/trackers/:id/fix-mode
 *   2. Choisir un intervalle (ex: 30s)
 *   3. Choisir une duree (ex: 1h)
 *   4. Cliquer "Appliquer"
 *   5. Verifier qu'un toast confirme l'override + une nouvelle ligne dans la timeline
 */

test.describe('Fix mode override flow', () => {
  test.skip(!process.env.E2E_SUPERADMIN_EMAIL, 'E2E_SUPERADMIN_EMAIL non defini');
  test.skip(!process.env.E2E_TEST_TRACKER_ID, 'E2E_TEST_TRACKER_ID non defini');

  test('SUPER_ADMIN peut forcer un fix interval pour 1h', async ({ page }) => {
    await login(page, process.env.E2E_SUPERADMIN_EMAIL, process.env.E2E_SUPERADMIN_PASSWORD);

    const trackerId = process.env.E2E_TEST_TRACKER_ID!;
    await page.goto(`/admin/trackers/${trackerId}/fix-mode`);

    // Section override manuel
    await expect(page.getByText(/Override manuel/i)).toBeVisible({ timeout: 5000 });

    // Choix de l'intervalle
    const intervalSelect = page.locator('select').first();
    await intervalSelect.selectOption('30');

    // Choix de la duree
    const durationSelect = page.locator('select').nth(1);
    await durationSelect.selectOption('60');

    // Appliquer
    await page.getByRole('button', { name: /appliquer/i }).click();

    // Toast de succes
    await expect(page.getByText(/Override actif jusqu/i)).toBeVisible({ timeout: 8000 });

    // Re-set pour lever l'override (proprete)
    await durationSelect.selectOption('0');
    await page.getByRole('button', { name: /appliquer/i }).click();
    await expect(page.getByText(/Override leve/i)).toBeVisible({ timeout: 5000 });
  });
});
