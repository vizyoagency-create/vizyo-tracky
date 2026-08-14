import { expect, test, type Page } from '@playwright/test';
import {
  capture,
  contrasteRendu,
  deborde,
  jetonPresent,
  ouvrirSession,
  TELEPHONE,
} from './helpers/session-locale';

/**
 * Lot A6 — LA RECETTE DES DEUX ÉCRANS DE DEMANDE, À 375 px.
 * Cf. docs/A6-DEMANDES-ET-DEVIS.md § 7bis et § 10.
 *
 * ┌─ CE QUE CE FICHIER EXISTE POUR PROUVER ───────────────────────────────────┐
 * │ La règle n° 3 du chantier : « vérifie chaque écran DANS LE NAVIGATEUR, à   │
 * │ 375 px. Pas de conclusion sur lecture de code. » Les tests unitaires       │
 * │ vérifient des fonctions, la garde des contrastes vérifie des jetons —      │
 * │ ni l'un ni l'autre ne dit si un bouton est atteignable au pouce, si une    │
 * │ modale se ferme, ou si la page déborde sur le côté.                        │
 * │                                                                            │
 * │ Chaque étape mesure DANS LE DOM RENDU : contraste réel, débordement réel,  │
 * │ cible tactile réelle. Une capture est jointe pour l'œil, mais aucune        │
 * │ assertion ne repose dessus — une capture ne prouve rien qu'on puisse       │
 * │ rejouer.                                                                    │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Le scénario suit LE CYCLE COMPLET, dans l'ordre où il se vit :
 *   1. le transporteur règle sa grille        (la dette n° 1 du plan)
 *   2. le dépôt dépose une demande            (T5)
 *   3. le transporteur la trouve et discute   (T6)
 *   4. le dépôt accepte                       (T6)
 *   5. le transporteur affecte un camion      (T7)
 *
 * ⚠️ SÉRIEL, ET C'EST STRUCTUREL : l'étape 3 ne peut pas exister sans la 2. Un
 * `fullyParallel` ici ne ferait pas gagner de temps, il rendrait la recette
 * ininterprétable.
 */

test.describe.configure({ mode: 'serial' });

/** La référence de la demande créée à l'étape 2, relue par les suivantes. */
let refDemande = '';

/**
 * Une empreinte propre à cette exécution, glissée dans l'adresse de chargement.
 *
 * ⚠️ SANS ELLE, LA RECETTE MENT. Les étapes 3 à 5 doivent retrouver LA demande que
 * l'étape 2 vient de déposer. Les repérer par « la première de la liste » a paru
 * suffire — jusqu'à ce qu'une capture montre l'étape 3 en train de négocier D-0004,
 * une demande restée d'une exécution précédente : le test passait, mais il n'éprouvait
 * pas ce qu'il prétendait. Les listes sont triées par ce qui appelle une action, pas
 * par date de création, et une base de recette accumule les résidus.
 */
const EMPREINTE = `R${Date.now().toString().slice(-6)}`;
const ADRESSE_CHARGEMENT = `Entrepôt Fenouillet ${EMPREINTE}`;

/**
 * Le créneau souhaité — dans trois jours, à une heure PROPRE À CETTE EXÉCUTION.
 *
 * ⚠️ L'étape 5 affecte un vrai véhicule, qui devient donc indisponible sur ce créneau.
 * Deux recettes lancées sur le même horaire se disputeraient les mêmes camions, et la
 * seconde échouerait sur « aucun véhicule libre » — un échec qui accuse l'écran alors
 * qu'il n'a rien fait de mal. Le décalage horaire rend la recette REJOUABLE.
 */
const HEURE_DEPART = 5 + (new Date().getMinutes() % 12);

function creneau(decalageHeures: number): string {
  const d = new Date(Date.now() + 3 * 24 * 3600_000);
  d.setHours(HEURE_DEPART + decalageHeures, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Les trois contrôles non négociables, sur l'écran tel qu'il est rendu.
 *
 * Regroupés parce qu'ils vont toujours ensemble : un écran qui passe l'un et rate
 * l'autre n'est pas « à moitié conforme », il est à refaire.
 */
async function controlesDeBase(page: Page, ecran: string): Promise<void> {
  expect(await deborde(page), `${ecran} : la page déborde horizontalement à 375 px`).toBe(false);

  // Toute cible tactile visible fait au moins 44 px de haut. Le seuil vient d'A3 § 5
  // et il est tenu par les styles ; le vérifier ici attrape le cas où une règle
  // `@media` ne s'applique pas — ce qu'aucune relecture de CSS ne montre.
  //
  // ⚠️ On mesure LA ZONE RÉELLEMENT CLIQUABLE, pas l'élément. Une case à cocher de
  // 18 px enveloppée dans un `<label>` se coche sur toute la ligne du libellé : la
  // signaler serait un faux positif, et un faux positif dans un contrôle qu'on lit
  // à chaque recette finit par faire ignorer les vrais.
  const trop = await page.evaluate(() =>
    [...document.querySelectorAll('button, a[href], select, input, textarea')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return false;
        const type = (el as HTMLInputElement).type;
        if (type === 'checkbox' || type === 'radio') {
          const enveloppe = el.closest('label');
          if (enveloppe && enveloppe.getBoundingClientRect().height >= 44) return false;
        }
        // ARRONDI AU PIXEL. Un bouton déclaré `height: 44px` est mesuré 43,996 par
        // `getBoundingClientRect` dès que le facteur de zoom du navigateur n'est pas
        // exactement 1 — ce qui est le cas d'un viewport émulé. Comparer la valeur
        // brute signalerait une conformité parfaite comme un défaut, et un contrôle
        // qui crie au loup finit par ne plus être lu.
        return Math.round(r.height) < 44;
      })
      .map((el) => {
        const classe = (el.className || '').toString().split(' ')[0];
        const h = Math.round(el.getBoundingClientRect().height);
        return `${el.tagName.toLowerCase()}.${classe} (${h}px)`;
      }),
  );
  expect(trop, `${ecran} : cibles tactiles sous 44 px`).toEqual([]);
}

test.describe('A6 — demandes de mission et négociation, à 375 px', () => {
  test.skip(!jetonPresent('CARRIER') || !jetonPresent('DEPOT'), 'Jetons de recette manquants');

  test.beforeEach(async ({ page }) => {
    await page.setViewportSize(TELEPHONE);
  });

  // ═══ 1. LA DETTE N° 1 : L'ONGLET PARAMÈTRES, JAMAIS VU ═══════════════════

  test('1 — transporteur : l\'onglet Paramètres, sa grille et son simulateur', async ({ page }) => {
    await ouvrirSession(page, 'CARRIER');
    await page.goto('/missions?tab=parametres');

    await expect(page.getByRole('heading', { name: 'Tranches de distance' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('heading', { name: 'Essayer la grille' })).toBeVisible();

    // Les deux textes que la garde des contrastes avait trouvés sous le seuil.
    for (const [sel, quoi] of [
      ['.mp-aide', 'texte d\'aide'],
      ['.mp-tr--tete span', 'en-tête de colonne'],
    ] as const) {
      const r = await contrasteRendu(page, sel);
      expect(r, `Paramètres : ${quoi} introuvable`).not.toBeNull();
      expect(r!, `Paramètres : ${quoi} à ${r?.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }

    // Le simulateur : « pour 87 km → 169 € HT ». Une grille qu'on ne peut pas
    // essayer se règle à l'aveugle.
    await page.getByRole('button', { name: 'Calculer' }).click();
    await expect(page.locator('.mp-resu')).toContainText('51 à 100 km', { timeout: 10_000 });
    // Les montants sont formatés EN FRANÇAIS, deux décimales. L'écran affichait
    // « 202.8 € » — point décimal anglais, décimale manquante — sur le seul écran du
    // produit dont l'objet est de faire relire un prix.
    await expect(page.locator('.mp-resu')).toContainText('169,00 €');
    await expect(page.locator('.mp-resu')).toContainText('202,80 €');

    await controlesDeBase(page, 'Paramètres');
    await capture(page, 'e2e-captures/1-parametres-375.png', true);
  });

  // ═══ 2. LE DÉPÔT DÉPOSE SA DEMANDE ══════════════════════════════════════

  test('2 — dépôt : la modale en cinq étapes, et l\'avertissement de borne', async ({ page }) => {
    await ouvrirSession(page, 'DEPOT');
    await page.goto('/depot/missions');

    await page.getByRole('button', { name: /Demander une mission/i }).click();
    const modale = page.getByRole('dialog');
    await expect(modale).toBeVisible({ timeout: 15_000 });
    // L'étape est NOMMÉE (arbitrage F) : c'est tout l'objet du parcours.
    await expect(modale).toContainText('Étape 1 sur 5 · Trajet');

    // ── Trajet : un chargement, une livraison à 48 km ──────────────────────
    await modale.getByLabel('Adresse de chargement').fill(ADRESSE_CHARGEMENT);
    await modale.getByLabel('Adresse de la livraison 1').fill('Client Blagnac');
    await modale.getByLabel('Kilomètres du segment vers la livraison 1').fill('48');

    // Le retour n'est JAMAIS ajouté d'office (arbitrage H) : l'écran dit comment
    // le facturer, et ne le fait pas à la place du dépôt.
    await expect(modale).toContainText('ajoutez votre adresse de chargement comme dernière livraison');
    await expect(modale.getByLabel('Adresse de la livraison 2')).toHaveCount(0);

    // Le bandeau de devis se met à jour AVANT même de changer d'étape.
    await expect(modale.locator('.drm-bandeau')).toContainText('48 km');
    await expect(modale.locator('.drm-bandeau')).toContainText('94,80');

    await controlesDeBase(page, 'Demande · trajet');
    await capture(page, 'e2e-captures/2a-demande-trajet-375.png');

    await modale.getByRole('button', { name: 'Continuer' }).click();
    await expect(modale).toContainText('Étape 2 sur 5 · Marchandise');
    await modale.getByLabel('Nature de la marchandise').fill('4 palettes de carrelage');

    await modale.getByRole('button', { name: 'Continuer' }).click();
    await expect(modale).toContainText('Étape 3 sur 5 · Créneau');
    await modale.getByLabel('Au plus tôt').fill(creneau(0));
    await modale.getByLabel('Au plus tard').fill(creneau(4));

    await modale.getByRole('button', { name: 'Continuer' }).click();
    await expect(modale).toContainText('Étape 4 sur 5 · Devis');

    // ── L'AVERTISSEMENT DE BORNE : la raison d'être de l'écran ─────────────
    const borne = modale.locator('.drm-borne');
    await expect(borne).toBeVisible();
    await expect(borne).toContainText('3 km de plus');
    await expect(borne).toContainText('169,00');
    await expect(borne).toContainText('79,00');

    const contraste = await contrasteRendu(page, '.drm-borne');
    expect(contraste!, `Avertissement de borne à ${contraste?.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);

    await expect(modale.locator('.drm-devis-ttc')).toContainText('94,80');
    await controlesDeBase(page, 'Demande · devis');
    await capture(page, 'e2e-captures/2b-demande-devis-375.png');

    await modale.getByRole('button', { name: 'Continuer' }).click();
    await expect(modale).toContainText('Étape 5 sur 5 · Envoi');
    await modale.getByLabel(/Un mot pour le transporteur/i).fill('Quai 3, sangles nécessaires.');
    await capture(page, 'e2e-captures/2c-demande-envoi-375.png');

    await modale.getByRole('button', { name: 'Envoyer la demande' }).click();

    // La demande apparaît dans « Mes demandes », sur l'écran d'où elle est partie.
    // On la repère par SON EMPREINTE, pas par sa position : la liste est triée par ce
    // qui appelle une action, et une base de recette porte les résidus des exécutions
    // précédentes.
    const ligne = page.locator('.dms-dligne', { hasText: EMPREINTE });
    await expect(ligne).toBeVisible({ timeout: 15_000 });
    refDemande = (await ligne.locator('.dms-dref').textContent())?.trim() ?? '';
    expect(refDemande).toMatch(/^D-\d{4}$/);

    // ⚠️ LE POINT LE PLUS IMPORTANT DE CETTE ÉTAPE. Le tour 0 porte l'auteur
    // SYSTEM : sans `campDuTour`, la balle serait revenue au dépôt et il aurait pu
    // accepter son propre devis. C'est le transporteur qu'on attend.
    await expect(ligne).toContainText('Envoyée');
    await expect(page.locator('.dms-pastille')).toHaveCount(0);
  });

  // ═══ 3. LE TRANSPORTEUR LA TROUVE, ET DISCUTE ═══════════════════════════

  test('3 — transporteur : la demande est en tête de file, et il contre-propose', async ({ page }) => {
    await ouvrirSession(page, 'CARRIER');
    await page.goto('/missions?tab=demandes');

    // Elle doit être dans « À traiter », sans quoi l'onglet passe à côté de son objet.
    const section = page.locator('.mrq-liste').first();
    await expect(section).toBeVisible({ timeout: 15_000 });
    const ligne = page.locator('.mrq-ligne--urgente', { hasText: EMPREINTE });
    await expect(ligne).toBeVisible();
    // Le compteur s'accorde en nombre : « attend » ou « attendent » selon la file.
    await expect(page.locator('.mrq-compte')).toContainText(/attend(ent)? votre réponse/);

    await controlesDeBase(page, 'Demandes · file');
    await capture(page, 'e2e-captures/3a-file-demandes-375.png', true);

    await ligne.click();
    const modale = page.getByRole('dialog');
    await expect(modale).toContainText(refDemande);
    // Le vocabulaire du camp : le transporteur lit « le dépôt », jamais « votre
    // transporteur ».
    await expect(modale.locator('.mrt-fil')).toContainText('Devis automatique');
    await expect(modale).toContainText('Vous avez la main');

    await controlesDeBase(page, 'Demandes · fil');
    await capture(page, 'e2e-captures/3b-fil-negociation-375.png', true);

    // Il doute de la distance : 48 km annoncés, il en compte 62. Le prix se
    // recalcule (arbitrage I) et passe donc à la tranche 51-100.
    await modale.getByRole('button', { name: 'Contre-proposer' }).click();
    await modale.getByLabel('Distance retenue').fill('62');
    // Le prix se RECALCULE sur la nouvelle distance (arbitrage I), puis reste
    // ajustable. L'aide-mémoire annonçait « Sur 62 km, votre grille donne 79,00 € HT
    // (tranche 0 à 50 km) » : le nombre venait de la nouvelle saisie, le prix de
    // l'ancienne. On vérifie donc LES DEUX — la tranche autant que le montant.
    await expect(modale).toContainText('169,00');
    await expect(modale).toContainText('tranche 51 à 100 km');
    await expect(modale.getByLabel('Votre montant HT')).toHaveValue('169');
    await modale.getByLabel(/Un mot/i).fill('Vous annonciez 48 km, nous en comptons 62 par la rocade.');
    await capture(page, 'e2e-captures/3c-contre-proposition-375.png');

    await modale.getByRole('button', { name: 'Envoyer la proposition' }).click();
    await expect(modale).toContainText('En attente du dépôt', { timeout: 15_000 });
  });

  // ═══ 4. LE DÉPÔT REÇOIT, ET ACCEPTE ═════════════════════════════════════

  test('4 — dépôt : il voit la contre-proposition et l\'accepte', async ({ page }) => {
    await ouvrirSession(page, 'DEPOT');
    await page.goto('/depot/missions');

    // C'est maintenant SON tour : la pastille le dit sans qu'il ait à ouvrir.
    await expect(page.locator('.dms-pastille')).toContainText('1 en attente de vous', {
      timeout: 15_000,
    });
    await page.locator('.dms-dligne', { hasText: EMPREINTE }).click();

    const modale = page.getByRole('dialog');
    await expect(modale).toContainText('En négociation');
    // Le MÊME fil, avec les mots de SON camp.
    await expect(modale.locator('.mrt-fil')).toContainText('Votre transporteur');
    await expect(modale.locator('.mrt-fil')).toContainText('62 par la rocade');

    await controlesDeBase(page, 'Dépôt · fil');
    await capture(page, 'e2e-captures/4-depot-fil-375.png', true);

    await modale.getByRole('button', { name: /Accepter/ }).click();
    await expect(modale).toContainText('Accord conclu', { timeout: 15_000 });
    // Ce qu'il doit comprendre ensuite : plus rien à faire de son côté.
    await expect(modale).toContainText('affecte à présent un véhicule');
    // La négociation est CLOSE : plus aucun geste ne lui est proposé.
    await expect(modale.getByRole('button', { name: 'Contre-proposer' })).toHaveCount(0);
  });

  // ═══ 5. LE TRANSPORTEUR AFFECTE — LA MISSION NAÎT ═══════════════════════

  test('5 — transporteur : il affecte un camion, la mission existe', async ({ page }) => {
    await ouvrirSession(page, 'CARRIER');
    await page.goto('/missions?tab=demandes');

    await page.locator('.mrq-ligne', { hasText: EMPREINTE }).click();
    const modale = page.getByRole('dialog');
    await expect(modale).toContainText('Accord conclu', { timeout: 15_000 });

    // L'affectation n'apparaît QU'ICI : ni au dépôt, ni avant l'accord.
    await expect(modale.getByRole('heading', { name: 'Affecter un véhicule' })).toBeVisible();
    await controlesDeBase(page, 'Affectation');
    await capture(page, 'e2e-captures/5a-affectation-375.png', true);

    // ⚠️ ON CHOISIT PAR VALEUR, PAS PAR INDEX. Les véhicules occupés restent dans la
    // liste — grisés, avec leur motif, parce qu'un camion qui disparaît sans
    // explication renvoie le gestionnaire au formulaire cinq fois. L'option d'index 1
    // peut donc être désactivée, et `selectOption({index})` échoue alors sur un écran
    // parfaitement correct.
    const choix = modale.getByLabel('Véhicule', { exact: true });
    const libres = await choix.locator('option:not([disabled])').evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''),
    );
    expect(libres.length, 'aucun véhicule libre sur le créneau').toBeGreaterThan(0);
    await choix.selectOption(libres[0]);

    await modale.getByRole('button', { name: 'Créer la mission' }).click();
    await expect(modale).toContainText('Devenue mission', { timeout: 20_000 });
    await expect(modale).toContainText('devenue une mission');
    await capture(page, 'e2e-captures/5b-mission-creee-375.png', true);
  });

  // ═══ 6. LE MÊME PARCOURS, EN GRAND ══════════════════════════════════════

  test('6 — les deux écrans en 1280 px : rien ne casse en s\'élargissant', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await ouvrirSession(page, 'CARRIER');

    await page.goto('/missions?tab=demandes');
    await expect(page.locator('.mrq-liste').first()).toBeVisible({ timeout: 15_000 });
    expect(await deborde(page), 'Demandes : débordement en 1280 px').toBe(false);
    await capture(page, 'e2e-captures/6a-demandes-1280.png', true);

    await page.goto('/missions?tab=parametres');
    await expect(page.getByRole('heading', { name: 'Tranches de distance' })).toBeVisible();
    expect(await deborde(page), 'Paramètres : débordement en 1280 px').toBe(false);
    await capture(page, 'e2e-captures/6b-parametres-1280.png', true);
  });
});
