/**
 * ══ SUR COMBIEN D'ANALYSES ANCIENNES CETTE NOTE EST-ELLE CALCULÉE ? ═══════════════════
 *
 * Le point 1 du chantier a retiré les faux excès du COMPTE : les écrans relisent le détail
 * avec la règle actuelle, qui écarte les segments de durée nulle. Il n'a rien changé à la
 * NOTE. L'éco-score stocké d'une analyse écrite avant le lot V1 (4 septembre 2026) a bel et
 * bien été calculé sous l'ancienne règle, et c'est lui qui fait la moyenne du classement.
 *
 * Un conducteur pouvait donc être classé sur 40 analyses dont 35 anciennes, sans que rien ne
 * le dise. Mesuré en production le 2026-09-05 : 4 036 analyses antérieures au lot V2 ne
 * portent que des segments d'excès de durée nulle.
 *
 * Ce que ces jeux d'essai verrouillent :
 *   1. les DEUX faits (excès établi, analyse ancienne) sont demandés en UNE passe SQL ;
 *   2. le prédicat SQL couvre les TROIS formes que le contrat partagé reconnaît ;
 *   3. la réserve est comptée sur la population EXACTE de `tripCount` ;
 *   4. une panne de base ne rend pas une réserve devinée, mais aucun fait — et le classement
 *      tient debout quand même.
 */
import { Prisma, UserRole } from '@prisma/client';
import { EXCES_DUREE_MIN_SEC, analyseAvantRegleActuelle } from '@vizyo/tracky-shared';
import { DrivingScoreService } from './driving-score.service';

const DAY = 24 * 3600 * 1000;
const NOW = new Date('2026-09-05T12:00:00.000Z').getTime();
const FROM = new Date(NOW - 90 * DAY).toISOString();
const TO = new Date(NOW).toISOString();
const FLEET = 'f1';
const USER = { id: 'u', role: UserRole.FLEET_ADMIN, fleetId: FLEET } as never;
const GROUPE = { group: { id: 'g1', name: 'Livraisons' } };

/** Une analyse du jeu d'essai : sa note (null = non calculable) et son ancienneté. */
type Analyse = { ecoScore: number | null; ancienne: boolean };

/** Raccourci : `n` analyses notées, toutes récentes ou toutes anciennes. */
function notees(n: number, ancienne: boolean, ecoScore = 80): Analyse[] {
  return Array.from({ length: n }, () => ({ ecoScore, ancienne }));
}

type SpecVehicule = {
  id: string;
  plate: string;
  analyses: Analyse[];
  /** Silence du boîtier, en jours (≥ 7 → dormant, donc écarté du classement véhicules). */
  silenceJours?: number;
  /** Ancienneté des trajets, en jours — pour qu'un dormant ait roulé AVANT de se taire. */
  trajetsIlYaJours?: number;
};

function build(specs: SpecVehicule[], opts: { queryRawEchoue?: boolean } = {}) {
  const trips = specs.flatMap((s) =>
    s.analyses.map((_, k) => ({
      id: `${s.id}-t${k}`,
      vehicleId: s.id,
      driverId: 'd1',
      startedAt: new Date(NOW - (s.trajetsIlYaJours ?? 1) * DAY),
      driver: { firstName: 'Sohaib', lastName: 'Hamanni', color: null },
    })),
  );
  const analyses = specs.flatMap((s) =>
    s.analyses.map((a, k) => ({
      tripId: `${s.id}-t${k}`,
      vehicleId: s.id,
      ecoScore: a.ecoScore,
      distanceKm: 10,
      harshAccel: 0,
      harshBrake: 0,
      fuelLiters: 1,
      co2Kg: 2,
    })),
  );
  /** Ancienneté par trajet — c'est ce que Postgres répond, pas ce que Node devine. */
  const ancienneParTrajet = new Map<string, boolean>(
    specs.flatMap((s) => s.analyses.map((a, k): [string, boolean] => [`${s.id}-t${k}`, a.ancienne])),
  );
  const vehicles = specs.map((s) => ({
    id: s.id,
    plate: s.plate,
    brand: 'Renault',
    model: 'Clio',
    outOfServiceReason: null,
    tracker: { id: `tk-${s.id}`, lastSeenAt: new Date(NOW - (s.silenceJours ?? 0) * DAY - 3600 * 1000) },
    groups: [GROUPE],
  }));

  const captured: { sql?: string; params?: unknown[] } = {};
  const prisma = {
    tripAnalysis: { findMany: jest.fn().mockResolvedValue(analyses) },
    trip: {
      findMany: jest.fn().mockResolvedValue(trips),
      groupBy: jest.fn().mockResolvedValue(
        specs.map((s) => ({
          vehicleId: s.id,
          driverId: 'd1',
          _count: { _all: s.analyses.length },
          _sum: { distanceKm: 10 * s.analyses.length },
        })),
      ),
    },
    vehicle: {
      findMany: jest.fn().mockResolvedValue(vehicles),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    /**
     * ⚠️ UNE ligne par analyse et DEUX booléens : la forme exacte que rend la requête depuis
     * qu'elle porte les deux faits. Un simulacre resté à `[{ tripId }]` rendrait `undefined`
     * sur les deux colonnes — donc « aucun excès, aucune ancienne » quoi qu'il arrive.
     */
    $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray, ...params: unknown[]) => {
      captured.sql = strings.join('?');
      captured.params = params;
      if (opts.queryRawEchoue) {
        return Promise.reject(new Prisma.PrismaClientUnknownRequestError('base injoignable', { clientVersion: 'test' }));
      }
      return Promise.resolve(
        analyses.map((a) => ({
          tripId: a.tripId,
          exces: false,
          ancienne: ancienneParTrajet.get(a.tripId) ?? false,
        })),
      );
    }),
  };
  const access = {
    getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL'),
    hasAccessToVehicle: jest.fn().mockResolvedValue(true),
  };
  return { svc: new DrivingScoreService(prisma as never, access as never), prisma, captured };
}

describe('Classement — sur combien d’analyses ANCIENNES la note est calculée', () => {
  beforeEach(() => {
    // La dormance est dérivée à la lecture : tout dépend de « maintenant ».
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(() => jest.restoreAllMocks());

  /**
   * ⚠️ UNE SEULE PASSE. `detail` est un JSON qui voyage avec le tracé : chaque lecture coûte
   * un dé-TOAST par ligne, sur un VPS à 2 vCPU. Deux requêtes — une par fait — doubleraient ce
   * coût pour lire deux booléens de la même colonne. Le `FROM trip_analyses` unique est la
   * seule preuve mécanique que le second fait n'a pas été ajouté en seconde requête.
   */
  it('demande les DEUX faits à Postgres en UNE seule requête', async () => {
    const { svc, prisma, captured } = build([{ id: 'v1', plate: 'AB-123-CD', analyses: notees(25, false) }]);
    await svc.scores(USER, 'vehicle', FROM, TO, FLEET);

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(captured.sql!.match(/FROM trip_analyses/g)).toHaveLength(1);
    // Fait 1 — l'excès établi, avec la constante PARTAGÉE et non un « 1 » écrit à la main.
    expect(captured.sql).toContain('durationSec');
    expect(captured.params).toContain(EXCES_DUREE_MIN_SEC);
    // Fait 2 — l'analyse antérieure à la règle actuelle.
    expect(captured.sql).toContain("detail->'vitesse'");
  });

  /**
   * ⚠️ LES TROIS FORMES DOIVENT COÏNCIDER AVEC LE CONTRAT PARTAGÉ.
   *
   * `analyseAvantRegleActuelle` répond vrai dans trois cas distincts : `detail` nul, clé
   * `vitesse` absente, valeur `vitesse` nulle. En SQL, `IS NULL` couvre les deux premiers
   * (Postgres rend NULL aussi bien pour un document nul que pour une clé absente) — mais PAS
   * le troisième : `detail->'vitesse'` y vaut `'null'::jsonb`, qui n'est pas SQL NULL.
   *
   * D'où la seconde branche. Sans elle, le prédicat se réduirait à `NOT (detail ? 'vitesse')`
   * — la forme employée par le rattrapage — et une analyse à `{"vitesse": null}` serait
   * ancienne pour l'écran d'analyse et récente pour le classement. Deux définitions, deux
   * totaux, aucun moyen de dire lequel ment : la faute déjà payée sur « reste à faire ».
   */
  it('couvre les TROIS formes d’une analyse ancienne, comme le contrat partagé', async () => {
    expect(analyseAvantRegleActuelle({ detail: null } as never)).toBe(true);
    expect(analyseAvantRegleActuelle({ detail: { speeding: [] } } as never)).toBe(true);
    expect(analyseAvantRegleActuelle({ detail: { vitesse: null } } as never)).toBe(true);
    expect(analyseAvantRegleActuelle({ detail: { vitesse: { pointeBruteKmh: 92 } } } as never)).toBe(false);

    const { svc, captured } = build([{ id: 'v1', plate: 'AB-123-CD', analyses: notees(25, false) }]);
    await svc.scores(USER, 'vehicle', FROM, TO, FLEET);

    // `detail` nul ET clé absente : Postgres rend NULL dans les deux cas.
    expect(captured.sql).toContain("ta.detail->'vitesse' IS NULL");
    // Valeur nulle explicite : la branche qu'un `NOT (detail ? 'vitesse')` laisserait passer.
    expect(captured.sql).toContain("ta.detail->'vitesse' = 'null'::jsonb");
  });

  it('2 analyses anciennes sur 3 : la ligne l’annonce, sans toucher au reste', async () => {
    const { svc } = build([
      {
        id: 'v1',
        plate: 'AB-123-CD',
        analyses: [...notees(2, true), ...notees(1, false)],
      },
    ]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO, FLEET);

    // 3 analyses : sous le seuil de classement, donc dans la liste des écartés.
    const ligne = res.insufficientRows[0]!;
    expect(ligne.tripCount).toBe(3);
    expect(ligne.oldFormulaTripCount).toBe(2);
    // La note, elle, ne bouge pas : c'est une réserve sur ce qu'elle mesure, pas une correction.
    expect(ligne.score).toBe(80);
  });

  it('aucune analyse ancienne : 0, et non une absence de champ', async () => {
    const { svc } = build([{ id: 'v1', plate: 'AB-123-CD', analyses: notees(25, false) }]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO, FLEET);
    expect(res.rows[0]!.oldFormulaTripCount).toBe(0);
  });

  /**
   * ⚠️ LA POPULATION DOIT ÊTRE EXACTEMENT CELLE DE `tripCount`.
   *
   * Une analyse sans note (aucune position exploitable) n'entre pas dans la moyenne : elle ne
   * vaut ni zéro ni cent. Elle ne doit donc pas entrer non plus dans la réserve — sinon
   * l'écran afficherait « 3 anciennes » sous un « 2 analysés », c'est-à-dire un rapport
   * impossible, sur une analyse qui ne pèse sur RIEN.
   */
  it('une analyse ancienne SANS note ne compte ni dans tripCount ni dans la réserve', async () => {
    const { svc } = build([
      {
        id: 'v1',
        plate: 'AB-123-CD',
        analyses: [
          { ecoScore: 80, ancienne: true },
          { ecoScore: 80, ancienne: false },
          // Ancienne ET non calculable : comptée nulle part.
          { ecoScore: null, ancienne: true },
        ],
      },
    ]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO, FLEET);

    const ligne = res.insufficientRows[0]!;
    expect(ligne.tripCount).toBe(2);
    expect(ligne.oldFormulaTripCount).toBe(1);
    expect(ligne.oldFormulaTripCount).toBeLessThanOrEqual(ligne.tripCount);
  });

  /**
   * ⚠️ Le repli est « AUCUN FAIT CONNU », jamais une réserve devinée : afficher « 0 ancienne »
   * parce que la base n'a pas répondu serait une affirmation, pas une absence. Et le
   * classement doit tenir debout sans les deux faits — il reste juste.
   */
  it('une panne de base rend 0 partout, sans casser le classement', async () => {
    const { svc } = build(
      [{ id: 'v1', plate: 'AB-123-CD', analyses: notees(25, true) }],
      { queryRawEchoue: true },
    );
    const res = await svc.scores(USER, 'vehicle', FROM, TO, FLEET);

    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.oldFormulaTripCount).toBe(0);
    expect(res.rows[0]!.speedingTrips).toBe(0);
    expect(res.rows[0]!.score).toBe(80);
  });

  /**
   * Une erreur de PROGRAMMATION n'est pas une panne de base : elle doit remonter. La rattraper
   * transformerait une colonne mal orthographiée en réserve muette pour toute la flotte.
   */
  it('laisse remonter une erreur de programmation', async () => {
    const { svc, prisma } = build([{ id: 'v1', plate: 'AB-123-CD', analyses: notees(25, true) }]);
    prisma.$queryRaw.mockImplementation(() => Promise.reject(new TypeError('colonne inconnue')));
    await expect(svc.scores(USER, 'vehicle', FROM, TO, FLEET)).rejects.toBeInstanceOf(TypeError);
  });

  /**
   * ⚠️ Les TROIS listes. Une réserve qui ne vaudrait que pour le podium n'en serait pas une :
   * l'écran des écartés et celui des dormants affichent eux aussi un nombre d'analyses, donc
   * eux aussi une note calculée sur des analyses anciennes.
   */
  it('les trois listes la portent : classées, écartées, dormantes', async () => {
    const { svc } = build([
      { id: 'v-classe', plate: 'AA-111-AA', analyses: [...notees(21, true), ...notees(4, false)] },
      { id: 'v-ecarte', plate: 'BB-222-BB', analyses: notees(3, true) },
      // Boîtier muet depuis 39 j, mais qui a roulé il y a 40 j : dans la période, hors classement.
      { id: 'v-dormant', plate: 'FV-941-LZ', analyses: notees(25, true), silenceJours: 39, trajetsIlYaJours: 40 },
    ]);
    const res = await svc.scores(USER, 'vehicle', FROM, TO, FLEET);

    expect(res.rows.map((r) => [r.id, r.oldFormulaTripCount])).toEqual([['v-classe', 21]]);
    expect(res.insufficientRows.map((r) => [r.id, r.oldFormulaTripCount])).toEqual([['v-ecarte', 3]]);
    expect(res.dormantRows.map((r) => [r.id, r.oldFormulaTripCount])).toEqual([['v-dormant', 25]]);
  });

  /**
   * ⚠️ Les QUATRE portées. Le conducteur est le cas qui compte : c'est sous SON nom que la
   * note s'affiche, et c'est lui qu'on jugerait sans la réserve.
   */
  it('toutes les portées la portent, y compris « conducteur ou groupe »', async () => {
    const parPortee = async (scope: 'vehicle' | 'driver' | 'group' | 'attribution') => {
      const { svc } = build([{ id: 'v1', plate: 'AB-123-CD', analyses: [...notees(20, true), ...notees(5, false)] }]);
      const res = await svc.scores(USER, scope, FROM, TO, FLEET);
      return res.rows[0]!;
    };

    for (const scope of ['vehicle', 'driver', 'group', 'attribution'] as const) {
      const ligne = await parPortee(scope);
      // La portée est dans l'attendu : sans elle, un échec ne dirait pas LAQUELLE a lâché.
      expect([scope, ligne.tripCount, ligne.oldFormulaTripCount]).toEqual([scope, 25, 20]);
    }
  });
});
