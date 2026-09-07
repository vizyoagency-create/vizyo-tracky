import { ReportsComponent } from './reports.component';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * DEUX DÉFAUTS MESURÉS EN PRODUCTION LE 2026-09-07, SUR UN ÉCRAN DE BUREAU ORDINAIRE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * 1. LE CHIFFRE DES CARTES KPI ÉTAIT TRONQUÉ. À 1440 px : `1221` s'affichait « 1… »,
 *    `19 016,1 km` s'affichait « 19 0… », `585h38` s'affichait « 58… ». Un lecteur y voit
 *    1 trajet au lieu de 1221 et 19 km au lieu de 19 016 — une carte de KPI qui ment sur son
 *    KPI. La protection existait déjà mais était enfermée dans `@media (max-width: 480px)`,
 *    alors que la grille passe à 2 colonnes jusqu'à 1023 px puis à QUATRE au-delà : les cartes
 *    redeviennent étroites précisément sur les écrans d'ordinateur. Le téléphone était le seul
 *    endroit protégé. Mesures : 375 px aucune troncature, 482 px trois, 768 px une, 1280 px
 *    trois, 1440 px trois, 1920 px aucune.
 *
 * 2. LES TROIS FILTRES SE RECOUVRAIENT. Enveloppes mesurées à 90 px pour des boutons de
 *    180 px ; quatre recouvrements confirmés par test de touche, « Tous les conducteurs »
 *    couvrant les deux autres filtres ET les puces « Aujourd'hui » et « 7 jours ». Cliquer une
 *    période dans cette zone atteignait le mauvais contrôle — un défaut fonctionnel.
 *
 * ⚠️ POURQUOI CE TEST-LÀ, ET PAS UNE MESURE : Karma ne sait pas imposer une largeur de fenêtre
 * à un composant monté. Même raisonnement — et même harnais — que `cascade-css.spec.ts`, qui
 * documente ce mode de panne déjà livré deux fois sur ce dépôt : on vérifie la CAUSE dans le
 * CSS réellement compilé, pas le symptôme au pixel. Les mesures, elles, ont été prises au
 * navigateur sur la production.
 */

/**
 * Les styles RÉELLEMENT compilés dans le composant — ce que le navigateur recevra, et non ce
 * que le fichier source donne à lire. Les sélecteurs d'encapsulation sont retirés : ils sont
 * identiques pour toutes les règles et leur suffixe change à chaque compilation.
 */
function stylesDuComposant(): string {
  const styles = (ReportsComponent as { ɵcmp?: { styles?: string[] } }).ɵcmp?.styles;
  if (!styles || styles.length === 0) {
    throw new Error(
      'Styles du composant introuvables (ɵcmp.styles). Ce test lit la sortie du compilateur : '
      + "si Angular change cette forme, il faut l'adapter — ne le supprimez pas, il tient deux "
      + 'défauts que rien d\'autre ne tient.',
    );
  }
  return styles.join('\n').replace(/\[_ngcontent-[^\]]*\]/g, '');
}

/**
 * Le corps de chaque règle visant ce sélecteur, dans l'ordre d'émission.
 *
 * ⚠️ L'ESPACE DU COMBINATEUR EST SOUPLE. Retirer les attributs d'encapsulation laisse des
 * espaces multiples : le compilateur émet « .rep-selectors   .rep-dropdown-wrapper ». Exiger
 * une espace unique faisait échouer la recherche et ce fichier serait passé à côté du défaut
 * qu'il est censé tenir.
 */
function reglesDe(css: string, selecteur: string): { corps: string; position: number }[] {
  const out: { corps: string; position: number }[] = [];
  const motif = new RegExp(
    selecteur.trim().split(/\s+/).map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+')
      + '\\s*\\{([^}]*)\\}',
    'g',
  );
  let m: RegExpExecArray | null;
  while ((m = motif.exec(css)) !== null) out.push({ corps: m[1]!, position: m.index });
  return out;
}

describe('Rapports — le chiffre d’une carte KPI ne se tronque jamais', () => {
  const css = stylesDuComposant();

  it('le harnais lit bien le CSS compilé — sinon tout ce fichier serait vide de sens', () => {
    // Le témoin : sans lui, les tests ci-dessous passeraient par vacuité si `ɵcmp.styles`
    // changeait de forme et revenait vide.
    expect(css.length).toBeGreaterThan(5000);
    expect(reglesDe(css, '.rep-kpi-value').length).toBeGreaterThan(0);
  });

  /**
   * 🔴 LE TEST DE RÉGRESSION. `text-overflow: ellipsis` sur la valeur EST le défaut : c'est
   * lui qui transforme 1221 en « 1… ».
   */
  it('🔴 aucune règle de `.rep-kpi-value` ne demande d’ellipse', () => {
    const fautives = reglesDe(css, '.rep-kpi-value').filter((r) => /text-overflow:\s*ellipsis/.test(r.corps));

    expect(fautives.length)
      .withContext('une ellipse sur le chiffre le rend illisible : « 19 0… » pour 19 016,1 km')
      .toBe(0);
  });

  it('la valeur déborde visiblement plutôt que d’être rognée', () => {
    const base = reglesDe(css, '.rep-kpi-value')[0]!;

    expect(base.corps).toMatch(/overflow:\s*visible/);
    expect(base.corps).toMatch(/text-overflow:\s*clip/);
  });

  /**
   * ⚠️ C'EST LA COURBE QUI CÈDE, PAS LE CHIFFRE. Sans `flex-wrap` sur la ligne, un chiffre qui
   * refuse de rétrécir pousserait la courbe hors de la carte au lieu de la faire descendre.
   * La règle doit être à la BASE : c'est précisément son enfermement dans le média téléphone
   * qui a produit le défaut.
   */
  it('la ligne passe à la ligne à TOUTES les largeurs, pas seulement sur téléphone', () => {
    const base = reglesDe(css, '.rep-kpi-body')[0]!;

    expect(base.corps).toMatch(/flex-wrap:\s*wrap/);
    // Et la règle de base précède tout média : rien ne peut la réintroduire trop tard.
    expect(base.position).toBeLessThan(css.indexOf('max-width: 480px'));
  });
});

describe('Rapports — les trois filtres ne se recouvrent pas', () => {
  const css = stylesDuComposant();

  /**
   * 🔴 LE TEST DE RÉGRESSION, ET C'EST UN TEST D'ORDRE.
   *
   * La règle mobile `.rep-selectors .rep-dropdown-wrapper { flex: 1; min-width: 0 }` est une
   * règle de BASE (mobile d'abord) : elle s'applique aussi sur bureau, où `.rep-selectors`
   * passe en `display: contents` et où ses enveloppes deviennent des éléments flexibles de
   * `.rep-filters`. Comprimées à 90 px, elles portaient des boutons de 180 px qui débordaient.
   *
   * ⚠️ Les deux sélecteurs ont la MÊME spécificité (deux classes) et une media query n'en
   * ajoute AUCUNE : seul l'ordre d'apparition tranche. Une correction posée avant sa base
   * serait inerte — silencieusement, pour toujours. C'est le mode de panne que
   * `cascade-css.spec.ts` documente, livré deux fois sur ce dépôt.
   */
  it('🔴 l’override bureau existe, et il est écrit APRÈS la règle mobile', () => {
    const regles = reglesDe(css, '.rep-selectors .rep-dropdown-wrapper');

    expect(regles.length)
      .withContext('il faut la règle mobile ET son override bureau')
      .toBeGreaterThanOrEqual(2);

    const mobile = regles.find((r) => /flex:\s*1\b/.test(r.corps));
    const bureau = regles.find((r) => /flex:\s*0\s+0\s+auto/.test(r.corps));

    expect(mobile).withContext('la règle mobile `flex: 1` doit rester : elle sert sous 641 px').toBeDefined();
    expect(bureau).withContext('sans `flex: 0 0 auto`, l’enveloppe est comprimée sous son bouton').toBeDefined();
    expect(bureau!.position).toBeGreaterThan(mobile!.position);
  });

  it('l’override vit bien dans le bloc ≥ 641 px, là où `display: contents` s’applique', () => {
    const bloc = css.indexOf('min-width: 641px');
    const bureau = reglesDe(css, '.rep-selectors .rep-dropdown-wrapper')
      .find((r) => /flex:\s*0\s+0\s+auto/.test(r.corps));

    expect(bloc).toBeGreaterThan(-1);
    expect(bureau!.position).toBeGreaterThan(bloc);
  });

  /**
   * Le bouton garde son plancher de 180 px — c'est lui qui rend le libellé lisible. Le test
   * existe pour empêcher la « correction » symétrique et tentante : rabaisser le bouton au
   * lieu de rendre sa largeur à l'enveloppe, ce qui ramènerait les libellés à « Tous… ».
   */
  it('le bouton conserve son plancher de largeur', () => {
    expect(reglesDe(css, '.rep-dropdown-trigger')[0]!.corps).toMatch(/min-width:\s*180px/);
  });
});
