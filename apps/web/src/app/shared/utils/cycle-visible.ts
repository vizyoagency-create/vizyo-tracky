import { filter, fromEvent, interval, type Observable, startWith, switchMap } from 'rxjs';

/** Ce que le cycle lit du document : sa visibilité, et l'évènement qui la signale. */
export type DocumentVisible = EventTarget & { readonly hidden: boolean };

/**
 * Le RYTHME d'un sondage qui ne tourne que page visible — et qui repart TOUT DE SUITE au retour.
 *
 * Émet immédiatement si la page est visible, puis toutes les `periodeMs`. Chaque retour au premier
 * plan (`visibilitychange` vers visible) relance le cycle par une émission immédiate et REMPLACE
 * le précédent (`switchMap`) : pas de seconde lecture une seconde plus tard parce que l'ancien
 * minuteur tombait juste après.
 *
 * ⚠️ POURQUOI (06/10/2026). Le tableau de bord écrivait `interval(30 s).pipe(startWith(0))` filtré
 * par `!document.hidden`. Ouvert dans un onglet en ARRIÈRE-PLAN, l'émission de départ était filtrée
 * et rien ne la rejouait : les squelettes restaient jusqu'à 30 s après le retour à l'onglet — vu en
 * recette, où l'on a d'abord cru à un blocage. Le commentaire promettait pourtant « au retour
 * visible, un fetch immédiat ».
 *
 * Tant que la page reste cachée, le cycle EN COURS continue d'émettre : c'est au consommateur de
 * filtrer (`filter(() => !document.hidden)`), comme le faisait déjà le tableau de bord. Une page
 * ouverte cachée, elle, n'émet rien avant son premier retour visible.
 *
 * @param doc le document ; `null` hors navigateur (rendu serveur) — un simple minuteur.
 */
export function cycleVisible(
  periodeMs: number,
  doc: DocumentVisible | null = typeof document === 'undefined' ? null : document,
): Observable<number> {
  if (!doc) return interval(periodeMs).pipe(startWith(0));
  return fromEvent(doc, 'visibilitychange').pipe(
    startWith(null),
    filter(() => !doc.hidden),
    switchMap(() => interval(periodeMs).pipe(startWith(0))),
  );
}
