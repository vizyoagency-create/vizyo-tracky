/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * FILTRE CONDUCTEUR DE LA SYNTHÈSE (F13, seconde moitié) — et l'exception des ALERTES
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * La page Rapports pose UN filtre conducteur. Il doit valoir pour le tableau ET pour tous
 * les agrégats de trajets, sinon l'écran afficherait deux totaux contradictoires — le défaut
 * que cette page a déjà payé (« le compteur annonce 622 et le tableau en affiche 100 »).
 *
 * Ce que ces tests verrouillent :
 *
 *  1. filtré sur un conducteur, les TOTAUX, le récapitulatif PAR VÉHICULE et le
 *     récapitulatif PAR IMPUTATION ne portent que ses trajets — les trois d'un coup,
 *     puisqu'ils sortent de la même passe ;
 *  2. le filtre descend aussi dans les DEUX requêtes écrites à la main (excès établis,
 *     ralenti) : elles ne partagent pas `tripWhere`, et c'est exactement par là que le mode
 *     vie privée leur avait échappé en revue le 2026-09-05 ;
 *  3. ⚠️ **les ALERTES ne bougent pas** — décision assumée, figée ici (voir le test dédié) ;
 *  4. `none` isole les trajets SANS conducteur, le vrai outil du client ;
 *  5. sans paramètre, RIEN ne change : c'est la synthèse que le client lit tous les jours,
 *     et le PDF comme l'Excel la reprennent ;
 *  6. et le cas d'un client réel : un VIEWER borné à quelques véhicules QUI FILTRE sur un
 *     conducteur — périmètre véhicule, mode vie privée et filtre conducteur composés dans
 *     la MÊME requête, ce qu'aucun des tests ci-dessus ne faisait (voir les deux derniers).
 *
 * Le simulacre HONORE les bornes qu'il lit — `where.driverId`, `where.vehicleId.in`, et les
 * clauses des requêtes brutes : un faux qui rendrait toujours les mêmes lignes ne prouverait
 * rien des chiffres. Il lit chaque valeur liée DANS le fragment qui porte sa clause, jamais à
 * la forme de la valeur (cf. `valeurDeClause` : c'est un piège qui a déjà été armé ici).
 */
import { UserRole } from '@prisma/client';
import { FleetStatsReport, ReportsStatsService } from './reports-stats.service';

/**
 * ⚠️ UN VRAI UUID, ET C'EST UNE PROTECTION, PAS UNE COQUETTERIE.
 *
 * Ce jeu d'essai portait `'fleet-1'`. Le simulacre des requêtes brutes, lui, retrouvait le
 * conducteur en cherchant parmi les valeurs liées celle qui AVAIT LA FORME d'un UUID. Or
 * `fleetId` est lié EN PREMIER dans les deux requêtes : le jour où quelqu'un aurait rendu ce
 * jeu réaliste — un geste d'hygiène évident, et souhaitable —, le `find` aurait rendu le
 * fleetId, le simulacre aurait filtré sur lui, et les deux seuls tests qui protègent les excès
 * établis et le ralenti seraient tombés sur des zéros SANS que personne ne comprenne pourquoi.
 * Le fleetId est donc désormais un UUID, exprès : la forme ne distingue plus rien, et le
 * simulacre lit la valeur DANS le fragment qui porte la clause (cf. `valeurDeClause`).
 */
const FLEET_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FROM = new Date('2026-06-01T00:00:00.000Z');
const TO = new Date('2026-07-01T00:00:00.000Z');

/** UUID : le filtre les exige (cf. `common/driver-scope`), un « d1 » serait refusé. */
const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
/** Un conducteur de la société qui n'a PAS roulé sur la période (congés, arrêt). */
const D3 = '33333333-3333-4333-8333-333333333333';

const G1 = { id: 'g1', name: 'Livraisons Nord' };
const G2 = { id: 'g2', name: 'Atelier' };

const VEHICULES = [
  { id: 'v1', plate: 'AA-111-AA', groupe: G1 },
  { id: 'v2', plate: 'BB-222-BB', groupe: G2 },
  { id: 'v3', plate: 'CC-333-CC', groupe: null },
];

/**
 * Le jeu demandé : DEUX conducteurs se partagent v1, et D1 roule aussi sur v2. Filtrer sur
 * D1 doit donc amputer v1 (120 des 200 km) sans faire disparaître v2 — un filtre qui ne
 * saurait que retirer des véhicules entiers passerait ce test à côté.
 */
const TRAJETS = [
  { vehicleId: 'v1', driverId: D1, km: 120, sec: 7200, trajets: 4 },
  { vehicleId: 'v1', driverId: D2, km: 80, sec: 3600, trajets: 3 },
  { vehicleId: 'v2', driverId: D1, km: 45, sec: 1800, trajets: 2 },
  // v2 roule aussi SANS conducteur : sous « none », son groupe doit reprendre la main.
  { vehicleId: 'v2', driverId: null, km: 20, sec: 900, trajets: 1 },
  // v3 : ni conducteur ni groupe — le cas de mh cars, compté mais jamais classé.
  { vehicleId: 'v3', driverId: null, km: 30, sec: 1800, trajets: 5 },
];

const EXCES = [
  { vehicleId: 'v1', driverId: D1, exces: 3, trajets: 2, pire: 18.4 },
  { vehicleId: 'v1', driverId: D2, exces: 1, trajets: 1, pire: 7.2 },
  { vehicleId: 'v2', driverId: D1, exces: 2, trajets: 2, pire: 11 },
  { vehicleId: 'v2', driverId: null, exces: 1, trajets: 1, pire: 5 },
  { vehicleId: 'v3', driverId: null, exces: 9, trajets: 4, pire: 42 },
];

const RALENTI = [
  { vehicleId: 'v1', driverId: D1, ralenti: 600 },
  { vehicleId: 'v1', driverId: D2, ralenti: 300 },
  { vehicleId: 'v2', driverId: D1, ralenti: 120 },
  { vehicleId: 'v2', driverId: null, ralenti: 60 },
  { vehicleId: 'v3', driverId: null, ralenti: 90 },
];

const CONDUCTEURS = [
  { id: D1, firstName: 'Sohaib', lastName: 'Hamanni' },
  { id: D2, firstName: 'Amine', lastName: 'Berrada' },
];

/** Alertes de la période — elles appartiennent à un VÉHICULE, pas à un conducteur. */
const ALERTES_PAR_TYPE = [
  { type: 'SPEEDING', _count: { _all: 7 } },
  { type: 'HARSH_BRAKING', _count: { _all: 5 } },
];
const ALERTES_PAR_GRAVITE = [
  { severity: 'WARNING', _count: { _all: 9 } },
  { severity: 'CRITICAL', _count: { _all: 3 } },
];

/** Un fragment `Prisma.sql` interpolé dans une requête brute. */
interface FragmentSql {
  strings: readonly string[];
  values: unknown[];
}

const estFragment = (v: unknown): v is FragmentSql =>
  !!v && typeof v === 'object' && Array.isArray((v as FragmentSql).strings);

/**
 * Aplatit une requête brute (fragments `Prisma.sql` compris) en un texte lisible et la liste
 * de ses valeurs liées. Sans cela, le simulacre ne verrait pas la clause conducteur : elle
 * est injectée comme un fragment, pas écrite dans le gabarit principal.
 */
function aplatirSql(strings: readonly string[], valeurs: unknown[]): { texte: string; valeurs: unknown[] } {
  let texte = '';
  const plates: unknown[] = [];
  strings.forEach((morceau, i) => {
    texte += morceau;
    if (i >= valeurs.length) return;
    const v = valeurs[i];
    if (estFragment(v)) {
      const sous = aplatirSql(v.strings, v.values);
      texte += sous.texte;
      plates.push(...sous.valeurs);
    } else {
      texte += ' ? ';
      plates.push(v);
    }
  });
  return { texte, valeurs: plates };
}

/**
 * ── COMMENT LE SIMULACRE RETROUVE UNE VALEUR LIÉE : PAR SA CLAUSE, JAMAIS PAR SA FORME ──
 *
 * Rend la valeur portée par le fragment `Prisma.sql` dont le texte contient `marqueur`.
 * Chaque borne du service est injectée comme un fragment séparé (`AND t."driverId" = ${…}`,
 * `AND ta."vehicleId" = ANY(${…})`), donc la valeur et la clause qui l'explique voyagent
 * ensemble : les lire ensemble, c'est ne plus avoir à DEVINER laquelle est laquelle.
 *
 * ⚠️ POURQUOI LA DEVINETTE PAR FORME ÉTAIT UN PIÈGE ARMÉ. La version précédente cherchait
 * « la valeur liée qui ressemble à un UUID ». Elle ne marchait que parce que `FLEET_ID`
 * valait `'fleet-1'` dans ce fichier — un accident du jeu d'essai. `fleetId` est lié AVANT
 * le conducteur dans les DEUX requêtes : rendre le jeu réaliste (ce qu'on vient de faire)
 * aurait fait rendre le fleetId au `find`, filtrer sur lui, et rendre zéro ligne d'excès et
 * zéro seconde de ralenti. Les tests seraient devenus FAUX sans devenir ROUGES d'eux-mêmes —
 * sur les deux seules requêtes du service auxquelles le mode vie privée avait déjà échappé
 * le 2026-09-05. Une correction de test doit se casser bruyamment, pas mentir doucement.
 */
function valeurDeClause(valeurs: readonly unknown[], marqueur: string): unknown {
  for (const v of valeurs) {
    if (!estFragment(v)) continue;
    if (v.strings.some((s) => s.includes(marqueur))) return v.values[0];
    const imbrique = valeurDeClause(v.values, marqueur);
    if (imbrique !== undefined) return imbrique;
  }
  return undefined;
}

interface OptionsBanc {
  /** `undefined` = pas de filtre ; un UUID ; ou `none`. */
  driverId?: string;
  /**
   * Périmètre véhicule de l'appelant (VIEWER scopé groupe / véhicules). `undefined` = 'ALL',
   * c'est-à-dire un FLEET_ADMIN, et le service n'injecte alors AUCUNE borne véhicule.
   */
  perimetre?: string[];
  /**
   * Véhicules dont le boîtier s'est tu depuis 89 j : ils sortent du PARC EXPLOITÉ, donc du
   * dénominateur de la moyenne. Sert au seul cas où le repli anti-division-par-zéro peut
   * jouer sous filtre — un conducteur qui n'a roulé que sur des véhicules devenus muets.
   */
  dormants?: string[];
}

/** Silence largement au-delà du seuil de 7 j — un dormant, pas un véhicule garé. */
const SILENCE_DORMANT_MS = 89 * 24 * 3600 * 1000;

function makePrisma(opts: OptionsBanc = {}) {
  /** Le `where` que le service a posé sur les ALERTES — le test le relit tel quel. */
  const alertWheres: Record<string, unknown>[] = [];

  /** Le filtre EFFECTIF, tel que le service l'a écrit dans le `where` des trajets. */
  const filtreDeWhere = (where: Record<string, unknown>) =>
    'driverId' in where ? (where['driverId'] as string | null) : undefined;

  /** Le périmètre véhicule EFFECTIF, tel que le service l'a écrit dans le même `where`. */
  const perimetreDeWhere = (where: Record<string, unknown>): string[] | undefined => {
    const borne = where['vehicleId'] as { in?: string[] } | undefined;
    return Array.isArray(borne?.in) ? borne.in : undefined;
  };

  /**
   * Le simulacre HONORE les deux bornes qu'il lit — conducteur ET périmètre véhicule. Un
   * faux qui n'honorerait que la première rendrait les mêmes lignes avec ou sans périmètre :
   * le test composé plus bas serait vert quoi qu'il arrive au service.
   */
  const garde =
    (filtre: string | null | undefined, perimetre?: string[]) =>
    (t: { driverId: string | null; vehicleId: string }) =>
      (filtre === undefined || t.driverId === filtre) &&
      (perimetre === undefined || perimetre.includes(t.vehicleId));

  const dormants = new Set(opts.dormants ?? []);
  const vehicleRows = VEHICULES.map((v) => ({
    id: v.id,
    plate: v.plate,
    type: 'CAR',
    fuelConsumptionL100km: 7,
    energy: 'DIESEL',
    calibratedConsumptionL100km: null,
    calibratedTanks: 0,
    tracker: {
      id: `t-${v.id}`,
      lastSeenAt: new Date(Date.now() - (dormants.has(v.id) ? SILENCE_DORMANT_MS : 0)),
    },
    groups: v.groupe ? [{ group: v.groupe }] : [],
  }));

  const mocks = {
    fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID, name: 'Flotte test', fuelPriceEurL: 1.85 }) },
    vehicle: {
      // Honore `id: { in: [...] }` : sous périmètre restreint, le service ne charge QUE les
      // véhicules permis, et tout ce qui en découle (parc total, immobiles) doit suivre.
      findMany: jest.fn(async ({ where }: { where: { id?: { in?: string[] } } }) => {
        const permis = where?.id?.in;
        return Array.isArray(permis) ? vehicleRows.filter((v) => permis.includes(v.id)) : vehicleRows;
      }),
    },
    trip: {
      aggregate: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const lignes = TRAJETS.filter(garde(filtreDeWhere(where), perimetreDeWhere(where)));
        return {
          _count: { _all: lignes.reduce((s, r) => s + r.trajets, 0) },
          _sum: {
            distanceKm: lignes.reduce((s, r) => s + r.km, 0),
            durationSeconds: lignes.reduce((s, r) => s + r.sec, 0),
          },
          _avg: { avgSpeed: 42 },
          _max: { maxSpeed: 110 },
        };
      }),
      groupBy: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
        TRAJETS.filter(garde(filtreDeWhere(where), perimetreDeWhere(where))).map((t) => ({
          vehicleId: t.vehicleId,
          driverId: t.driverId,
          _sum: { distanceKm: t.km, durationSeconds: t.sec },
          _count: { _all: t.trajets },
        })),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    alert: {
      groupBy: jest.fn(async ({ by, where }: { by: string[]; where: Record<string, unknown> }) => {
        alertWheres.push(where);
        return by[0] === 'type' ? ALERTES_PAR_TYPE : ALERTES_PAR_GRAVITE;
      }),
    },
    tripFuelStop: { aggregate: jest.fn().mockResolvedValue({ _avg: { unitPriceEur: null }, _count: { _all: 0 } }) },
    driver: {
      findMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        CONDUCTEURS.filter((d) => where.id.in.includes(d.id)),
      ),
    },
    /**
     * Les deux requêtes brutes se distinguent par leur TEXTE, et le simulacre APPLIQUE les
     * clauses qu'il y lit — conducteur ET périmètre véhicule : un faux qui les ignorerait
     * laisserait passer une clause jamais injectée, c'est-à-dire le bogue même que ce
     * fichier doit attraper.
     */
    $queryRaw: jest.fn((strings: TemplateStringsArray, ...valeurs: unknown[]) => {
      const { texte } = aplatirSql(strings, valeurs);
      // ⚠️ La valeur du conducteur est lue DANS LE FRAGMENT QUI PORTE SA CLAUSE, jamais
      // devinée à la forme de la valeur (cf. `valeurDeClause` et le commentaire de FLEET_ID).
      const clauseConducteur = texte.includes('t."driverId" =');
      const conducteur = valeurDeClause(valeurs, 't."driverId" =') as string | undefined;
      if (clauseConducteur && typeof conducteur !== 'string') {
        // La clause est écrite mais sa valeur est introuvable : le simulacre ne SAIT PLUS
        // filtrer. Il le dit tout haut plutôt que de rendre toutes les lignes — un
        // simulacre qui abandonne en silence rend le test vert et la vérification nulle.
        throw new Error(
          'Simulacre $queryRaw : clause conducteur présente, valeur liée introuvable. ' +
            'La forme du fragment a changé — mettre `valeurDeClause` à jour, pas ce test.',
        );
      }
      const filtre = texte.includes('t."driverId" IS NULL') ? null : conducteur;
      // Même méthode pour le périmètre véhicule — par la clause, pas par la forme. Se dire
      // « c'est la seule valeur liée qui soit un tableau » remarcherait aujourd'hui, et
      // réarmerait exactement le piège qu'on vient de désamorcer au premier tableau ajouté.
      const perimetre = valeurDeClause(valeurs, 'ta."vehicleId" = ANY(') as string[] | undefined;
      const source = texte.includes('idleSec') ? RALENTI : EXCES;
      return Promise.resolve(source.filter(garde(filtre, perimetre)));
    }),
  };

  const prisma = mocks as unknown as ConstructorParameters<typeof ReportsStatsService>[0];

  // `mocks` est rendu à côté de `prisma` : certains tests ont besoin de RELIRE les appels
  // (« aucune requête de noms n'est partie »), ce que le raccourci `compute()` jette.
  return { prisma, mocks, alertWheres };
}

/**
 * L'appelant du banc. Sans `perimetre`, c'est un FLEET_ADMIN qui voit tout — le cas de tous
 * les tests historiques de ce fichier. Avec, c'est un VIEWER borné à quelques véhicules.
 */
const appelant = (perimetre?: string[]) =>
  perimetre
    ? { role: UserRole.VIEWER, fleetId: FLEET_ID, accessibleVehicleIds: perimetre }
    : { role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID, accessibleVehicleIds: 'ALL' as const };

function compute(opts: OptionsBanc = {}): Promise<FleetStatsReport> {
  const { prisma } = makePrisma(opts);
  return new ReportsStatsService(prisma).compute(
    FLEET_ID, FROM, TO,
    appelant(opts.perimetre),
    { driverId: opts.driverId, topN: 50 },
  );
}

const vehicule = (r: FleetStatsReport, id: string) => r.topVehicles.find((v) => v.vehicleId === id);
const ligne = (r: FleetStatsReport, key: string) => r.byAttribution!.find((l) => l.key === key);

describe('ReportsStatsService — filtre conducteur (F13, seconde moitié)', () => {
  it('sans filtre : la synthèse est EXACTEMENT celle d’avant ce lot', async () => {
    const r = await compute();

    expect(r.trips.count).toBe(15); // 4 + 3 + 2 + 1 + 5
    expect(r.trips.totalKm).toBe(295); // 120 + 80 + 45 + 20 + 30
    expect(vehicule(r, 'v1')!.distanceKm).toBe(200);
    expect(vehicule(r, 'v2')!.distanceKm).toBe(65);
    expect(r.byAttribution!.map((l) => l.key)).toEqual([`driver:${D1}`, `driver:${D2}`, 'group:g2']);
    expect(r.consumption.idleSecondsTotal).toBe(1170); // 600 + 300 + 120 + 60 + 90
  });

  /**
   * ⚠️ LE TEST CENTRAL. Les trois vues sortent de la MÊME passe : si le filtre n'atteignait
   * que l'une d'elles, l'écran montrerait un total de flotte au-dessus d'un tableau filtré,
   * et le lecteur croirait l'un des deux.
   */
  it('filtré sur un conducteur : totaux, vue par véhicule et vue par imputation ne portent que SES trajets', async () => {
    const r = await compute({ driverId: D1 });

    // Totaux : 120 + 45 km, 4 + 2 trajets.
    expect(r.trips.count).toBe(6);
    expect(r.trips.totalKm).toBe(165);

    // Vue par véhicule : v1 AMPUTÉ (les 80 km de D2 sont partis), v2 réduit, v3 absent.
    expect(vehicule(r, 'v1')!.distanceKm).toBe(120);
    expect(vehicule(r, 'v1')!.tripCount).toBe(4);
    expect(vehicule(r, 'v2')!.distanceKm).toBe(45);
    expect(vehicule(r, 'v3')).toBeUndefined();

    // Vue par imputation : une seule ligne, celle du conducteur demandé.
    expect(r.byAttribution!.map((l) => l.key)).toEqual([`driver:${D1}`]);
    expect(ligne(r, `driver:${D1}`)).toMatchObject({
      label: 'Sohaib Hamanni',
      tripCount: 6,
      distanceKm: 165,
      durationHours: 2.5, // 7 200 s + 1 800 s
    });

    // Et les deux moitiés retombent l'une sur l'autre : aucun total contradictoire.
    expect(r.byAttribution!.reduce((s, l) => s + l.distanceKm, 0)).toBeCloseTo(r.trips.totalKm, 6);
    expect(r.topVehicles.reduce((s, v) => s + v.distanceKm, 0)).toBeCloseTo(r.trips.totalKm, 6);
  });

  /**
   * Les excès et le ralenti viennent de requêtes écrites à la MAIN, qui ne partagent pas
   * `tripWhere`. C'est précisément par là que le mode vie privée leur avait échappé : sans
   * clause injectée, la ligne d'un conducteur naîtrait de ses trajets puis encaisserait les
   * excès de ses collègues.
   */
  it('les excès et le ralenti suivent le filtre, comme les kilomètres', async () => {
    const r = await compute({ driverId: D1 });

    expect(ligne(r, `driver:${D1}`)).toMatchObject({
      speedingCount: 5, // 3 (v1) + 2 (v2), jamais les 4 de D2 ni les 9 de v3
      speedingTripCount: 4,
      worstOverKmh: 18.4, // le PIRE de SES excès, pas celui du parc (42)
      idleSeconds: 720, // 600 + 120
    });
    // Le total de flotte tombe sur la même somme : un ralenti qui ne retomberait sur rien
    // ferait douter des deux chiffres.
    expect(r.consumption.idleSecondsTotal).toBe(720);
    expect(vehicule(r, 'v1')!.speedingCount).toBe(3);
    expect(vehicule(r, 'v1')!.worstOverKmh).toBe(18.4);
  });

  /**
   * ══ L'EXCEPTION ASSUMÉE : LES ALERTES NE SE FILTRENT PAS PAR CONDUCTEUR ═══════════════
   *
   * Une alerte appartient à un VÉHICULE : elle n'a pas de conducteur. Pour la rattacher à
   * quelqu'un, il faudrait deviner qui conduisait à son horodatage — une jointure
   * approximative dont le résultat, présenté comme un fait, accuserait une personne
   * d'alertes qu'on ne peut pas lui imputer. On préfère un compte VRAI sur un périmètre
   * plus large, dit en toutes lettres à l'écran, à un compte plausible et faux.
   *
   * Ce test fige la décision dans les deux sens : le compte ne bouge pas, ET aucun `where`
   * d'alerte ne porte de `driverId` — un filtre ajouté « par cohérence » le casserait.
   */
  it('⚠️ les ALERTES restent sur le périmètre véhicule : décision assumée, pas un oubli', async () => {
    const sansFiltre = await compute();
    const { prisma, alertWheres } = makePrisma({ driverId: D1 });
    const filtre = await new ReportsStatsService(prisma).compute(
      FLEET_ID, FROM, TO,
      { role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID, accessibleVehicleIds: 'ALL' },
      { driverId: D1, topN: 50 },
    );

    // Le total est le MÊME : les alertes ne se réduisent pas au conducteur choisi…
    expect(filtre.alerts.total).toBe(12);
    expect(filtre.alerts.total).toBe(sansFiltre.alerts.total);
    expect(filtre.alerts.byType).toEqual(sansFiltre.alerts.byType);

    // …et rien dans leur requête ne mentionne un conducteur.
    expect(alertWheres).toHaveLength(2); // par type, par gravité
    for (const where of alertWheres) {
      expect(where).not.toHaveProperty('driverId');
    }
  });

  /**
   * Le vrai outil du client : 1 905 trajets sur 1 956 chez « mh cars » n'ont aucun
   * conducteur (mesuré le 2026-09-05). C'est cette liste qu'il doit pouvoir isoler pour la
   * corriger — et le groupe du véhicule reprend alors la main dans l'imputation.
   */
  it('« none » isole les trajets SANS conducteur, et le groupe du véhicule reprend la main', async () => {
    // Simulacre construit EN CLAIR : le raccourci `compute()` jette le `prisma`, or c'est
    // lui qui porte la preuve attendue plus bas — la requête de noms qui NE part pas.
    const { prisma, mocks } = makePrisma({ driverId: 'none' });
    const r = await new ReportsStatsService(prisma).compute(
      FLEET_ID, FROM, TO, appelant(), { driverId: 'none', topN: 50 },
    );

    expect(r.trips.count).toBe(6); // 1 (v2) + 5 (v3)
    expect(r.trips.totalKm).toBe(50); // 20 + 30
    expect(vehicule(r, 'v1')).toBeUndefined(); // v1 n'a que des trajets conduits
    expect(r.byAttribution!.map((l) => l.key)).toEqual(['group:g2']);
    expect(ligne(r, 'group:g2')).toMatchObject({ label: 'Atelier', tripCount: 1, distanceKm: 20 });
    // v3 n'a ni conducteur ni groupe : compté, jamais une ligne.
    expect(r.unattributedTrips).toEqual({ tripCount: 5, distanceKm: 30, durationHours: 0.5 });

    /**
     * ⚠️ CE QUE LE COMMENTAIRE PROMETTAIT, ET QUE L'ASSERTION NE FAISAIT PAS.
     *
     * Il était écrit ici « aucune requête ne doit aller en chercher », sous la seule
     * assertion `byAttribution.some(kind === 'driver') === false` — qui ne dit rien d'une
     * requête, et qui était de surcroît DÉJÀ IMPLIQUÉE par le `toEqual(['group:g2'])` de
     * trois lignes plus haut. Deux phrases qui ouvrent pareil : le test de l'une était
     * satisfait par l'autre, et l'aller-retour à la base pouvait revenir sans réveiller
     * personne. On vérifie donc la requête elle-même — c'est elle qui coûte, et c'est elle
     * que le garde `driverIds.length > 0` du service est censé éviter.
     */
    expect(mocks.driver.findMany).not.toHaveBeenCalled();
  });

  /**
   * ── CE QUE LE FILTRE FAIT AUSSI, ET QUE L'ÉCRAN DOIT DIRE ────────────────────────────
   *
   * `activeDuringPeriod` et « véhicules immobiles » se déduisent des trajets du périmètre.
   * Sous un filtre conducteur, « immobile » ne veut donc plus dire « n'a pas roulé » mais
   * « n'a pas roulé AVEC ce conducteur ». Le chiffre reste vrai ; c'est sa LECTURE qui
   * change, et la carte de l'écran porte la phrase qui l'énonce.
   */
  it('le parc actif se lit « avec ce conducteur » : v3, qu’il n’a jamais conduit, devient immobile', async () => {
    const r = await compute({ driverId: D1 });

    expect(r.vehicles.total).toBe(3); // le parc CONTRACTUEL ne bouge pas
    expect(r.vehicles.activeDuringPeriod).toBe(2); // v1 et v2
    expect(r.vehicles.idleVehicles.map((v) => v.vehicleId)).toEqual(['v3']);
  });

  /**
   * ══ LA MOYENNE KILOMÉTRIQUE : MÊME POPULATION DES DEUX CÔTÉS DE LA DIVISION ═══════════
   *
   * Le numérateur descend de `tripWhere`, donc du filtre. Le dénominateur venait du PARC :
   * les 165 km de D1 se divisaient par les 3 véhicules exploités de la société — dont v3,
   * qu'il n'a jamais conduit — et rendaient 55,0 au lieu de 82,5. Ce chiffre n'existe QUE
   * dans le PDF (aucun écran ne l'affiche, l'Excel non plus) : rien ne pouvait le démentir
   * une fois le fichier parti par courriel.
   *
   * Le test vérifie AUSSI l'invariant lui-même — base ÷ base retombe sur la moyenne
   * publiée — sinon la même dérive reviendra au prochain filtre ajouté.
   */
  it('la moyenne par véhicule se divise par les véhicules DE CE FILTRE, jamais par le parc', async () => {
    const r = await compute({ driverId: D1 });

    expect(r.trips.avgKmBasisVehicles).toBe(2); // v1 et v2 — v3 n'est pas à lui
    expect(r.trips.avgKmBasisKm).toBe(165);
    expect(r.trips.avgKmPerVehicle).toBe(82.5); // et non 165 / 3 = 55,0
    // L'invariant, refait à la main : les deux moitiés décrivent la même population.
    expect(Math.round((r.trips.avgKmBasisKm / r.trips.avgKmBasisVehicles) * 10) / 10)
      .toBe(r.trips.avgKmPerVehicle);
    // Et le numérateur est bien le total du filtre, pas un sous-total inexplicable.
    expect(r.trips.avgKmBasisKm).toBe(r.trips.totalKm);
    expect(r.topVehicles.reduce((s, v) => s + v.distanceKm, 0)).toBe(r.trips.avgKmBasisKm);

    // « none » suit la même règle : 50 km sur les 2 véhicules qui ont roulé sans conducteur.
    const sans = await compute({ driverId: 'none' });
    expect(sans.trips.avgKmBasisVehicles).toBe(2);
    expect(sans.trips.avgKmPerVehicle).toBe(25); // et non 50 / 3 = 16,7

    // ⚠️ SANS FILTRE, RIEN NE BOUGE : un véhicule exploité qui n'a pas roulé reste au
    // dénominateur — c'est tout le sens d'un taux d'emploi de parc.
    const flotte = await compute();
    expect(flotte.trips.avgKmBasisVehicles).toBe(3);
    expect(flotte.trips.avgKmPerVehicle).toBe(98.3); // 295 / 3
  });

  /**
   * Le repli anti-division-par-zéro, sous filtre : D1 n'a roulé que sur v1 et v2, tous deux
   * devenus muets depuis 89 j. La base « exploités ∩ conduits » est donc VIDE.
   *
   * ⚠️ Le repli historique retombe sur le PARC ENTIER — sous filtre, ce serait de nouveau
   * les km d'une personne divisés par des véhicules qu'elle ne conduit pas, la faute qu'on
   * vient de fermer, rentrée par la porte de derrière. On replie sur les véhicules que ce
   * filtre a fait rouler : `totalKm` est exactement leur somme.
   */
  it('conducteur dont tous les véhicules sont dormants : le repli ne rend JAMAIS le parc', async () => {
    const r = await compute({ driverId: D1, dormants: ['v1', 'v2'] });

    expect(r.vehicles.exploited).toBe(1); // seul v3 parle encore — et D1 ne l'a jamais conduit
    expect(r.trips.avgKmBasisVehicles).toBe(2); // v1 + v2, et non les 3 du parc
    expect(r.trips.avgKmBasisKm).toBe(165);
    expect(r.trips.avgKmPerVehicle).toBe(82.5); // et non 165 / 3 = 55,0
  });

  /**
   * ── L'AUTRE BOUT DU REPLI : UN CONDUCTEUR QUI N'A PAS ROULÉ DU TOUT ──────────────────
   *
   * Congés, arrêt, embauche en fin de mois : la base est VIDE des deux côtés. Le rapport
   * doit rendre 0, pas les kilomètres du parc divisés par le parc — et surtout jamais NaN
   * ni Infinity, qui s'imprimeraient tels quels dans le PDF.
   */
  it('conducteur sans un seul trajet : 0 partout, jamais le parc ni NaN', async () => {
    const r = await compute({ driverId: D3 });

    expect(r.trips.count).toBe(0);
    expect(r.trips.totalKm).toBe(0);
    expect(r.trips.avgKmBasisVehicles).toBe(0); // et non les 3 véhicules exploités du parc
    expect(r.trips.avgKmBasisKm).toBe(0);
    expect(r.trips.avgKmPerVehicle).toBe(0);
    expect(Number.isFinite(r.trips.avgKmPerVehicle)).toBe(true);
    // Le parc, lui, ne bouge pas : c'est un état de la flotte, pas du filtre.
    expect(r.vehicles.total).toBe(3);
    expect(r.vehicles.exploited).toBe(3);
    expect(r.vehicles.activeDuringPeriod).toBe(0);
  });

  it('refuse une valeur qui n’est ni un UUID ni « none » (la route lit un @Query brut)', async () => {
    await expect(compute({ driverId: 'tous' })).rejects.toThrow(/Filtre conducteur invalide/);
    await expect(compute({ driverId: "' OR 1=1 --" })).rejects.toThrow(/Filtre conducteur invalide/);
  });

  /** La clause part bien dans les DEUX requêtes brutes, et sous sa forme SQL attendue. */
  it('injecte la clause dans les deux requêtes écrites à la main, et rien quand aucun filtre', async () => {
    const textes = async (driverId?: string) => {
      const { prisma } = makePrisma({ driverId });
      await new ReportsStatsService(prisma).compute(
        FLEET_ID, FROM, TO,
        { role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID, accessibleVehicleIds: 'ALL' },
        { driverId },
      );
      return (prisma as unknown as { $queryRaw: jest.Mock }).$queryRaw.mock.calls.map(
        (c: unknown[]) => aplatirSql(c[0] as TemplateStringsArray, c.slice(1)).texte,
      );
    };

    const avecConducteur = await textes(D1);
    expect(avecConducteur).toHaveLength(2);
    for (const t of avecConducteur) expect(t).toContain('AND t."driverId" =');

    // ⚠️ LE COMPTE AVANT CHAQUE BOUCLE, comme au-dessus : une boucle vide est verte, et la
    // troisième assertion est en plus NÉGATIVE — vide, elle passe deux fois plutôt qu'une.
    // Éprouvé : un service qui cesserait d'émettre ces deux requêtes sous « none » ou sans
    // filtre laissait ce test entièrement vert avant ces deux lignes.
    const sansConducteur = await textes('none');
    expect(sansConducteur).toHaveLength(2);
    for (const t of sansConducteur) expect(t).toContain('AND t."driverId" IS NULL');

    const aucunFiltre = await textes(undefined);
    expect(aucunFiltre).toHaveLength(2);
    for (const t of aucunFiltre) expect(t).not.toContain('AND t."driverId"');
  });

  /**
   * ══ LES TROIS BORNES DANS LA MÊME REQUÊTE — LE CAS D'UN CLIENT RÉEL ═══════════════════
   *
   * Un VIEWER borné à deux véhicules qui filtre sur un conducteur. C'est le cas courant chez
   * un client à plusieurs agences, et c'est la COMPOSITION des bornes, pas chacune prise à
   * part, qui a déjà lâché sur ce chantier.
   *
   * Ce que chaque test protégeait jusqu'ici, SÉPARÉMENT :
   *   • le périmètre véhicule (`reports-scope.security.spec.ts`) — sans filtre conducteur ;
   *   • le mode vie privée (la jointure `privacyModeEnabled IS NOT TRUE`) ;
   *   • le filtre conducteur (les tests ci-dessus) — en `accessibleVehicleIds: 'ALL'`.
   * Les deux requêtes écrites à la main portent bien les trois clauses, mais AUCUN test ne
   * les mettait ensemble dans la même requête : chaque borne était vérifiée dans un monde où
   * les deux autres étaient absentes.
   *
   * ⚠️ POURQUOI CETTE COMPOSITION-LÀ. Le mode vie privée avait échappé à ces deux requêtes
   * (relevé le 2026-09-05) précisément parce qu'il vivait dans `tripWhere`, que ces requêtes
   * ne partagent pas. Le garde-fou du service ne protège que la CRÉATION d'une ligne
   * d'imputation, pas son ABONDEMENT : un groupe mêlant un véhicule normal et un véhicule
   * sous vie privée voyait sa ligne naître du premier (2 trajets, 12 km) puis encaisser les
   * excès du second — « 40 excès, +55 km/h », la conduite d'un véhicule que le client avait
   * explicitement mis sous vie privée. Une borne qui tombe pendant qu'une autre tient ne se
   * voit sur AUCUN des totaux : elle ne change que la ligne d'un tiers.
   */
  it('VIEWER à périmètre restreint + filtre conducteur : les trois bornes dans la MÊME requête', async () => {
    const PERIMETRE = ['v1', 'v2'];
    const { prisma, mocks } = makePrisma({ driverId: D1, perimetre: PERIMETRE });
    const r = await new ReportsStatsService(prisma).compute(
      FLEET_ID, FROM, TO, appelant(PERIMETRE), { driverId: D1, topN: 50 },
    );

    // ── 1. Les DEUX requêtes brutes portent les TROIS bornes, chacune dans son texte ──
    const requetes = mocks.$queryRaw.mock.calls.map((c: unknown[]) =>
      aplatirSql(c[0] as TemplateStringsArray, c.slice(1)),
    );
    expect(requetes).toHaveLength(2); // excès établis, ralenti
    for (const { texte, valeurs } of requetes) {
      expect(texte).toContain('v."privacyModeEnabled" IS NOT TRUE'); // vie privée
      expect(texte).toContain('AND ta."vehicleId" = ANY('); // périmètre véhicule
      expect(texte).toContain('AND t."driverId" ='); // filtre conducteur
      // Et les valeurs liées sont bien celles-là — une clause écrite sur la mauvaise
      // valeur borne une requête sans borner le rapport.
      expect(valeurs).toContainEqual(PERIMETRE);
      expect(valeurs).toContain(D1);
      // Le fleetId est lié À CÔTÉ du conducteur, et les deux sont maintenant des UUID :
      // c'est exactement la situation que l'ancien repérage par forme ne survivait pas.
      expect(valeurs).toContain(FLEET_ID);
    }

    // ── 2. Et le rapport qui en sort est celui du conducteur, dans son périmètre ──
    expect(r.vehicles.total).toBe(2); // le VIEWER ne connaît même pas l'existence de v3
    expect(r.trips.count).toBe(6);
    expect(r.trips.totalKm).toBe(165);
    expect(vehicule(r, 'v3')).toBeUndefined();
    expect(r.byAttribution!.map((l) => l.key)).toEqual([`driver:${D1}`]);
    expect(ligne(r, `driver:${D1}`)).toMatchObject({
      speedingCount: 5, // 3 (v1) + 2 (v2) — jamais les 4 de D2, jamais les 9 de v3
      worstOverKmh: 18.4, // et surtout pas les +42 km/h de v3, hors de son périmètre
      idleSeconds: 720, // 600 + 120
    });
    expect(r.consumption.idleSecondsTotal).toBe(720);
  });

  /**
   * La même composition sous « none » : le périmètre doit RESTER en place quand le filtre
   * conducteur devient `IS NULL`. Ces deux clauses viennent de la même expression injectée
   * aux deux mêmes endroits — une seule ligne mal écrite les fait tomber ensemble, et c'est
   * sous « none » que le client trie ses 1 905 trajets sans conducteur.
   */
  it('VIEWER à périmètre restreint + « none » : le périmètre tient, le rapport se réduit à v2', async () => {
    const PERIMETRE = ['v1', 'v2'];
    const { prisma, mocks } = makePrisma({ driverId: 'none', perimetre: PERIMETRE });
    const r = await new ReportsStatsService(prisma).compute(
      FLEET_ID, FROM, TO, appelant(PERIMETRE), { driverId: 'none', topN: 50 },
    );

    // ⚠️ Le compte AVANT la boucle : sans lui, zéro requête ferait passer zéro assertion —
    // une boucle vide est verte, et c'est le genre d'assertion morte que ce lot répare.
    expect(mocks.$queryRaw.mock.calls).toHaveLength(2);
    for (const c of mocks.$queryRaw.mock.calls as unknown[][]) {
      const { texte, valeurs } = aplatirSql(c[0] as TemplateStringsArray, c.slice(1));
      expect(texte).toContain('v."privacyModeEnabled" IS NOT TRUE');
      expect(texte).toContain('AND ta."vehicleId" = ANY(');
      expect(texte).toContain('AND t."driverId" IS NULL');
      expect(valeurs).toContainEqual(PERIMETRE);
    }

    // Seul v2 a roulé sans conducteur DANS ce périmètre : les 30 km et les 9 excès de v3
    // restent invisibles, et son groupe absent (v3 n'en a pas, mais il n'est plus là non plus).
    expect(r.trips.count).toBe(1);
    expect(r.trips.totalKm).toBe(20);
    expect(r.byAttribution!.map((l) => l.key)).toEqual(['group:g2']);
    expect(ligne(r, 'group:g2')).toMatchObject({ speedingCount: 1, worstOverKmh: 5, idleSeconds: 60 });
    expect(r.unattributedTrips).toEqual({ tripCount: 0, distanceKm: 0, durationHours: 0 });
  });
});
