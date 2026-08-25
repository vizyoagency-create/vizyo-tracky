import type { Tracker } from '@prisma/client';

/**
 * ══ TRK-048 — LA CADENCE ENREGISTRÉE N'EST QU'UNE MESURE, ET UNE MESURE SE PÉRIME ═══════════
 *
 * `currentFixIntervalS` n'est recalculé qu'à partir de `lastValidFrameAt` (reconcile) : dès
 * qu'un boîtier perd son fix GPS, la valeur CESSE d'être rafraîchie et reste figée sur la
 * dernière mesure — qui peut dater d'un autre régime. Mesuré le 25/08 sur FS-253-HR :
 * 200 trames/h pendant 10 h (une toutes les 20 s pile, sa cible exacte) et un
 * `currentFixIntervalS` à **1**, vestige de l'épisode TRK-045.
 *
 * Conséquence payée le jour même : le critère d'acceptation du correctif TRK-045
 * (« boîtiers à ≤ 6 s : 0 ou 1 ») est passé POUR LA MAUVAISE RAISON — le 1 était un vestige,
 * pas un émetteur rapide. *Un critère satisfait par une valeur périmée ne mesure rien.*
 *
 * La règle : une mesure est PÉRIMÉE quand aucune trame valide n'est arrivée depuis plus de
 * FACTEUR × l'intervalle qu'elle prétend décrire (plancher 3 min pour tolérer la gigue d'un
 * boîtier à 20 s). Un boîtier garé au heartbeat horaire (mesure 3600 s) reste « mesurable »
 * pendant 3 h ; un vestige à 1 s est périmé au bout de 3 min.
 *
 * ⚠️ On ne RÉÉCRIT jamais le champ (ni zéro, ni la cible, ni null) : ce serait remplacer un
 * chiffre faux par un autre. L'information juste, quand la mesure est périmée, est
 * l'ABSENCE d'information — chaque consommateur (écran, sélection d'auto-alignement,
 * balayage de récupération, collecte d'audit) doit la traiter comme telle.
 */
export const CADENCE_PEREMPTION_FACTEUR = 3;
export const CADENCE_PEREMPTION_PLANCHER_MS = 3 * 60_000;

export function cadenceMesurePerimee(
  tracker: Pick<Tracker, 'currentFixIntervalS' | 'lastValidFrameAt'>,
  now: number = Date.now(),
): boolean {
  // Rien n'a jamais été mesuré → il n'y a rien à périmer (l'affichage rend déjà « — »).
  if (tracker.currentFixIntervalS == null) return false;
  // Une valeur sans provenance est périmée par construction.
  if (!tracker.lastValidFrameAt) return true;
  const fenetreMs = Math.max(
    CADENCE_PEREMPTION_PLANCHER_MS,
    tracker.currentFixIntervalS * 1000 * CADENCE_PEREMPTION_FACTEUR,
  );
  return now - tracker.lastValidFrameAt.getTime() > fenetreMs;
}
