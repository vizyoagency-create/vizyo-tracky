/**
 * F13 — « PAR CONDUCTEUR OU GROUPE » DANS LE RÉCAPITULATIF DES RAPPORTS.
 *
 * Le récapitulatif répondait à « quel VÉHICULE roule et dépasse ? ». Personne ne pouvait
 * répondre à « combien de kilomètres a fait tel conducteur ce mois-ci, avec combien
 * d'excès ? » — l'écran des scores savait imputer un trajet, le rapport non.
 *
 * Ce que ces tests verrouillent, dans l'ordre d'importance :
 *   1. `topVehicles` rend EXACTEMENT les mêmes chiffres qu'avant ce lot. C'est la carte que
 *      le client lit tous les jours, et le PDF comme l'Excel s'en servent ; le `groupBy` est
 *      passé à ['vehicleId', 'driverId'], une réagrégation ratée l'amputerait en silence ;
 *   2. la clé d'imputation est celle du CLASSEMENT (conducteur, sinon groupe du véhicule,
 *      sinon rien) — la règle de `cleAttribution` dans driving-score.service.ts ;
 *   3. la somme des lignes d'imputation retombe sur les totaux par véhicule : une seule
 *      passe alimente les deux vues, elles ne peuvent pas se contredire ;
 *   4. les trajets sans conducteur NI groupe sont COMPTÉS, jamais une ligne ;
 *   5. les excès comptés sont les excès ÉTABLIS (règle partagée, seuil de durée), jamais le
 *      compteur `speedingCount` écrit au moment de l'analyse ;
 *   6. le périmètre véhicule (anti-IDOR) borne le nouvel agrégat comme les anciens.
 */
import { UserRole } from '@prisma/client';
import { EXCES_DUREE_MIN_SEC } from '@vizyo/tracky-shared';
import { FleetStatsReport, ReportsStatsService } from './reports-stats.service';

const FLEET_ID = 'fleet-1';
const FROM = new Date('2026-06-01T00:00:00.000Z');
const TO = new Date('2026-07-01T00:00:00.000Z');

type LigneAttribution = NonNullable<FleetStatsReport['byAttribution']>[number];

const G1 = { id: 'g1', name: 'Livraisons Nord' };
const G2 = { id: 'g2', name: 'Atelier' };

/**
 * Parc calqué sur les trois situations RÉELLEMENT rencontrées en production le 2026-09-05 :
 *  - v1 : deux conducteurs sur la période (le cas que la vue par véhicule écrase) ;
 *  - v2 : aucun conducteur mais un groupe — 2 675 trajets sur 2 707 chez cdef31 ;
 *  - v3 : ni conducteur ni groupe — 1 866 trajets sur 1 886 chez mh cars.
 */
const VEHICULES = [
  { id: 'v1', plate: 'AA-111-AA', groupe: G1 },
  { id: 'v2', plate: 'BB-222-BB', groupe: G2 },
  { id: 'v3', plate: 'CC-333-CC', groupe: null },
];

/** Trajets de la période, groupés (véhicule, conducteur) comme le fait le service. */
const TRAJETS = [
  { vehicleId: 'v1', driverId: 'd1', km: 120, sec: 7200, trajets: 4 },
  { vehicleId: 'v1', driverId: 'd2', km: 80, sec: 3600, trajets: 3 },
  { vehicleId: 'v2', driverId: null, km: 45, sec: 1800, trajets: 2 },
  { vehicleId: 'v3', driverId: null, km: 30, sec: 1800, trajets: 5 },
];

/** Excès ÉTABLIS (ce que rend la requête brute), groupés de la même façon. */
const EXCES = [
  { vehicleId: 'v1', driverId: 'd1', exces: 3, trajets: 2, pire: 18.4 },
  { vehicleId: 'v1', driverId: 'd2', exces: 1, trajets: 1, pire: 7.2 },
  { vehicleId: 'v2', driverId: null, exces: 2, trajets: 2, pire: 11 },
  // ⚠️ Des excès sur un trajet qu'on ne peut imputer à personne : ils comptent pour le
  // VÉHICULE, et pour aucune ligne d'imputation. On n'accuse pas « personne ».
  { vehicleId: 'v3', driverId: null, exces: 9, trajets: 4, pire: 42 },
];

const RALENTI = [
  { vehicleId: 'v1', driverId: 'd1', ralenti: 600 },
  { vehicleId: 'v1', driverId: 'd2', ralenti: 300 },
  { vehicleId: 'v2', driverId: null, ralenti: 120 },
  { vehicleId: 'v3', driverId: null, ralenti: 60 },
];

const CONDUCTEURS = [
  { id: 'd1', firstName: 'Sohaib', lastName: 'Hamanni' },
  { id: 'd2', firstName: 'Amine', lastName: 'Berrada' },
];

interface OptionsBanc {
  /** Périmètre véhicule accessible à l'appelant ('ALL' = admin). */
  perimetre?: string[] | 'ALL';
  /** Profondeur demandée (curseur « Top N »). */
  topN?: number;
}

function makePrisma(opts: OptionsBanc = {}) {
  const perimetre = opts.perimetre ?? 'ALL';
  const dansPerimetre = (id: string) => perimetre === 'ALL' || perimetre.includes(id);

  const vehicleRows = VEHICULES.filter((v) => dansPerimetre(v.id)).map((v) => ({
    id: v.id,
    plate: v.plate,
    type: 'CAR',
    fuelConsumptionL100km: 7,
    energy: 'DIESEL',
    calibratedConsumptionL100km: null,
    calibratedTanks: 0,
    tracker: { id: `t-${v.id}`, lastSeenAt: new Date() },
    groups: v.groupe ? [{ group: v.groupe }] : [],
  }));

  const tripRows = TRAJETS.filter((t) => dansPerimetre(t.vehicleId)).map((t) => ({
    vehicleId: t.vehicleId,
    driverId: t.driverId,
    _sum: { distanceKm: t.km, durationSeconds: t.sec },
    _count: { _all: t.trajets },
  }));

  const capturedDriverWhere: { where?: unknown } = {};

  const prisma = {
    fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID, name: 'Flotte test', fuelPriceEurL: 1.85 }) },
    vehicle: { findMany: jest.fn().mockResolvedValue(vehicleRows) },
    trip: {
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: tripRows.reduce((s, r) => s + r._count._all, 0) },
        _sum: {
          distanceKm: tripRows.reduce((s, r) => s + r._sum.distanceKm, 0),
          durationSeconds: tripRows.reduce((s, r) => s + r._sum.durationSeconds, 0),
        },
        _avg: { avgSpeed: 42 },
        _max: { maxSpeed: 110 },
      }),
      groupBy: jest.fn().mockResolvedValue(tripRows),
      findMany: jest.fn().mockResolvedValue([]),
    },
    alert: { groupBy: jest.fn().mockResolvedValue([]) },
    tripFuelStop: { aggregate: jest.fn().mockResolvedValue({ _avg: { unitPriceEur: null }, _count: { _all: 0 } }) },
    driver: {
      findMany: jest.fn().mockImplementation(({ where }: { where: { id: { in: string[] } } }) => {
        capturedDriverWhere.where = where;
        return Promise.resolve(CONDUCTEURS.filter((d) => where.id.in.includes(d.id)));
      }),
    },
    /**
     * Les deux requêtes brutes se distinguent par leur TEXTE : l'une additionne `idleSec`,
     * l'autre déplie `detail->'speeding'`. Un simulacre qui rendrait la même chose aux deux
     * décrirait une base qui n'existe pas — et masquerait un mélange des deux agrégats.
     */
    $queryRaw: jest.fn().mockImplementation((strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join(' ');
      if (sql.includes('idleSec')) {
        return Promise.resolve(RALENTI.filter((r) => dansPerimetre(r.vehicleId)));
      }
      return Promise.resolve(EXCES.filter((r) => dansPerimetre(r.vehicleId)));
    }),
  } as unknown as ConstructorParameters<typeof ReportsStatsService>[0];

  return { prisma, capturedDriverWhere };
}

function compute(opts: OptionsBanc = {}): Promise<FleetStatsReport> {
  const { prisma } = makePrisma(opts);
  return new ReportsStatsService(prisma).compute(
    FLEET_ID, FROM, TO,
    { role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID, accessibleVehicleIds: opts.perimetre ?? 'ALL' },
    { topN: opts.topN },
  );
}

const ligne = (report: FleetStatsReport, key: string) =>
  report.byAttribution!.find((l) => l.key === key)!;

/**
 * Le TEXTE COMPLET d'une requête brute, fragments `Prisma.sql` compris.
 *
 * ⚠️ Un simple `Array.from(strings).join()` ne suffit plus : depuis que le corps commun des
 * requêtes d'excès vit dans `exces-portee.ts`, il arrive au simulacre comme une VALEUR
 * interpolée. Le joindre naïvement rendait un gabarit de trois mots, et les vérifications de
 * clauses ci-dessous passaient au vert sans rien vérifier — le pire des deux mondes.
 */
/** Toutes les valeurs LIÉES d'une série d'appels, fragments imbriqués compris. */
function valeursSql(appels: readonly unknown[][]): unknown[] {
  const fragment = (v: unknown): v is { strings: readonly string[]; values: readonly unknown[] } =>
    !!v && typeof v === 'object' && Array.isArray((v as { strings?: unknown }).strings);
  const out: unknown[] = [];
  const descendre = (valeurs: readonly unknown[]): void => {
    for (const v of valeurs) {
      if (fragment(v)) descendre(v.values);
      else out.push(v);
    }
  };
  for (const appel of appels) descendre(appel.slice(1));
  return out;
}

function texteSql(strings: readonly string[], valeurs: readonly unknown[]): string {
  const fragment = (v: unknown): v is { strings: readonly string[]; values: readonly unknown[] } =>
    !!v && typeof v === 'object' && Array.isArray((v as { strings?: unknown }).strings);
  return strings
    .map((morceau, i) => {
      const v = valeurs[i];
      if (i >= valeurs.length) return morceau;
      return morceau + (fragment(v) ? texteSql(v.strings, v.values) : ' ? ');
    })
    .join('');
}

describe('ReportsStatsService — récapitulatif par conducteur ou groupe (F13)', () => {
  /**
   * ⚠️ LE TEST QUI PROTÈGE L'EXISTANT. Le `groupBy` porte désormais ['vehicleId','driverId'] :
   * v1 rend DEUX lignes. Écrire la seconde par-dessus la première (un `set` au lieu d'un `+=`)
   * ferait tomber v1 de 200 à 80 km sans qu'aucun type ne s'en aperçoive — sur la carte que
   * le client lit tous les jours, et dans le PDF/Excel qui la reprennent.
   */
  it('la vue par véhicule est INCHANGÉE : un véhicule à deux conducteurs garde tous ses chiffres', async () => {
    const report = await compute();
    const v1 = report.topVehicles.find((v) => v.vehicleId === 'v1')!;

    expect(v1.distanceKm).toBe(200); // 120 + 80
    expect(v1.tripCount).toBe(7); // 4 + 3
    expect(v1.durationHours).toBe(3); // 7 200 s + 3 600 s
    expect(v1.avgSpeedKmh).toBe(67); // 200 km / 3 h, jamais la moyenne des moyennes
    expect(v1.speedingCount).toBe(4); // 3 + 1
    expect(v1.speedingTripCount).toBe(3); // 2 + 1, sans double compte : un trajet, un conducteur
    expect(v1.worstOverKmh).toBe(18.4); // le PIRE, pas la somme
    expect(v1.idleSeconds).toBe(900); // 600 + 300
  });

  it('trois lignes : deux conducteurs et un groupe — jamais le véhicule sans rien', async () => {
    const report = await compute();

    expect(report.byAttribution!.map((l) => [l.key, l.kind, l.label])).toEqual([
      ['driver:d1', 'driver', 'Sohaib Hamanni'],
      ['driver:d2', 'driver', 'Amine Berrada'],
      ['group:g2', 'group', 'Atelier'],
    ]);
    expect(report.byAttributionTotal).toBe(3);
  });

  /**
   * La clé est celle du CLASSEMENT : le conducteur PRIME sur le groupe. v1 appartient au
   * groupe « Livraisons Nord » et ses deux conducteurs sont connus — le groupe ne doit
   * apparaître nulle part, sinon ses kilomètres seraient comptés deux fois.
   */
  it('le conducteur prime sur le groupe : le groupe de v1 n’a aucune ligne', async () => {
    const report = await compute();
    expect(report.byAttribution!.some((l) => l.key === `group:${G1.id}`)).toBe(false);
    expect(report.byAttribution!.some((l) => l.label === G1.name)).toBe(false);
  });

  it('les chiffres d’une ligne ont la MÊME forme que ceux d’un véhicule', async () => {
    const report = await compute();
    const d1 = ligne(report, 'driver:d1');

    expect(d1).toMatchObject({
      tripCount: 4,
      distanceKm: 120,
      durationHours: 2,
      avgSpeedKmh: 60, // 120 km / 2 h
      speedingCount: 3,
      speedingTripCount: 2,
      worstOverKmh: 18.4,
      idleSeconds: 600,
    });
  });

  /**
   * ⚠️ UNE SEULE PASSE POUR DEUX VUES. Si les deux agrégats venaient de requêtes séparées,
   * ils finiraient par ne plus tomber juste — et l'écran afficherait deux totaux différents
   * selon la position de la bascule, sur les mêmes trajets.
   */
  it('la somme des lignes (non attribués compris) retombe sur les totaux par véhicule', async () => {
    const report = await compute();

    const sommeLignes = (extrait: (l: LigneAttribution) => number) =>
      report.byAttribution!.reduce((s, l) => s + extrait(l), 0);

    expect(sommeLignes((l) => l.distanceKm) + report.unattributedTrips!.distanceKm)
      .toBeCloseTo(report.topVehicles.reduce((s, v) => s + v.distanceKm, 0), 6);
    expect(sommeLignes((l) => l.tripCount) + report.unattributedTrips!.tripCount)
      .toBe(report.topVehicles.reduce((s, v) => s + v.tripCount, 0));
    expect(sommeLignes((l) => l.durationHours) + report.unattributedTrips!.durationHours)
      .toBeCloseTo(report.topVehicles.reduce((s, v) => s + v.durationHours, 0), 6);
    // Et le total de flotte, celui des indicateurs du haut d'écran, tombe pareil.
    expect(sommeLignes((l) => l.distanceKm) + report.unattributedTrips!.distanceKm)
      .toBeCloseTo(report.trips.totalKm, 6);
  });

  it('les trajets sans conducteur NI groupe sont comptés, jamais une ligne', async () => {
    const report = await compute();

    expect(report.unattributedTrips).toEqual({ tripCount: 5, distanceKm: 30, durationHours: 0.5 });
    // v3 roule et dépasse : il est bien dans la vue par véhicule…
    expect(report.topVehicles.find((v) => v.vehicleId === 'v3')!.speedingCount).toBe(9);
    // …et n'apporte AUCUNE ligne d'imputation, ni sous son identifiant ni sous un groupe.
    expect(report.byAttribution!.some((l) => l.key.includes('v3'))).toBe(false);
    expect(report.byAttribution!.reduce((s, l) => s + l.speedingCount, 0)).toBe(6); // 3 + 1 + 2, pas 15
  });

  it('trie par distance décroissante et plafonne comme la vue par véhicule, en disant le total réel', async () => {
    const report = await compute({ topN: 2 });

    expect(report.byAttribution!.map((l) => l.distanceKm)).toEqual([120, 80]);
    expect(report.topVehicles.length).toBe(2); // même profondeur des deux côtés de la bascule
    // ⚠️ Le compte RÉEL survit à la troncature : sans lui, l'écran affirmerait que la flotte
    // n'a que deux conducteurs.
    expect(report.byAttributionTotal).toBe(3);
  });

  /**
   * ⚠️ LES EXCÈS SONT CEUX DE LA RÈGLE PARTAGÉE, pas le compteur `speedingCount` écrit au
   * moment de l'analyse. Au 2026-09-04, 4 036 analyses de production ne portent QUE des
   * segments de durée nulle, héritées d'avant le lot V2 : lire le compteur accuserait des
   * conducteurs d'excès que le rapport disciplinaire, lui, refuse d'affirmer.
   */
  it('compte les excès ÉTABLIS (seuil de durée partagé), jamais le compteur de l’analyse', async () => {
    const { prisma } = makePrisma();
    await new ReportsStatsService(prisma).compute(FLEET_ID, FROM, TO);

    const appels = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw.mock.calls;
    const textes = appels.map((c: unknown[]) => texteSql(c[0] as TemplateStringsArray, c.slice(1)));
    const requeteExces = textes.find((t: string) => t.includes("detail->'speeding'"))!;

    expect(requeteExces).toBeDefined();
    // Le seuil est LIÉ à la requête, et vient de la constante partagée.
    expect(requeteExces).toContain("durationSec");
    // ⚠️ Le seuil est lié DANS le fragment du corps commun, plus au premier niveau de l'appel :
    // on cherche donc la valeur partout, y compris dans les fragments imbriqués. La garantie
    // ne change pas — la constante partagée doit voyager avec la requête, pas être recopiée.
    expect(valeursSql(appels).includes(EXCES_DUREE_MIN_SEC)).toBe(true);
    // Aucune requête ne lit le compteur de l'analyse : c'est le raccourci qui serait faux.
    expect(textes.join(' ')).not.toContain('speedingCount');
  });

  /**
   * ⚠️ LE MODE VIE PRIVÉE BORNE AUSSI LES DEUX REQUÊTES ÉCRITES À LA MAIN (RGPD).
   *
   * Relevé en revue le 2026-09-05 et reproduit : `privacyExclude` ne vivait que dans le filtre
   * Prisma des trajets, pas dans ces deux SQL. Un groupe contenant UN véhicule normal et UN
   * véhicule en vie privée voyait sa ligne naître du premier (2 trajets, 12 km) puis encaisser
   * les excès du second (40 excès, +55 km/h) : l'écran publiait la conduite d'un véhicule mis
   * sous vie privée, sur une ligne dont les compteurs ne pouvaient pas concorder. Le garde-fou
   * du service ne protège que la CRÉATION d'une ligne, jamais l'abondement d'une ligne née
   * ailleurs — seule la borne SQL ferme le trou, et elle remet aussi d'aplomb le ralenti total.
   */
  it('⚠️ les deux requêtes écrites à la main excluent les véhicules en mode vie privée', async () => {
    const { prisma } = makePrisma();
    await new ReportsStatsService(prisma).compute(FLEET_ID, FROM, TO);

    const appels = (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw.mock.calls;
    const textes = appels.map((c: unknown[]) => texteSql(c[0] as TemplateStringsArray, c.slice(1)));
    const requeteExces = textes.find((t: string) => t.includes("detail->'speeding'"))!;
    const requeteRalenti = textes.find((t: string) => t.includes('idleSec'))!;

    for (const requete of [requeteExces, requeteRalenti]) {
      expect(requete).toBeDefined();
      expect(requete).toContain('privacyModeEnabled');
      // La jointure porte sur le VÉHICULE de l'analyse : borner sur autre chose laisserait
      // passer les lignes du véhicule privé sous le couvert d'un trajet voisin.
      expect(requete.replace(/\s+/g, ' ')).toContain('JOIN vehicles v ON v.id = ta."vehicleId"');
    }
  });

  /**
   * Une seule passe : la preuve tient dans le `groupBy`, qui doit porter les DEUX clés. Deux
   * requêtes séparées seraient le premier pas vers deux vérités.
   */
  it('agrège les trajets en UNE passe : le groupBy porte le véhicule ET le conducteur', async () => {
    const { prisma } = makePrisma();
    await new ReportsStatsService(prisma).compute(FLEET_ID, FROM, TO);

    const groupBy = (prisma as unknown as { trip: { groupBy: jest.Mock } }).trip.groupBy;
    expect(groupBy).toHaveBeenCalledTimes(1);
    expect(groupBy.mock.calls[0][0].by).toEqual(['vehicleId', 'driverId']);
  });

  /** Le nom vient d'UNE requête bornée à la flotte, et d'aucune quand personne n'est nommé. */
  it('ne va chercher les conducteurs qu’une fois, bornés à la flotte du rapport', async () => {
    const { prisma, capturedDriverWhere } = makePrisma();
    await new ReportsStatsService(prisma).compute(FLEET_ID, FROM, TO);

    const findMany = (prisma as unknown as { driver: { findMany: jest.Mock } }).driver.findMany;
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(capturedDriverWhere.where).toEqual({ id: { in: expect.arrayContaining(['d1', 'd2']) }, fleetId: FLEET_ID });
  });

  it('n’interroge AUCUN conducteur quand aucun trajet n’en porte (le cas de mh cars)', async () => {
    const { prisma } = makePrisma({ perimetre: ['v2', 'v3'] });
    const report = await new ReportsStatsService(prisma).compute(FLEET_ID, FROM, TO, {
      role: UserRole.VIEWER, fleetId: FLEET_ID, accessibleVehicleIds: ['v2', 'v3'],
    });

    expect((prisma as unknown as { driver: { findMany: jest.Mock } }).driver.findMany).not.toHaveBeenCalled();
    expect(report.byAttribution!.map((l) => l.key)).toEqual(['group:g2']);
  });

  /**
   * 🔒 Anti-IDOR intra-flotte : le nouvel agrégat est borné comme les anciens. Un VIEWER
   * limité à v3 ne doit apprendre ni le nom d'un conducteur, ni les kilomètres d'un groupe
   * dont aucun véhicule ne lui est accessible.
   */
  it('le périmètre véhicule borne l’agrégat : rien d’un véhicule hors périmètre', async () => {
    const report = await compute({ perimetre: ['v3'] });

    expect(report.byAttribution).toEqual([]);
    expect(report.byAttributionTotal).toBe(0);
    expect(report.unattributedTrips).toEqual({ tripCount: 5, distanceKm: 30, durationHours: 0.5 });
    expect(report.topVehicles.map((v) => v.vehicleId)).toEqual(['v3']);
  });

  it('un périmètre restreint ne rend que les lignes de ses véhicules', async () => {
    const report = await compute({ perimetre: ['v1'] });

    expect(report.byAttribution!.map((l) => l.key)).toEqual(['driver:d1', 'driver:d2']);
    expect(report.unattributedTrips).toEqual({ tripCount: 0, distanceKm: 0, durationHours: 0 });
  });

  /** Une société qui démarre : aucun trajet. Des listes vides, jamais NaN ni `undefined`. */
  it('période sans aucun trajet : listes vides et compteurs à zéro', async () => {
    const { prisma } = makePrisma({ perimetre: [] });
    const report = await new ReportsStatsService(prisma).compute(FLEET_ID, FROM, TO, {
      role: UserRole.VIEWER, fleetId: FLEET_ID, accessibleVehicleIds: [],
    });

    expect(report.byAttribution).toEqual([]);
    expect(report.byAttributionTotal).toBe(0);
    expect(report.unattributedTrips).toEqual({ tripCount: 0, distanceKm: 0, durationHours: 0 });
  });
});
