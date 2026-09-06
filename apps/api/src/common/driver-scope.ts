import { BadRequestException } from '@nestjs/common';
import { CONDUCTEUR_AUCUN, FILTRE_CONDUCTEUR_REGEX, normaliserFiltreConducteur } from '@vizyo/tracky-shared';

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * FILTRE CONDUCTEUR — « MONTRE-MOI SES TRAJETS » (F13, seconde moitié)
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le récapitulatif « par conducteur ou groupe » répond à « combien a roulé tel conducteur ».
 * Le geste suivant — voir SES trajets — n'existait pas : `Trip.driverId` et son index sont
 * là depuis toujours, mais aucune route ne les exposait.
 *
 * ── POURQUOI UNE SEULE DÉFINITION ────────────────────────────────────────────────────────
 *
 * Quatre routes suivent ce filtre : la liste (`GET /trips`), le résumé journalier et les
 * graphiques de période (qui partagent `buildPeriodWhere`), et la synthèse
 * (`GET /reports/stats`). Un écran qui filtrerait le TABLEAU sans filtrer les AGRÉGATS
 * afficherait deux totaux contradictoires — le défaut que la page Rapports a déjà payé
 * (« le compteur annonce 622 et le tableau en affiche 100 »). D'où une règle unique, ici,
 * que le service des trajets et celui des statistiques appellent tous les deux.
 *
 * ── DEUX FORMES, ET RIEN D'AUTRE ─────────────────────────────────────────────────────────
 *
 *   - un identifiant de conducteur (UUID)  → les trajets de cette personne ;
 *   - le mot-clé `none`                    → les trajets SANS conducteur.
 *
 * La seconde forme n'est pas un raffinement : mesuré en production le 2026-09-05, 1 905
 * trajets sur 1 956 chez « mh cars » n'ont AUCUN conducteur. C'est précisément la liste que
 * le gestionnaire doit pouvoir isoler pour la corriger.
 *
 * ⚠️ VALIDATION STRICTE, ET PAS SEULEMENT DANS LE DTO. La liste passe par `ListTripsDto`,
 * mais `daily-summary`, `period-charts` et `reports/stats` lisent des `@Query()` bruts : sans
 * contrôle ici, une valeur libre descendrait telle quelle dans un `where` Prisma. La borne
 * vit donc dans la RÉSOLUTION, que toutes les routes traversent.
 */

/**
 * Le mot-clé et la forme acceptée viennent du CONTRAT PARTAGÉ (`@vizyo/tracky-shared`), parce
 * que l'ÉCRAN les pose aussi : il relit ce filtre de l'URL et doit le valider avant de le
 * renvoyer. Deux expressions écrites séparément finiraient par diverger, et c'est le côté le
 * plus permissif qui gagnerait — celui qui laisse passer. Réexportées ici pour que les
 * appelants du serveur (dont `ListTripsDto`) n'aient qu'une porte à connaître.
 */
export { CONDUCTEUR_AUCUN, FILTRE_CONDUCTEUR_REGEX };

/**
 * Ce que le filtre conducteur doit poser dans un `where` Prisma :
 *
 *   - `undefined` → AUCUN filtre (ne pas écrire la clé du tout) ;
 *   - `null`      → `driverId IS NULL`, les trajets sans conducteur ;
 *   - `string`    → l'identifiant demandé.
 *
 * ⚠️ Les trois cas sont distincts et le premier n'est PAS `null` : écrire
 * `where.driverId = null` quand aucun filtre n'est demandé ne rendrait que les trajets
 * orphelins, c'est-à-dire l'inverse de « pas de filtre ».
 */
export type PorteeConducteur = string | null | undefined;

/**
 * Traduit le paramètre reçu en portée conducteur, ou refuse.
 *
 * @throws BadRequestException si la valeur n'est ni un UUID ni `none`.
 */
export function resolveDriverScope(driverId?: string | null): PorteeConducteur {
  if (!(driverId ?? '').trim()) return undefined;
  const canonique = normaliserFiltreConducteur(driverId);
  if (canonique === null) {
    throw new BadRequestException(
      'Filtre conducteur invalide : un identifiant de conducteur ou « none » est attendu.',
    );
  }
  // ⚠️ La portée rendue est la forme CANONIQUE, pas la valeur reçue : un UUID en majuscules
  // descendrait sinon tel quel dans le `where`, et le nom du conducteur résolu pour le titre du
  // PDF viendrait d'une seconde lecture faite sur une autre écriture du même identifiant.
  return canonique === CONDUCTEUR_AUCUN ? null : canonique;
}

/**
 * Ce qu'un DTO doit poser AVANT de valider, pour que les deux portes du serveur rendent la même
 * réponse aux mêmes entrées.
 *
 * Trois routes lisent des `@Query()` bruts et ne traversent que `resolveDriverScope` ; quatre
 * autres passent d'abord par un DTO. Relevé en revue contradictoire : `@Matches` s'applique à la
 * valeur BRUTE et `@IsOptional()` ne saute que `null`/`undefined`, si bien que `?driverId=` et
 * `?driverId=%20none` étaient REFUSÉS par la liste (400) et ACCEPTÉS par les trois agrégats — le
 * tableau en panne au-dessus de compteurs qui décrivaient tranquillement une population.
 *
 *   - chaîne vide ou blancs → `undefined` : « aucun filtre », exactement comme le résolveur ;
 *   - forme reconnue        → sa forme canonique (trimée, en minuscules) ;
 *   - le reste              → la valeur BRUTE, pour que `@Matches` rende le 400 qui nomme le champ.
 */
export function normaliserDriverIdDto(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (!value.trim()) return undefined;
  return normaliserFiltreConducteur(value) ?? value;
}
