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
 * Le créneau souhaité — PROPRE À CETTE EXÉCUTION, jour ET heure.
 *
 * ⚠️ L'étape 5 affecte un vrai véhicule, qui devient donc indisponible sur ce créneau.
 * Deux recettes qui tombent sur le même horaire se disputent les mêmes camions, et la
 * seconde échoue sur « aucun véhicule libre » — un échec qui accuse l'écran alors qu'il
 * n'a rien fait de mal.
 *
 * ⚠️ LE CRÉNEAU EST DÉRIVÉ DE L'HORLOGE, PAS TIRÉ AU SORT, et la nuance a coûté une
 * recette. Croiser `getSeconds() % 5` et `getMinutes() % 12` donnait bien soixante
 * créneaux — mais tirés au hasard à chaque lancement. Or soixante tirages aléatoires
 * se télescopent bien avant d'être épuisés : à la quinzième exécution d'une journée,
 * une collision est plus probable qu'improbable, et elle est arrivée. Une MINUTERIE
 * monotone ne se répète, elle, qu'après avoir tout parcouru : deux lancements à une
 * minute d'écart ne peuvent pas tomber sur le même jour, et le cycle complet fait
 * quatre heures.
 */
const MINUTES_EPOCH = Math.floor(Date.now() / 60_000);
const HEURE_DEPART = 5 + (Math.floor(MINUTES_EPOCH / 20) % 12);
const JOURS_DAVANCE = 3 + (MINUTES_EPOCH % 20);

function creneau(decalageHeures: number, joursDAvance = JOURS_DAVANCE): string {
  const d = new Date(Date.now() + joursDAvance * 24 * 3600_000);
  d.setHours(HEURE_DEPART + decalageHeures, 0, 0, 0);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * ⚠️ LA MISSION DE T8 EST CREEE AUJOURD'HUI, et ce n'est pas un detail.
 *
 * L'ecran « Mes missions » du depot est une vue DU JOUR : `DepotLiveService` ne rend
 * que les missions dont la fenetre croise la journee en cours, plus celles restees
 * ouvertes. Une mission planifiee dans trois jours n'y apparait pas — ce qui est le
 * comportement voulu, mais rendait l'etape 5ter faussement rouge.
 *
 * Le serveur accepte un creneau passe (seul l'horizon de 90 jours a venir est borne),
 * on peut donc viser une heure fixe de la journee sans dependre de l'heure a laquelle
 * la recette tourne.
 */
function creneauDuJour(decalageHeures: number): string {
  return creneau(decalageHeures, 0);
}

/**
 * Ouvre le tableau des missions de l'agenda, quel que soit le compte.
 *
 * ⚠️ LE SEGMENT « Mission » N'EXISTE PAS POUR TOUT LE MONDE, et c'est le correctif du
 * 2026-08-15. Le sélecteur de type ne pilote que la grille du calendrier : un compte
 * sans `agenda_view` n'a pas de grille, donc pas de barre de filtres — l'agenda s'ouvre
 * DIRECTEMENT sur les missions. Un compte qui a les deux garde ses cinq segments et doit
 * cliquer.
 *
 * Cliquer sans condition marcherait pour l'un et échouerait pour l'autre. On vise donc
 * le PANNEAU, seul point d'ancrage commun aux deux parcours.
 */
async function ouvrirOngletMissions(page: Page): Promise<void> {
  const segment = page.getByRole('button', { name: 'Mission', exact: true });
  const creer = page.getByRole('button', { name: /Nouvelle mission/i });

  // ⚠️ ON ATTEND AVANT DE COMPTER. `count()` est un INSTANTANÉ, pas une assertion qui
  // patiente : appelé dans la foulée du `goto`, il lisait le DOM d'avant le rendu
  // Angular, renvoyait 0, et le clic était sauté en silence. Le test attendait ensuite
  // quinze secondes un tableau que personne n'avait ouvert — en accusant l'écran.
  //
  // Le point d'ancrage est donc « l'un OU l'autre » : le segment si le compte a le
  // calendrier, le tableau directement s'il ne l'a pas.
  await expect(segment.or(creer).first()).toBeVisible({ timeout: 15_000 });
  if (await segment.count()) await segment.click();
  await expect(creer).toBeVisible({ timeout: 15_000 });
}

/**
 * Les trois contrôles non négociables, sur l'écran tel qu'il est rendu.
 *
 * Regroupés parce qu'ils vont toujours ensemble : un écran qui passe l'un et rate
 * l'autre n'est pas « à moitié conforme », il est à refaire.
 */
async function controlesDeBase(page: Page, ecran: string, racine = 'body'): Promise<void> {
  expect(await deborde(page), `${ecran} : la page déborde horizontalement à 375 px`).toBe(false);

  // Toute cible tactile visible fait au moins 44 px de haut. Le seuil vient d'A3 § 5
  // et il est tenu par les styles ; le vérifier ici attrape le cas où une règle
  // `@media` ne s'applique pas — ce qu'aucune relecture de CSS ne montre.
  //
  // ⚠️ On mesure LA ZONE RÉELLEMENT CLIQUABLE, pas l'élément. Une case à cocher de
  // 18 px enveloppée dans un `<label>` se coche sur toute la ligne du libellé : la
  // signaler serait un faux positif, et un faux positif dans un contrôle qu'on lit
  // à chaque recette finit par faire ignorer les vrais.
  //
  // ⚠️ LA PORTÉE COMPTE. Une modale se superpose à un écran qu'elle ne possède pas :
  // mesurer toute la page reviendrait à imputer à ce lot les cibles de l'agenda ou du
  // tableau de bord qui vivent derrière le voile. Constaté le 2026-08-14 — la recette
  // de T8 a signalé sept boutons de l'agenda existant, tous hors sujet ET tous
  // réellement sous le seuil. Ils sont consignés dans la revue plutôt que noyés ici :
  // un contrôle qui accuse le mauvais écran finit par être désactivé.
  const trop = await page.evaluate((sel) =>
    [...(document.querySelector(sel) ?? document.body).querySelectorAll('button, a[href], select, input, textarea')]
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
        // Le NOM ACCESSIBLE, pas seulement la classe : une classe utilitaire comme
        // `text-fg-tertiary` est portee par quarante composants, et le message ne
        // disait donc pas QUEL bouton corriger. On perdait la mesure a le chercher.
        const nom =
          el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 28) || '(sans nom)';
        return `${el.tagName.toLowerCase()}.${classe} (${h}px) « ${nom} »`;
      }),
    racine,
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

  // ═══ 5bis. T8 — LES ARRÊTS MULTIPLES DEPUIS L'AGENDA ════════════════════

  /**
   * A6 / T8, arbitrage A : « c'est rare, les missions avec une seule adresse ».
   *
   * Le chemin éprouvé ici n'est PAS celui d'une demande convertie — celui-là copie les
   * arrêts d'une négociation. C'est la création DIRECTE par le gestionnaire, dans son
   * agenda, sans demande en amont : le cas le plus courant, et le seul où il saisit la
   * tournée lui-même.
   *
   * ⚠️ Le test vérifie les DEUX bouts de la chaîne. Écrire les arrêts sans que le dépôt
   * les voie n'aurait servi à rien : il continuerait de lire « Fenouillet → Muret » sur
   * une tournée à quatre points, et d'appeler pour comprendre pourquoi son camion
   * arrive en retard.
   */
  test('5bis — agenda : une mission à plusieurs livraisons, et ce que le dépôt en voit', async ({ page }) => {
    await ouvrirSession(page, 'CARRIER');
    await page.goto('/agenda');

    // L'onglet Mission de l'agenda porte la liste ET le bouton de création.
    await ouvrirOngletMissions(page);
    await page.getByRole('button', { name: /Nouvelle mission/i }).click();

    // L'agenda LUI-MEME, avant d'ouvrir quoi que ce soit. Ses sept boutons sous 44 px
    // etaient anterieurs a ce lot et sortis du controle le 2026-08-14 ; ils sont
    // corriges, et la mesure revient ici pour qu'ils ne redescendent pas.
    await controlesDeBase(page, 'Agenda · barre d\'outils');

    const modale = page.getByRole('dialog');
    await expect(modale).toBeVisible({ timeout: 15_000 });
    await modale.getByLabel('Point de départ').fill(`Dépôt ${EMPREINTE}`);
    await modale.getByLabel('Destination', { exact: true }).fill('Client Muret');

    // Le bloc reste REPLIÉ tant qu'on n'ajoute rien : le point à point ne s'allonge pas.
    await expect(modale.getByLabel(/Livraison intermédiaire/)).toHaveCount(0);
    await modale.getByRole('button', { name: /Ajouter une livraison intermédiaire/i }).click();
    await modale.getByLabel('Livraison intermédiaire 1').fill('Client Blagnac');
    await modale.getByRole('button', { name: /Ajouter une livraison intermédiaire/i }).click();
    await modale.getByLabel('Livraison intermédiaire 2').fill('Client Colomiers');

    // Réordonner : Colomiers doit passer avant Blagnac.
    await modale.getByRole('button', { name: 'Remonter la livraison 2' }).click();
    await expect(modale.getByLabel('Livraison intermédiaire 1')).toHaveValue('Client Colomiers');

    // La MODALE seule : l'agenda derrière elle porte ses propres cibles sous 44 px,
    // antérieures à ce lot et consignées dans la revue.
    await controlesDeBase(page, 'Agenda · mission multi-arrêts', '[role="dialog"]');
    await capture(page, 'e2e-captures/5c-agenda-multi-arrets-375.png');

    // Le créneau — AUJOURD'HUI, pour que le dépôt le voie à l'étape suivante — et le
    // véhicule, le premier libre, comme à l'affectation.
    await modale.getByLabel('Date').fill(creneauDuJour(0).slice(0, 10));
    await modale.getByLabel('Heure de départ').fill(creneauDuJour(0).slice(11, 16));
    await modale.getByLabel('Heure de fin').fill(creneauDuJour(3).slice(11, 16));
    // ⚠️ ON ATTEND LA RÉPONSE DE DISPONIBILITÉ. Chaque frappe sur la date ou l'heure
    // relance une requête, et la modale se protège même des réponses arrivées dans le
    // désordre. Lire la liste dans la foulée du dernier `fill` la trouve donc vide —
    // non parce que la flotte est prise, mais parce qu'elle n'est pas encore revenue.
    const choix = modale.getByLabel('Véhicule', { exact: true });
    const libresDe = () =>
      choix.locator('option:not([disabled])').evaluateAll((options) =>
        options.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''),
      );
    await expect
      .poll(async () => (await libresDe()).length, {
        message: 'aucun véhicule libre pour la mission multi-arrêts',
        timeout: 15_000,
      })
      .toBeGreaterThan(0);
    await choix.selectOption((await libresDe())[0]);

    // Le dépôt destinataire : sans lui, personne ne verrait la tournée.
    const depots = modale.getByLabel('Dépôt destinataire', { exact: true });
    const optionsDepot = await depots.locator('option').evaluateAll((options) =>
      options.map((o) => (o as HTMLOptionElement).value).filter((v) => v !== ''),
    );
    expect(optionsDepot.length, 'aucun dépôt à qui adresser la mission').toBeGreaterThan(0);
    await depots.selectOption(optionsDepot[0]);

    await modale.getByRole('button', { name: /Créer la mission|Créer|Enregistrer/i }).first().click();

    // Côté transporteur : la liste ANNONCE le nombre de livraisons, sans dérouler la
    // tournée — une liste sert à retrouver une mission, pas à préparer une feuille
    // de route.
    await expect(page.locator('.mp-trajet, .mp-carte-trajet').first()).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByText(/\(3 livraisons\)/).first()).toBeVisible({ timeout: 15_000 });
    await capture(page, 'e2e-captures/5d-liste-multi-arrets-375.png', true);
  });

  test('5ter — dépôt : il voit la tournée complète, pas seulement les deux bouts', async ({ page }) => {
    await ouvrirSession(page, 'DEPOT');
    await page.goto('/depot/missions');

    const carte = page.locator('.dmc', { hasText: EMPREINTE }).first();
    await expect(carte).toBeVisible({ timeout: 15_000 });
    // Les arrêts INTERMÉDIAIRES seuls : le départ et la destination sont déjà lus
    // au-dessus, les répéter ferait lire trois fois la même adresse.
    await expect(carte.locator('.dmc-etapes li')).toHaveCount(2);
    await expect(carte.locator('.dmc-etapes')).toContainText('Client Colomiers');
    await expect(carte.locator('.dmc-etapes')).toContainText('Client Blagnac');

    await controlesDeBase(page, 'Dépôt · tournée');
    // La CARTE seule : l'espace dépôt fait défiler un conteneur interne, et un
    // `fullPage` n'y capture que le haut de l'écran — donc jamais la mission.
    await carte.scrollIntoViewIfNeeded();
    await carte.screenshot({ path: 'e2e-captures/5e-depot-tournee-375.png' });
  });

  // ═══ 5quater. LA TOURNÉE SE MODIFIE, ET LAISSE UNE TRACE ════════════════

  /**
   * A6 — « qui a changé quoi, quand, et de combien le prix bouge ».
   *
   * Le journal n'est pas un confort : une tournée qui change change le prix, et sans
   * historique le dépôt découvre l'écart sur sa facture, sans pouvoir dire ce qui a
   * bougé. Le scénario suit donc les DEUX bouts — le transporteur qui modifie, et le
   * dépôt qui lit ce qui a changé.
   */
  test('5quater — transporteur : il modifie la tournée, avec motif, et le journal la retient', async ({ page }) => {
    await ouvrirSession(page, 'CARRIER');
    await page.goto('/agenda');
    await ouvrirOngletMissions(page);

    // ⚠️ ON VISE « Dépôt <empreinte> », PAS SEULEMENT L'EMPREINTE. Deux missions de
    // cette exécution la portent : celle née de la demande (« Entrepôt <empreinte> »)
    // et celle saisie dans l'agenda (« Dépôt <empreinte> »). Le `.first()` prenait la
    // première par heure de départ, donc pas toujours la bonne — et le scénario
    // éprouvait alors une mission qu'il n'avait pas préparée.
    const ligne = page.locator('.mp-carte', { hasText: `Dépôt ${EMPREINTE}` }).first();
    await expect(ligne).toBeVisible({ timeout: 15_000 });
    await ligne.getByRole('button', { name: /Modifier la tournée/i }).click();

    const modale = page.getByRole('dialog');
    await expect(modale).toBeVisible({ timeout: 15_000 });
    // La tournée s'ouvre sur CE QU'ELLE EST, jamais sur un formulaire vide.
    await expect(modale.getByLabel('Adresse de chargement')).toHaveValue(new RegExp(EMPREINTE));
    // L'historique porte déjà la version initiale, écrite à la création.
    await expect(modale.getByText('Tournée initiale')).toBeVisible();

    // Une livraison de plus, et la distance qui va avec.
    //
    // ⚠️ ON ATTEND QUE LA LIGNE SOIT RENDUE AVANT DE COMPTER. `count()` juste après le
    // clic lisait le DOM d'avant le rendu Angular : il renvoyait 3 au lieu de 4, et le
    // test remplissait donc la TROISIÈME livraison — écrasant « Client Muret » — pour
    // laisser la quatrième vide. Le formulaire refusait alors d'enregistrer, à juste
    // titre : une adresse vide n'est pas une livraison. Le test accusait l'écran d'un
    // défaut qu'il avait lui-même provoqué.
    const adresses = modale.getByLabel(/Adresse de la livraison/);
    const avant = await adresses.count();
    await modale.getByRole('button', { name: /Ajouter une livraison/i }).click();
    await expect(adresses).toHaveCount(avant + 1);
    await modale.getByLabel(`Adresse de la livraison ${avant + 1}`).fill('Client Tournefeuille');
    await modale.getByLabel('Distance retenue').fill('62');

    // ⚠️ SANS MOTIF, ON NE PASSE PAS. Une tournée qu'on change a une raison, et
    // c'est elle qu'on relira dans le journal.
    await expect(modale.getByRole('button', { name: /Enregistrer la tournée/i })).toBeDisabled();
    await modale.getByLabel('Motif du changement').fill('Le client a ajouté un point de livraison.');
    await expect(modale.getByRole('button', { name: /Enregistrer la tournée/i })).toBeEnabled();

    await controlesDeBase(page, 'Tournée · édition', '[role="dialog"]');
    await capture(page, 'e2e-captures/7a-tournee-edition-375.png');

    await modale.getByRole('button', { name: /Enregistrer la tournée/i }).click();
    await expect(modale).toBeHidden({ timeout: 20_000 });

    // Le journal a retenu : on rouvre et la modification y est, signée et datée.
    await page.locator('.mp-carte', { hasText: `Dépôt ${EMPREINTE}` }).first()
      .getByRole('button', { name: /Modifier la tournée/i }).click();
    const relue = page.getByRole('dialog');
    await expect(relue.getByText('Modification 1')).toBeVisible({ timeout: 15_000 });
    await expect(relue).toContainText('Le client a ajouté un point de livraison.');
    await expect(relue).toContainText('Client Tournefeuille');
    await capture(page, 'e2e-captures/7b-tournee-journal-375.png');
  });

  test('5quinquies — dépôt : il voit que sa tournée a changé, par qui et pourquoi', async ({ page }) => {
    await ouvrirSession(page, 'DEPOT');
    await page.goto('/depot/missions');

    // « Dépôt <empreinte> », comme au scénario précédent : deux missions de cette
    // exécution portent l'empreinte, et seule celle-ci a été modifiée.
    const carte = page.locator('.dmc', { hasText: `Dépôt ${EMPREINTE}` }).first();
    await expect(carte).toBeVisible({ timeout: 15_000 });
    // La phrase qui évite la facture surprise.
    await expect(carte.locator('.dmc-modif')).toContainText('Tournée modifiée');
    await expect(carte.locator('.dmc-modif')).toContainText('Le client a ajouté un point de livraison.');

    const contraste = await contrasteRendu(page, '.dmc-modif');
    expect(contraste!, `« tournée modifiée » à ${contraste?.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);

    await controlesDeBase(page, 'Dépôt · tournée modifiée');
    await carte.scrollIntoViewIfNeeded();
    await carte.screenshot({ path: 'e2e-captures/7c-depot-tournee-modifiee-375.png' });
  });

  // ═══ 5sexies. CELUI QUI N'A PAS LE DROIT ════════════════════════════════

  test('5sexies — gestionnaire sans la permission : ni l\'onglet, ni la porte', async ({ page }) => {
    // ⚠️ LE SEUL SCÉNARIO QUI VÉRIFIE UN REFUS, ET C'EST POUR ÇA QU'IL EXISTE.
    //
    // Les neuf autres tournent sous des comptes autorisés : ils prouvent que l'écran
    // MARCHE, jamais qu'il se FERME. Or « ça ne s'affiche qu'aux personnes
    // autorisées » est une demande explicite du client, et une demande de ce genre
    // ne se vérifie que par la négative.
    //
    // Les deux moitiés comptent, et elles sont indépendantes :
    //   — l'onglet caché, sinon le compte voit une promesse qui finira en erreur ;
    //   — l'API fermée, sinon l'écran est seulement DISCRET. Cacher un bouton n'a
    //     jamais fermé une route : le lot précédent l'a appris avec le conducteur qui
    //     lisait 21 Ko de négociations sans qu'aucun écran ne le lui propose.
    test.skip(!jetonPresent('SANS_PERM'), 'Jeton A6_TOKEN_SANS_PERM manquant');
    await ouvrirSession(page, 'SANS_PERM');

    // Il demande explicitement l'onglet interdit : le lien a pu lui être transféré.
    await page.goto('/missions?tab=demandes');
    await expect(page.getByRole('heading', { name: 'Tranches de distance' })).toBeVisible({
      timeout: 15_000,
    });
    await expect(page.getByRole('tab', { name: /Demandes/ })).toHaveCount(0);
    // Le sous-titre non plus ne promet pas ce qu'il ne tient pas.
    await expect(page.locator('.mp-sous')).not.toContainText('demandes de vos dépôts');

    // Et la porte de derrière, celle qu'aucun écran ne montre.
    const refus = await page.evaluate(async () => {
      const r = await fetch('/api/mission-requests', {
        headers: { Authorization: `Bearer ${localStorage.getItem('vizyo-tracky-token')}` },
      });
      return { statut: r.status, taille: (await r.text()).length };
    });
    expect(refus.statut, `GET /mission-requests a renvoyé ${refus.statut}`).toBe(403);

    await controlesDeBase(page, 'Missions · sans la permission');
    await capture(page, 'e2e-captures/7d-sans-permission-375.png');
  });

  test('5septies — gestionnaire sans agenda_view : l\'agenda ne crie plus', async ({ page }) => {
    // ⚠️ CE SCÉNARIO EXISTE PARCE QUE LES CAPTURES DE RECETTE LE MONTRAIENT DÉJÀ.
    //
    // Sur chaque écran d'agenda pris pendant ce lot, deux bandeaux rouges attendaient
    // en bas : « Vous n'avez pas l'autorisation de consulter ces données » et
    // « Permission requise : agenda_view ». Le produit fonctionnait — les missions se
    // chargeaient — mais il annonçait une panne à chaque ouverture.
    //
    // La cause est structurelle et vaut d'être retenue : la ROUTE est gardée large
    // (agenda_view, reservations_*, ai_optimize, missions_view) pour que chacun
    // atteigne SA partie, alors que les DONNÉES du calendrier n'appartiennent qu'à
    // agenda_view. Un gestionnaire entrait donc légitimement, puis se faisait refuser
    // deux appels qu'on n'aurait jamais dû lancer pour lui.
    //
    // Le test mesure la seule chose qui compte pour l'utilisateur : zéro notification
    // d'erreur, et le tableau des missions bien présent.
    test.skip(!jetonPresent('SANS_PERM'), 'Jeton A6_TOKEN_SANS_PERM manquant');
    await ouvrirSession(page, 'SANS_PERM');

    const refus: number[] = [];
    page.on('response', (r) => {
      if (r.status() === 403 && r.url().includes('/api/agenda/')) refus.push(r.status());
    });

    await page.goto('/agenda');
    await expect(page.getByRole('button', { name: /Nouvelle mission/i })).toBeVisible({
      timeout: 15_000,
    });

    // Le tableau des missions est là — c'est pour lui que ce compte vient.
    //
    // ⚠️ ON VISE LE PANNEAU, PAS SON CONTENU. Ce compte appartient à une autre flotte,
    // qui n'a aucune mission : exiger une carte ferait échouer le test sur un écran
    // parfaitement correct, qui affiche « Aucune mission créée pour l'instant ». Ce
    // qu'on vérifie ici, c'est que le compte ATTERRIT sur ses missions — pas qu'il en a.
    await expect(page.locator('.mp-kpis')).toBeVisible({ timeout: 15_000 });

    // Et rien ne hurle : ni au réseau, ni à l'écran.
    expect(refus, `${refus.length} appel(s) agenda refusé(s) en 403`).toEqual([]);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText('Permission requise')).toHaveCount(0);

    // Les compteurs et les échéances du calendrier ne sont pas affichés à zéro : la
    // flotte en a peut-être trente, ce compte n'a simplement pas le droit de les lire.
    await expect(page.locator('.ag-summary')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: /À venir & en retard/ })).toHaveCount(0);

    await controlesDeBase(page, 'Agenda · sans agenda_view');
    await capture(page, 'e2e-captures/7e-agenda-sans-permission-375.png');
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
