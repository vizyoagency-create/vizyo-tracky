/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UN MARQUEUR DE CARTE N'EST PAS UN BOUTON — MÊME QUAND MAPLIBRE LE DIT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * MapLibre 5 pose `role="button"` sur CHAQUE marqueur, pour l'accessibilité. Or la feuille
 * globale impose `min-height: 44px` et `display: inline-flex` à tout ce qui porte ce rôle —
 * la règle des cibles tactiles, sous 768 px.
 *
 * ── CE QUE ÇA DONNAIT, MESURÉ ────────────────────────────────────────────────────────────
 *
 * Un rond de 14 px devenait une ELLIPSE de 14 × 44, décalée de la coordonnée qu'il désigne.
 * Signalé par le propriétaire — « les icônes sont bizarres, c'est pareil dans toutes les
 * cartes » — et retrouvé sur trois surfaces : le partage public de trajet, le suivi public de
 * livraison (`.ptm-pin`, 34 px) et la carte du dépôt.
 *
 * ── POURQUOI L'EXCEPTION EXISTAIT DÉJÀ, ET RATAIT QUAND MÊME ─────────────────────────────
 *
 * Elle listait `.hm-cell` et `.tracky-marker` — une LISTE DE NOMS, exactement ce que le
 * commentaire de la règle reproche à la version qu'il remplaçait : « une liste de noms ne
 * peut pas suivre une application qui grandit ». Elle n'a pas suivi. `.maplibregl-marker` est
 * posée par MapLibre LUI-MÊME : c'est la seule accroche qui couvre les marqueurs à venir.
 *
 * ⚠️ CE FICHIER LIT LA VRAIE FEUILLE. `angular.json` charge `src/styles.css` dans le banc de
 * test : les règles inspectées ici sont celles qui partent en production, pas une recopie.
 */

/** Une règle de la feuille globale, avec le média qui la conditionne. */
interface Regle {
  selecteur: string;
  style: CSSStyleDeclaration;
  media: string;
  /** Position dans l'ordre d'émission — à sélecteur égal, seul l'ordre tranche. */
  rang: number;
}

/** Toutes les règles des feuilles accessibles, à plat, dans l'ordre. */
function reglesGlobales(): Regle[] {
  const out: Regle[] = [];
  let rang = 0;
  const parcourir = (liste: CSSRuleList, media: string): void => {
    for (const r of Array.from(liste)) {
      const groupe = r as CSSMediaRule;
      if (groupe.cssRules && groupe.conditionText !== undefined) {
        parcourir(groupe.cssRules, groupe.conditionText);
        continue;
      }
      const style = r as CSSStyleRule;
      if (!style.selectorText) continue;
      out.push({ selecteur: style.selectorText, style: style.style, media, rang: rang++ });
    }
  };
  for (const feuille of Array.from(document.styleSheets)) {
    try {
      parcourir(feuille.cssRules, '');
    } catch {
      // Feuille d'une autre origine : illisible, et sans intérêt ici.
    }
  }
  return out;
}

/** Un marqueur MapLibre tel que la bibliothèque le construit : notre div, plus SON rôle. */
function marqueurMapLibre(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'maplibregl-marker maplibregl-marker-anchor-center';
  el.setAttribute('role', 'button');
  return el;
}

/** Les règles qui s'appliquent à cet élément, sous le média des cibles tactiles. */
function reglesTactilesPour(el: HTMLElement): Regle[] {
  return reglesGlobales().filter((r) => {
    if (!r.media.includes('768px')) return false;
    try { return el.matches(r.selecteur); } catch { return false; }
  });
}

describe('Cibles tactiles — un marqueur de carte échappe au seuil de 44 px', () => {
  it('le banc charge bien la feuille globale — sinon tout ce fichier serait vide de sens', () => {
    // Le témoin. Sans lui, les tests ci-dessous passeraient par vacuité le jour où
    // `angular.json` cesserait d'inclure `styles.css`.
    expect(reglesGlobales().length).toBeGreaterThan(50);
  });

  /**
   * Le PROBLÈME, énoncé : la règle des cibles tactiles vise bien nos marqueurs. Si elle
   * cessait de les viser, l'exception ci-dessous deviendrait inutile — et ce test le dirait.
   */
  it('la règle des 44 px vise bien un élément portant `role="button"`', () => {
    const contraint = reglesTactilesPour(marqueurMapLibre())
      .filter((r) => r.style.getPropertyValue('min-height') === '44px');

    expect(contraint.length).toBeGreaterThan(0);
  });

  /**
   * 🔴 LE TEST DE RÉGRESSION. Sans l'exception, tout marqueur plus petit que 44 px est étiré
   * en hauteur sous 768 px — donc décalé de la coordonnée qu'il désigne.
   */
  it('🔴 une exception le relâche, et elle vise la classe posée par MapLibre', () => {
    const relache = reglesTactilesPour(marqueurMapLibre())
      .filter((r) => r.style.getPropertyValue('min-height') === '0px'
        || r.style.getPropertyValue('min-height') === '0');

    expect(relache.length).toBeGreaterThan(0);
    expect(relache.some((r) => r.selecteur.includes('.maplibregl-marker'))).toBe(true);
  });

  /**
   * ⚠️ L'ORDRE, PAS SEULEMENT LA PRÉSENCE. Une media query n'ajoute AUCUNE spécificité : à
   * sélecteur de force égale, seul l'ordre d'apparition tranche. Une exception posée AVANT sa
   * règle serait inerte — silencieusement, pour toujours. C'est le mode de panne que
   * `cascade-css.spec.ts` documente, livré deux fois sur ce dépôt.
   */
  it('l’exception est écrite APRÈS la règle qu’elle relâche', () => {
    const regles = reglesTactilesPour(marqueurMapLibre());
    const contrainte = Math.min(...regles
      .filter((r) => r.style.getPropertyValue('min-height') === '44px').map((r) => r.rang));
    const exception = Math.max(...regles
      .filter((r) => r.style.getPropertyValue('min-height').startsWith('0')).map((r) => r.rang));

    expect(exception).toBeGreaterThan(contrainte);
  });

  /**
   * La règle ne fait pas que grandir : elle recompose en `inline-flex` pour recentrer le
   * contenu d'un bouton agrandi. Sur un marqueur composé (pastille, plaque, halo), cela
   * déplace la pastille dans sa propre boîte.
   */
  it('le `display` imposé est relâché lui aussi', () => {
    const regles = reglesTactilesPour(marqueurMapLibre());

    expect(regles.some((r) => r.style.getPropertyValue('display') === 'inline-flex')).toBe(true);
    expect(regles.some((r) => r.style.getPropertyValue('display') === 'revert')).toBe(true);
  });

  /**
   * ⚠️ LES DESCENDANTS AUSSI. Le marqueur de véhicule du produit est composé ; ses enfants
   * porteraient sinon la recomposition en flex sans le marqueur lui-même.
   */
  it('les enfants d’un marqueur sont couverts', () => {
    const enfant = document.createElement('span');
    const parent = marqueurMapLibre();
    parent.appendChild(enfant);
    document.body.appendChild(parent);
    try {
      const relache = reglesGlobales()
        .filter((r) => r.media.includes('768px'))
        .filter((r) => { try { return enfant.matches(r.selecteur); } catch { return false; } })
        .filter((r) => r.style.getPropertyValue('min-height').startsWith('0'));

      expect(relache.length).toBeGreaterThan(0);
    } finally {
      parent.remove();
    }
  });

  /**
   * ⚠️ LES EXCEPTIONS D'ORIGINE RESTENT. `.hm-cell` n'est pas un marqueur MapLibre : la
   * retirer en croyant que la nouvelle accroche la couvre casserait la carte de chaleur.
   */
  it('la carte de chaleur garde la sienne', () => {
    const cellule = document.createElement('div');
    cellule.className = 'hm-cell';
    const relache = reglesGlobales()
      .filter((r) => r.media.includes('768px'))
      .filter((r) => { try { return cellule.matches(r.selecteur); } catch { return false; } })
      .filter((r) => r.style.getPropertyValue('min-height').startsWith('0'));

    expect(relache.length).toBeGreaterThan(0);
  });
});
