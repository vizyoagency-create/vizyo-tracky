import { TripAnalysisBadgesComponent } from './trip-analysis-badges.component';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * « ÇA OUVRE LE RAPPORT ET IL N'Y A PAS DE CROIX POUR FERMER » — SIGNALÉ DEPUIS UN IPHONE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le clic sur une notification d'excès de vitesse ouvre la fiche du véhicule avec
 * `?tab=reports&trip=…&alert=…`, et cette adresse ouvre TOUTE SEULE l'analyse du trajet
 * (`autoOpen`). C'est voulu : on vient lire ce trajet-là.
 *
 * Ce qui ne l'est pas, c'est de ne plus pouvoir en sortir. En application installée sur
 * iPhone il n'y a NI barre d'adresse NI bouton retour : si la croix n'est pas atteignable, la
 * seule issue est de tuer l'application.
 *
 * Deux mécanismes pouvaient produire exactement ce symptôme, et ce fichier tient le premier —
 * le seul qui soit vérifiable sans appareil :
 *
 *   1. LA FEUILLE SANS PLAFOND. Elle est ancrée en bas (`align-items: flex-end`), donc sa
 *      croix est en haut de la carte. `max-height: 92dvh` était sa SEULE limite : sur un
 *      Safari antérieur à 15.4, l'unité `dvh` n'existe pas, la déclaration est invalide donc
 *      ignorée, et il ne reste aucun plafond. La carte prend alors la hauteur de son contenu
 *      — un récit de vingt lignes — et sa croix sort par le haut du cadre.
 *   2. LE LIEN PROFOND QUI PERSISTE dans l'adresse : fermer, puis tirer l'écran vers le bas
 *      pour rafraîchir, rouvrait la feuille. Tenu côté fiche véhicule.
 *
 * ⚠️ CE TEST LIT LES STYLES COMPILÉS, comme `cascade-css.spec.ts` : le défaut ne vit ni dans
 * un signal ni dans un gabarit, mais dans l'ORDRE et la PRÉSENCE de deux déclarations CSS.
 */
function stylesDuComposant(): string {
  const def = (TripAnalysisBadgesComponent as unknown as { ɵcmp?: { styles?: string[] } }).ɵcmp;
  const styles = def?.styles;
  if (!styles || styles.length === 0) {
    throw new Error(
      'Styles introuvables (ɵcmp.styles). Ce test lit la sortie du compilateur : si Angular '
      + "change cette forme, il faut l'adapter — ne le supprimez pas, il tient un défaut que "
      + "rien d'autre ne tient.",
    );
  }
  return styles.join('\n').replace(/\[_ngcontent-[^\]]*\]/g, '');
}

describe('Analyse du trajet — la feuille reste fermable, même sans unité « dvh »', () => {
  let css: string;

  beforeAll(() => { css = stylesDuComposant(); });

  it('la carte a un plafond de hauteur en « vh », lisible par TOUS les navigateurs', () => {
    // Sans ce repli, un Safari sans `dvh` laisse la carte grandir avec son contenu.
    expect(/\.taid-card\s*\{[^}]*max-height:\s*92vh/.test(css)).toBeTrue();
  });

  it('… et le repli est déclaré AVANT « dvh », sinon il gagnerait partout', () => {
    /**
     * ⚠️ L'ORDRE EST LA CORRECTION. Les deux déclarations portent le MÊME sélecteur et la
     * même propriété : c'est la dernière que le navigateur COMPREND qui l'emporte. En les
     * inversant, `92vh` gagnerait sur les navigateurs modernes — et `vh` ignore les barres
     * d'outils mobiles, donc la feuille dépasserait à nouveau, exactement là où elle ne le
     * fait plus.
     */
    const bloc = /\.taid-card\s*\{([^}]*)\}/.exec(css);
    expect(bloc).not.toBeNull();
    const declarations = bloc![1]!;
    const iVh = declarations.indexOf('max-height: 92vh');
    const iDvh = declarations.indexOf('max-height: 92dvh');

    expect(iVh).toBeGreaterThan(-1);
    expect(iDvh).toBeGreaterThan(-1);
    expect(iDvh).toBeGreaterThan(iVh);
  });

  it('la carte réserve la zone sûre du haut — la barre d’état iOS est translucide', () => {
    // `apple-mobile-web-app-status-bar-style: black-translucent` (index.html) fait passer le
    // contenu SOUS l'heure et la batterie. Mesuré à 375 x 812 : la croix tombait à 72 px du
    // haut, soit 13 px sous l'îlot dynamique d'un iPhone récent.
    expect(/\.taid-card\s*\{[^}]*padding-top:\s*env\(safe-area-inset-top\)/.test(css)).toBeTrue();
  });

  it('la croix existe, porte un nom accessible, et fait 44 px', () => {
    // Le geste de secours (fond cliquable, touche Échap) ne remplace pas un bouton : sur un
    // téléphone il n'y a pas d'Échap, et le fond est presque entièrement couvert par la carte.
    expect(/\.taid-x\s*\{[^}]*width:\s*44px/.test(css)).toBeTrue();
    expect(/\.taid-x\s*\{[^}]*height:\s*44px/.test(css)).toBeTrue();
  });
});
