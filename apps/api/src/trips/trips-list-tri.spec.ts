import { TripsService } from './trips.service';

/**
 * Tri SERVEUR de `GET /trips` — le correctif du drilldown « Vitesse max ».
 *
 * Ce que ces tests verrouillent, et pourquoi :
 *
 * 1. **L'ordre part en base.** Le tri se faisait en mémoire sur la page déjà chargée.
 *    Mesuré en production le 2026-09-02 (flotte « mh cars », 30 jours) : la carte KPI
 *    annonçait 180 km/h — chiffre juste, il vient de l'agrégat serveur — et le clic
 *    surlignait un trajet à 139 km/h, le plus rapide des cent trajets chargés sur 1 896.
 *    Le trajet à 180 n'était pas dans la page. L'écran avait pourtant l'air de répondre.
 *
 * 2. **Le départage par `id`.** `startedAt` et `maxSpeed` ne sont pas uniques. Sans second
 *    critère unique, deux lignes ex aequo peuvent s'échanger d'une requête à l'autre — et
 *    la pagination par curseur, qui reprend « après cette ligne », saute ou répète des
 *    trajets. Même direction que le critère principal, pour que la comparaison reste un
 *    ordre lexicographique simple du couple.
 *
 * 3. **La liste fermée de colonnes.** `sortBy` finit dans un `orderBy` Prisma : une valeur
 *    libre serait une injection de champ. La validation est déclarée sur le DTO
 *    (`@IsIn(TRIP_SORT_COLUMNS)`) ; le service, lui, ne doit jamais inventer de colonne
 *    quand l'argument est absent.
 */
describe('TripsService — tri serveur de la liste de trajets', () => {
  /** `tripOrderBy` est privé (détail d'implémentation), on y accède explicitement. */
  const orderBy = (sortBy?: string, sortDir?: string) =>
    (TripsService as unknown as {
      tripOrderBy: (b?: string, d?: string) => Record<string, string>[];
    }).tripOrderBy(sortBy, sortDir);

  it('trie par date de départ décroissante quand aucun tri n\'est demandé (comportement historique)', () => {
    expect(orderBy(undefined, undefined)).toEqual([{ startedAt: 'desc' }, { id: 'desc' }]);
  });

  it('trie par vitesse max décroissante — le drilldown de la carte KPI', () => {
    expect(orderBy('maxSpeed', 'desc')).toEqual([{ maxSpeed: 'desc' }, { id: 'desc' }]);
  });

  it('honore la direction croissante', () => {
    expect(orderBy('distanceMeters', 'asc')).toEqual([{ distanceMeters: 'asc' }, { id: 'asc' }]);
  });

  it('ajoute TOUJOURS un départage unique par id, dans la même direction', () => {
    for (const col of ['startedAt', 'durationSeconds', 'distanceMeters', 'avgSpeed', 'maxSpeed']) {
      for (const dir of ['asc', 'desc']) {
        const out = orderBy(col, dir);
        expect(out).toHaveLength(2);
        expect(out[1]).toEqual({ id: dir });
      }
    }
  });

  it('retombe sur « desc » pour toute direction autre que « asc »', () => {
    // La validation du DTO rejette déjà les autres valeurs ; le service reste défensif
    // plutôt que de produire un `orderBy` avec une direction inconnue.
    expect(orderBy('maxSpeed', 'DESCENDANT')).toEqual([{ maxSpeed: 'desc' }, { id: 'desc' }]);
  });
});
