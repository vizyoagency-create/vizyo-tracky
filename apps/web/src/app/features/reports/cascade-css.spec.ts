import { ReportsComponent } from './reports.component';
import { TripReplayComponent } from './trip-replay.component';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * L'ORDRE DES RÈGLES CSS — LA SEULE CHOSE QUI TRANCHE ENTRE DEUX MEDIA QUERIES
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ce fichier n'existe pas par goût du test exhaustif : il répare un mode de panne qui a été
 * livré DEUX FOIS sur ce chantier, et que ni la relecture de code, ni la suite, ni le
 * `ng build` n'attrapent.
 *
 *   1. `.rep-vfiltre { min-height: 44px }` — écrit, commenté, correct… et posé AVANT la
 *      déclaration de base `min-height: 32px`. Le bouton est resté à 32 px au doigt pendant
 *      toute une passe, sur toute la bande 481–768 px.
 *   2. `.rep-vt-hide { display: block !important }` du bloc `@media print` — écrasé par un
 *      bloc `≤ 1000 px` posé 600 lignes plus bas. En A4 portrait (794 px), la colonne
 *      revenait cachée : l'en-tête déclarait 6 pistes pour 4 cellules, et l'impression
 *      sortait avec une colonne morte.
 *
 * ⚠️ POURQUOI CE TEST-LÀ, ET PAS UNE MESURE. Le harnais Karma ne sait pas imposer une
 * largeur de fenêtre à un composant monté : la seule vérification possible en suite est
 * celle de la CAUSE, pas du symptôme. Or la cause est exactement celle-ci — **une media
 * query n'ajoute AUCUNE spécificité**. À sélecteur égal, seul l'ordre d'apparition décide.
 * Une règle d'override posée avant sa base est donc inerte, silencieusement, pour toujours.
 *
 * Ce que ce fichier NE dit pas : que le rendu est joli, ni que 44 px est le bon chiffre.
 * Il dit qu'aucune des trois règles d'override ne peut retourner au-dessus de sa base sans
 * qu'un test rougisse. Les mesures, elles, ont été prises au navigateur sur le CSS réel issu
 * du build (375 / 481 / 700 / 769 px, et 794 / 717 / 1122 px en `media=print`).
 */

/**
 * Les styles RÉELLEMENT compilés dans le composant, dans leur ordre d'émission — c'est-à-dire
 * ce que le navigateur recevra, et non ce que le fichier source donne à lire.
 *
 * ⚠️ Les sélecteurs d'encapsulation (`[_ngcontent-ng-c123456]`) sont retirés : ils ne changent
 * rien à l'ordre, ils sont identiques pour toutes les règles du composant, et leur suffixe
 * varie à chaque compilation. Les garder rendrait ce test illisible et cassant.
 */
function stylesDuComposant(composant: unknown = ReportsComponent): string {
  const def = (composant as { ɵcmp?: { styles?: string[] } }).ɵcmp;
  const styles = def?.styles;
  if (!styles || styles.length === 0) {
    throw new Error(
      'Styles du composant introuvables (ɵcmp.styles). Ce test lit la sortie du compilateur : '
      + "si Angular change cette forme, il faut l'adapter — ne le supprimez pas, il tient un "
      + "défaut que rien d'autre ne tient.",
    );
  }
  return styles.join('\n').replace(/\[_ngcontent-[^\]]*\]/g, '');
}

/**
 * Position de la Nième occurrence d'un motif, ou -1. On travaille sur des index de chaîne :
 * c'est grossier, mais c'est EXACTEMENT la grandeur qui décide dans une feuille de style.
 */
function positionDe(css: string, motif: RegExp): number {
  const m = motif.exec(css);
  return m ? m.index : -1;
}

describe('Page Rapports — l’ordre des règles CSS, que rien d’autre ne tient', () => {
  let css: string;

  beforeAll(() => { css = stylesDuComposant(); });

  it('la hauteur au doigt du bouton « Filtrer » est déclarée APRÈS sa base', () => {
    // Base : `.rep-vfiltre { min-height: 32px; … }` — la valeur souris.
    const base = positionDe(css, /\.rep-vfiltre\s*\{[^}]*min-height:\s*32px/);
    // Override : `.rep-vgo, .rep-vfiltre { min-height: 44px }` dans une media query.
    const override = positionDe(css, /\.rep-vfiltre\s*\{\s*min-height:\s*44px/);

    expect(base).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(base);
  });

  it('la hauteur au doigt de la bascule de vue est déclarée APRÈS sa base', () => {
    const base = positionDe(css, /\.rep-vseg-btn\s*\{[^}]*min-height:\s*34px/);
    const override = positionDe(css, /\.rep-vseg-btn\s*\{\s*min-height:\s*44px/);

    expect(base).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(base);
  });

  it('le retour des colonnes à l’impression est déclaré APRÈS le masquage responsive', () => {
    // Le masquage sous 1000 px, celui qui écrasait la règle d'impression.
    const masquage = positionDe(css, /\.rep-vt-hide\s*\{\s*display:\s*none/);
    // Le retour à l'impression, qui doit gagner en A4 portrait (794 px de large).
    const impression = positionDe(css, /\.rep-vt-hide\s*\{\s*display:\s*block/);

    expect(masquage).toBeGreaterThan(-1);
    expect(impression).toBeGreaterThan(-1);
    expect(impression).toBeGreaterThan(masquage);
  });

  it('les 44 px au doigt de « Reprendre » / « Ignorer » sont déclarés APRÈS leur base', () => {
    // Relevé à 320 px : ces deux boutons rendaient 32 px. Ce sont les actions d'une
    // proposition qui POSE un filtre — les rater fait recharger le mauvais rapport. La règle
    // ne pouvait pas rejoindre le bloc des cibles tactiles, déclaré plus haut que leur base.
    const base = positionDe(css, /\.rep-reprise-oui,\s*\.rep-reprise-non\s*\{[^}]*min-height:\s*32px/);
    const override = positionDe(css, /\.rep-reprise-oui,\s*\.rep-reprise-non\s*\{\s*min-height:\s*44px/);

    expect(base).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(base);
  });

  it('la rangée unique sous 360 px est déclarée APRÈS la demi-rangée de 640 px', () => {
    // À 320 px, la moitié de la barre ne laisse que 86 px de libellé : « Sohaib Hamanni »
    // en réclame 101. Les deux règles portent le MÊME sélecteur — si la seconde passait
    // devant, la première gagnerait et le nom du conducteur retomberait tronqué.
    const demi = positionDe(css, /\.rep-selectors\s+\.rep-dropdown-wrapper\s*\{\s*flex-basis:\s*calc\(50%/);
    const pleine = positionDe(css, /\.rep-selectors\s+\.rep-dropdown-wrapper\s*\{\s*flex-basis:\s*100%/);

    expect(demi).toBeGreaterThan(-1);
    expect(pleine).toBeGreaterThan(-1);
    expect(pleine).toBeGreaterThan(demi);
  });

  it('aucune de ces trois règles n’a été dupliquée en chemin', () => {
    // Un doublon rendrait les assertions ci-dessus ambiguës : `positionDe` lit la PREMIÈRE
    // occurrence, et deux bases dont l'une suit l'override feraient passer un test faux.
    const compte = (motif: RegExp) => (css.match(motif) || []).length;

    expect(compte(/\.rep-vfiltre\s*\{\s*min-height:\s*44px/g)).toBe(1);
    expect(compte(/\.rep-vseg-btn\s*\{\s*min-height:\s*44px/g)).toBe(1);
    expect(compte(/\.rep-vt-hide\s*\{\s*display:\s*block/g)).toBe(1);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * MÊME PIÈGE, AUTRE ÉCRAN — LE REPLAY DE TRAJET
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Sous 1024 px, c'est le CORPS du replay qui défile, et non plus le panneau : sur un écran de
 * 812 px de haut, la carte (260 px de plancher) et le panneau ne tiennent pas ensemble dans
 * les 294 px que l'en-tête et la barre de lecture laissent — mesuré en production le
 * 2026-09-06, le panneau recevait 33 px pour 590 px de contenu.
 *
 * Les trois règles de ce basculement portent des sélecteurs IDENTIQUES à leurs bases. Posées
 * avant elles, elles seraient inertes — sans erreur, sans avertissement, et le panneau
 * retomberait à sa fente de 33 px.
 */
describe('Replay de trajet — l’ordre des règles CSS du basculement mobile', () => {
  let css: string;

  beforeAll(() => { css = stylesDuComposant(TripReplayComponent); });

  it('le défilement du corps est déclaré APRÈS la base de `.tr-corps`', () => {
    const base = positionDe(css, /\.tr-corps\s*\{[^}]*flex:\s*1/);
    const override = positionDe(css, /\.tr-corps\s*\{\s*overflow-y:\s*auto/);

    expect(base).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(-1);
    expect(override).toBeGreaterThan(base);
  });

  it('la levée du plafond du panneau est déclarée APRÈS ce plafond', () => {
    // `max-height: 42%` PLAFONNE le panneau, il ne lui réserve rien : c'est ce malentendu
    // qui a laissé la carte le réduire à 33 px. Sous 1024 px on le lève, et il faut que
    // cette levée gagne.
    const plafond = positionDe(css, /\.tr-aside\s*\{[^}]*max-height:\s*42%/);
    const levee = positionDe(css, /\.tr-aside\s*\{\s*max-height:\s*none/);

    expect(plafond).toBeGreaterThan(-1);
    expect(levee).toBeGreaterThan(-1);
    expect(levee).toBeGreaterThan(plafond);
  });

  it('le retrait du défilement intérieur est déclaré APRÈS ce défilement', () => {
    // Deux zones défilantes emboîtées : le doigt ne sait plus laquelle il déplace.
    const interieur = positionDe(css, /\.tr-aside-scroll\s*\{\s*overflow-y:\s*auto/);
    const retrait = positionDe(css, /\.tr-aside-scroll\s*\{\s*overflow-y:\s*visible/);

    expect(interieur).toBeGreaterThan(-1);
    expect(retrait).toBeGreaterThan(-1);
    expect(retrait).toBeGreaterThan(interieur);
  });

  it('la frise distingue la pointe de l’excès — deux couleurs, deux hauteurs', () => {
    // ⚠️ La distinction tient à CES DEUX RÈGLES. Sans la seconde, `.tr-marque[data-type]`
    // retombe sur la base grise ; avec une seule couleur, six traits identiques annoncent six
    // fautes là où l'en-tête en compte une.
    // ⚠️ Les guillemets de l'attribut sont OPTIONNELS dans le CSS émis : le compilateur
    // normalise `[data-type="exces"]` en `[data-type=exces]`. Un motif qui les exige ne
    // trouve rien — et un test qui ne trouve rien ne garde rien.
    const marque = (type: string, jeton: string) =>
      new RegExp('\\.tr-marque\\[data-type="?' + type + '"?\\]\\s*i\\s*\\{[^}]*' + jeton);
    const exces = positionDe(css, marque('exces', '--texte-alerte'));
    const pointe = positionDe(css, marque('pointe', '--texte-orange'));

    expect(exces).toBeGreaterThan(-1);
    expect(pointe).toBeGreaterThan(-1);
    // Et des hauteurs différentes : la couleur seule ne suffit pas à un daltonien deutan.
    expect(marque('exces', 'height:\\s*20px').test(css)).toBeTrue();
    expect(marque('pointe', 'height:\\s*13px').test(css)).toBeTrue();
  });
});

