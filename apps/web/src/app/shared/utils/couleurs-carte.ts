/**
 * Couleurs des COUCHES DE CARTE — la seule exception assumée à la règle « aucune
 * couleur en dur » du socle (`design/B0-SOCLE.md` § « Couleurs en dur »).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ POURQUOI CELLES-CI NE DEVIENNENT PAS DES JETONS                            │
 * │                                                                            │
 * │ Les chips, les légendes et le reste de l'habillage se posent sur les        │
 * │ SURFACES DE L'APPLICATION : ils doivent suivre son thème, et ils le font.   │
 * │                                                                            │
 * │ Ces valeurs-là se posent sur le FOND DE CARTE, qui n'est pas le thème. Le   │
 * │ fond est un choix séparé de l'utilisateur (`MapStyleService` : clair,       │
 * │ sombre, satellite, terrain). Quelqu'un en thème CLAIR peut afficher un fond │
 * │ SATELLITE : un tracé lu depuis `--texte-succes` y deviendrait un vert foncé │
 * │ sur une forêt sombre, illisible — le contraire de ce qu'on cherchait.       │
 * │                                                                            │
 * │ Accessoirement, MapLibre ne résout aucune variable CSS : ce qu'on lui passe │
 * │ est toujours une valeur. Un `var(--x)` y donne une couche invisible, sans   │
 * │ erreur ni avertissement.                                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Une seule définition pour les deux rejeux : la légende du rejeu de trajet lit
 * ces mêmes valeurs, faute de quoi la pastille de la légende et la pastille de la
 * carte dérivent l'une de l'autre au premier ajustement.
 */
export const COULEURS_CARTE = {
  /** Le tracé du trajet — vert de marque, lisible sur les quatre fonds. */
  trace: '#10E0A0',
  /** Les arrêts — bleu, information. */
  arret: '#3B82F6',
  /** Les excès CONFIRMÉS — rouge, affirmé. */
  exces: '#EF4444',
  /**
   * Les pointes que l'analyse REFUSE d'affirmer — ambre, un doute et pas une faute.
   *
   * ⚠️ UNE COULEUR À PART, PAS LE ROUGE ATTÉNUÉ. Ces pointes ne comptent ni dans le nombre
   * d'excès ni dans le score : les peindre comme les excès confirmés faisait lire six fautes
   * là où l'en-tête en annonçait une (mesuré le 2026-09-06 sur un trajet de « mh cars » :
   * 1 excès confirmé, 5 pointes « point unique »).
   */
  pointe: '#F59E0B',
  /** Le contour blanc qui détache les pastilles du fond, quel qu'il soit. */
  contour: '#FFFFFF',
} as const;

/**
 * ── ÉPAISSEUR DU CERCLAGE BLANC DES PASTILLES (tranché à l'œil le 2026-09-08) ───────────
 *
 * Question du propriétaire : le rouge de la bande 101-140 est aussi le rouge des excès
 * confirmés, et l'ambre 66-100 celui des pointes à vérifier — faut-il changer une teinte ?
 *
 * Regardé sur banc, aux valeurs réelles, sur fond clair et sur fond sombre. **La rampe ne
 * bouge pas** : vert → ambre → rouge → rouge foncé est la convention de lecture d'une vitesse,
 * la casser coûterait plus de lisibilité qu'elle n'en gagnerait ; les DEUX bandes du milieu
 * collisionnent, donc en repeindre une déplacerait le problème ; et toute autre teinte devrait
 * repasser le seuil de contraste de `markerInk` (4,5:1, mesuré par `maplibre-markers.spec.ts`).
 *
 * Ce que le banc a montré, en revanche : posée SUR un tronçon de sa propre couleur, une
 * pastille cerclée de 2 px se lit comme une bosse du trait, pas comme un repère. À 3 px elle
 * se détache nettement, sur les deux fonds. La distinction passe donc par la FORME, et cette
 * forme est maintenant assez franche pour tenir toute seule.
 *
 * ⚠️ Le trait du rejeu fait 4 px : en dessous de 3, l'anneau ne gagne pas contre lui.
 */
export const CERCLAGE_PASTILLE_PX = 3;

/* ═══ L'ÉCHELLE DE VITESSE — UNE SEULE, POUR TOUTES LES CARTES ═══════════════════════════
   Demande du propriétaire, 2026-09-07 : 1–65 vert, 66–100 orange, 101–140 rouge, au-delà
   rouge foncé. Avant, chaque surface avait la sienne : les marqueurs à 50/90, le rejeu en
   vert uni, la page publique en vert uni, et deux légendes écrites à la main avec d'autres
   seuils encore. Une carte qui se contredit elle-même n'apprend rien à personne.

   Tout part d'ici : `speedColor()` (marqueurs, mini-carte, traînées) délègue, les segments
   des rejeux se colorent avec, et les légendes sont GÉNÉRÉES depuis cette table — changer un
   seuil ne peut donc plus laisser une légende mentir.

   ⚠️ `#991B1B` n'est pas un choix esthétique : `markerInk()` y pose du blanc, ~8,3:1. Toute
   autre teinte doit repasser par `maplibre-markers.spec.ts`, qui mesure 4,5:1 sur chacune.
   ⚠️ Ceci ne touche ni aux récits ni aux excès de vitesse (`COULEURS_CARTE.exces` et
   `.pointe`) : ce sont des JUGEMENTS de l'analyse, pas une couleur de vitesse instantanée.
   ══════════════════════════════════════════════════════════════════════════════════════ */

export interface BandeVitesse {
  /** Plafond inclus de la bande, en km/h. `Infinity` pour la dernière. */
  readonly max: number;
  readonly couleur: string;
  /** Le libellé que les légendes affichent — d'où l'accent et l'unité ici, pas dans le gabarit. */
  readonly libelle: string;
}

export const BANDES_VITESSE: readonly BandeVitesse[] = [
  { max: 0, couleur: '#5C746C', libelle: 'À l’arrêt' },
  { max: 65, couleur: '#10E0A0', libelle: '1-65 km/h' },
  { max: 100, couleur: '#F59E0B', libelle: '66-100 km/h' },
  { max: 140, couleur: '#EF4444', libelle: '101-140 km/h' },
  { max: Number.POSITIVE_INFINITY, couleur: '#991B1B', libelle: 'Plus de 140 km/h' },
];

/**
 * La couleur d'une vitesse instantanée : la première bande dont le plafond la couvre.
 *
 * ⚠️ Une vitesse absente (`NaN`, `undefined` coercé) est « à l'arrêt », pas « au-delà de
 * 140 » : tomber en bout de table sur le rouge foncé peindrait une trame muette comme un
 * excès. Le gris est la seule couleur qui ne prétend rien.
 */
export function couleurVitesse(kmh: number): string {
  if (!(kmh > 0)) return BANDES_VITESSE[0].couleur;
  for (const bande of BANDES_VITESSE) {
    if (kmh <= bande.max) return bande.couleur;
  }
  return BANDES_VITESSE[BANDES_VITESSE.length - 1].couleur;
}
