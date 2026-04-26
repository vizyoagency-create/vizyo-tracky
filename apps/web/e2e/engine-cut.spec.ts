import { expect, test } from '@playwright/test';
import { login } from './helpers/auth';

/**
 * V1.6 (P4) — User-flow : couper le moteur d'un vehicule avec confirmation.
 *
 * Pre-requis :
 *   - User authentifie + au moins 1 vehicule avec tracker ONLINE
 *   - Vehicule a l'arret (vitesse < 20km/h) sinon le garde-fou refuse
 *
 * Le flow exerce :
 *   1. Ouvrir la fiche vehicule
 *   2. Cliquer "Couper le moteur"
 *   3. Confirmer dans la modal (double confirmation)
 *   4. Verifier qu'une commande CUT apparait dans l'historique
 *
 * /!\ Modifie l'etat reel du tracker — a ne pas executer en prod.
 */

test.describe('Engine cut flow', () => {
  test.skip(!process.env.E2E_TEST_EMAIL, 'E2E_TEST_EMAIL non defini');
  test.skip(!process.env.E2E_TEST_VEHICLE_ID, 'E2E_TEST_VEHICLE_ID non defini (id d\'un vehicule a l\'arret)');

  test('CUT moteur avec double confirmation + audit', async ({ page }) => {
    await login(page);

    const vehicleId = process.env.E2E_TEST_VEHICLE_ID!;
    await page.goto(`/vehicles/${vehicleId}`);

    // Cliquer le bouton "Couper le moteur" (premiere confirmation)
    const cutBtn = page.getByRole('button', { name: /couper le moteur|cut/i }).first();
    await expect(cutBtn).toBeVisible({ timeout: 5000 });
    await cutBtn.click();

    // Modal de confirmation
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: /confirmer/i }).click();

    // Toast de succes OU pill "Coupe" qui apparait dans l'historique
    await expect(
      page.getByText(/coupure envoyee|moteur coupe|engine cut|cut.*ok/i),
    ).toBeVisible({ timeout: 8000 });

    // Restaure pour ne pas laisser le vehicule coupe
    await page.getByRole('button', { name: /restaurer|restore/i }).first().click();
    await page.getByRole('button', { name: /confirmer/i }).click();
    await expect(page.getByText(/restauration|restore.*ok|moteur restaure/i)).toBeVisible({ timeout: 8000 });
  });
});
