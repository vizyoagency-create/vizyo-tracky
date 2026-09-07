/**
 * Reprise de la carte après le RETOUR du contexte WebGL.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CE QUE MAPLIBRE 5.24 FAIT, LU DANS `src/ui/map.ts` ET MESURÉ LE 2026-09-07  │
 * │                                                                            │
 * │ À la perte, il SÉRIALISE le style courant — nos sources et nos couches     │
 * │ comprises, avec leurs données — puis le détruit (`style = null`).          │
 * │ Au retour, il rejoue cette sauvegarde par `setStyle(…, {diff: false})` :   │
 * │ un objet `Style` neuf est créé tout de suite, mais son chargement attend   │
 * │ un `requestAnimationFrame`. Ce n'est qu'à ce moment-là que `styledata`     │
 * │ arrive et que nos sources existent de nouveau. Puis seulement il émet      │
 * │ `webglcontextrestored`.                                                    │
 * │                                                                            │
 * │ ⚠️ LA SAUVEGARDE EST VIDE SI LE STYLE N'ÉTAIT PAS CHARGÉ à la perte        │
 * │ (changement de fond en cours, onglet à peine ouvert). MapLibre ne restaure │
 * │ alors RIEN : `map.style` reste nul, aucun `styledata` ne viendra jamais.   │
 * │ Mesuré : carte noire, marqueurs orphelins, et — avec l'ancien code — plus  │
 * │ aucun bandeau pour le dire.                                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Pourquoi une fonction à part : le composant carte injecte vingt services et ne se
 * monte pas dans un test unitaire. Ici, une fausse carte de trois membres suffit à
 * prouver la séquence — et c'est la séquence qui était fausse, pas les couches.
 */

/** Ce qu'il faut lire sur la carte pour décider. Pas MapLibre entier : trois membres. */
export interface CarteReprise {
  /** `map.style` — MapLibre le laisse à `null` quand il n'a rien pu sauvegarder. */
  readonly style: unknown;
  /** `undefined` sans style, sinon l'état réel du chargement. */
  isStyleLoaded(): boolean | void;
  once(type: 'styledata', ecouteur: () => void): unknown;
}

export interface ActionsReprise {
  /** Réapplique le fond de carte courant — déclenche un `styledata` à son chargement. */
  reappliquerFond(): void;
  /** Baisse le drapeau d'interruption : le bandeau se retire, les gardes rouvrent. */
  leverInterruption(): void;
  /** Recrée les sources manquantes et repeuple tout. Exige le drapeau baissé. */
  reconstruire(): void;
}

export type IssueReprise = 'immediate' | 'apres-styledata' | 'fond-reapplique';

export function reprendreApresContexte(carte: CarteReprise, actions: ActionsReprise): IssueReprise {
  // ⚠️ Le drapeau ne se baisse QU'ICI, juste avant de reconstruire — jamais à l'événement de
  // retour. Entre les deux, le style existe mais n'a ni source ni couche : chaque garde doit
  // rester fermée, et le bandeau doit rester à l'écran. Et il se baisse AVANT la reconstruction,
  // parce que `recreerCouches()` passe par la garde qu'il pilote.
  const reconstruire = () => {
    actions.leverInterruption();
    actions.reconstruire();
  };

  if (!carte.style) {
    // Sauvegarde vide : MapLibre n'a rien rejoué. Personne d'autre ne relancera un style —
    // on repose le fond courant, et on attend SON chargement. L'écouteur est posé d'abord.
    carte.once('styledata', reconstruire);
    actions.reappliquerFond();
    return 'fond-reapplique';
  }

  // `isStyleLoaded()` rend `undefined` sans style (cas traité au-dessus) : on exige `true`.
  if (carte.isStyleLoaded() === true) {
    reconstruire();
    return 'immediate';
  }

  carte.once('styledata', reconstruire);
  return 'apres-styledata';
}
