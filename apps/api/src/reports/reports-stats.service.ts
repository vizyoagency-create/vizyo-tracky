import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import {
  co2DuCarburant,
  DORMANT_STOP_COUNTING_MS,
  EXCES_DUREE_MIN_SEC,
  formatSilenceLabel,
  isVehicleDormant,
  isVehicleExploited,
  trackerSilenceMs,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';

/**
 * V1.5 (Sprint L) — Agregation KPI pour les rapports & export.
 *
 * Fournit `compute(fleetId, from, to)` qui retourne les statistiques
 * consolidees d'une flotte sur une periode donnee : km, duree, vitesse moyenne,
 * top vehicules, alertes, consommation estimee.
 *
 * La consommation est estimee via :
 *   distance_km * (Vehicle.fuelConsumptionL100km || default_par_type) / 100
 *   * Fleet.fuelPriceEurL
 */

const DEFAULT_CONSUMPTION_L100KM: Record<string, number> = {
  CAR: 7,
  TRUCK: 22,
  VAN: 10,
  MOTORCYCLE: 4,
  BICYCLE: 0,
  BUS: 28,
  CONSTRUCTION: 18,
  OTHER: 8,
};

export interface FleetStatsReport {
  fleet: { id: string; name: string };
  period: { from: string; to: string; days: number };
  vehicles: {
    /**
     * Total CONTRACTUEL du parc sur le perimetre du rapport. Ne bouge PAS avec la
     * dormance : un vehicule dont le boitier s'est tu reste un vehicule du parc,
     * il disparaitrait du chiffre facture sinon.
     */
    total: number;
    activeDuringPeriod: number;
    /**
     * Parc EXPLOITE = boitier present, deja vu au moins une fois, et vu depuis
     * moins de 7 j. C'est le DENOMINATEUR des moyennes (cf. `avgKmPerVehicle`).
     */
    exploited: number;
    /** Exclus du denominateur car boitier MUET depuis > 7 j (il parlait, il s'est tu). */
    dormant: number;
    /**
     * Exclus du denominateur car AUCUN boitier (ou boitier jamais connecte). Fait
     * DIFFERENT du silence : ces vehicules n'ont jamais pu produire de km captes,
     * les compter dans une moyenne kilometrique n'a aucun sens. Compte a part pour
     * ne pas les faire passer pour des pannes.
     */
    withoutTracker: number;
    /** Detail des dormants (plaque + anciennete du silence) pour la mention du rapport. */
    dormantVehicles: { vehicleId: string; plate: string; silenceLabel: string | null }[];
  };
  trips: {
    count: number;
    totalKm: number;
    totalDurationHours: number;
    /**
     * Distance moyenne par vehicule du parc EXPLOITE (cf. `vehicles.exploited`).
     * Numerateur et denominateur portent sur la MEME population : on ne divise pas
     * les km de tout le parc par un sous-ensemble de vehicules.
     */
    avgKmPerVehicle: number;
    /** Denominateur reellement utilise pour `avgKmPerVehicle` (rend le calcul verifiable). */
    avgKmBasisVehicles: number;
    /**
     * Numerateur reellement utilise : km des seuls vehicules du parc exploite.
     * EXCEPTION du repli : quand `vehicles.exploited` vaut 0 (parc 100 % dormant ou
     * non equipe), ce champ porte `trips.totalKm` — on ne peut pas diviser par zero,
     * on retombe sur le parc entier. La mention du rapport dit alors explicitement
     * que la moyenne est indicative.
     */
    avgKmBasisKm: number;
    avgSpeedKmh: number;
    maxSpeedKmh: number;
  };
  alerts: {
    total: number;
    byType: { type: string; count: number }[];
    bySeverity: { severity: string; count: number }[];
  };
  consumption: {
    estimatedLiters: number;
    estimatedCostEur: number;
    fuelPriceEurL: number;
    /** Prix carburant RÉELLEMENT CONSTATÉ en station sur la période (€/L moyen), ou null si aucun passage capté (P3). */
    observedPriceEurL: number | null;
    /** Coût estimé au prix constaté (litres × prix constaté), ou null. */
    estimatedCostAtObservedEur: number | null;
    /** Nombre de passages station ayant fourni un prix (échantillon du prix constaté). */
    observedSampleCount: number;
    /**
     * CO₂ estimé de la période, en kg — somme des litres de chaque véhicule multipliés par le
     * facteur de SON énergie, jamais par un facteur moyen de flotte.
     *
     * ⚠️ Combustion seule (du réservoir à la roue) : ni la production ni le transport du
     * carburant ne sont comptés. Ce n'est pas une analyse de cycle de vie, et l'écran ne doit
     * pas le laisser croire.
     */
    estimatedCo2Kg: number;
  };
  topVehicles: {
    vehicleId: string;
    plate: string;
    distanceKm: number;
    tripCount: number;
    estimatedConsumptionL: number;
    group: { id: string; name: string } | null;
    /**
     * ── AJOUTÉS LE 2026-09-04, POUR QUE L'ÉCRAN CESSE DE COMPTER TOUT SEUL ─────────────
     *
     * Le récapitulatif « Par véhicule » de la page Rapports agrégeait les trajets CHARGÉS —
     * cent lignes sur 391 — et non la période. C'est le premier tableau qu'un gestionnaire
     * lit pour comparer ses véhicules, et il était faux dès l'ouverture. Il le DISAIT, ce
     * qui est mieux que rien, mais dire un chiffre faux ne le rend pas vrai.
     *
     * Ces deux mesures manquaient à l'agrégat serveur, et c'est la seule raison pour
     * laquelle l'écran continuait de calculer lui-même.
     */
    durationHours: number;
    /**
     * ⚠️ Kilomètres parcourus ÷ heures de conduite, jamais la moyenne des moyennes de
     * trajet. Même définition que la vitesse moyenne de flotte ci-dessus, pour la même
     * raison : un trajet de 400 m à 8 km/h ne doit pas peser autant qu'un trajet de 180 km.
     * L'écran, lui, faisait la moyenne des moyennes.
     */
    avgSpeedKmh: number;
    /**
     * ── COMBIEN D'EXCÈS, ET LE PIRE — PAR VÉHICULE (F06) ──────────────────────────────
     *
     * « Quel véhicule dépasse le plus ? » n'avait aucune réponse sur l'écran : les excès
     * n'existaient qu'au trajet, dans une modale qu'il fallait ouvrir un trajet à la fois.
     * Le gestionnaire devait parcourir la liste à la main pour trouver ce que la base savait
     * déjà.
     *
     * ⚠️ Ce compte applique la RÈGLE ACTUELLE, celle du contrat partagé : un excès établi
     * dure au moins `EXCES_DUREE_MIN_SEC`. Lire `speedingCount`, le compteur écrit au moment
     * de l'analyse, aurait coûté bien moins cher — et aurait été FAUX : au 2026-09-04, 4 036
     * analyses de production ne portent QUE des segments de durée nulle, hérités d'avant le
     * lot V2. Ce tableau aurait accusé des véhicules d'excès que le rapport disciplinaire,
     * lui, refuse d'affirmer.
     *
     * `speedingTripCount` compte les TRAJETS concernés, pas les segments : dix dépassements
     * sur un même trajet ne décrivent pas le même conducteur que dix trajets en excès.
     */
    speedingCount: number;
    speedingTripCount: number;
    worstOverKmh: number;
  }[];
  /**
   * Liste des derniers trajets sur la periode (cap a 30 pour ne pas exploser
   * le PDF). Inclut la note libre + le conducteur — le rapport PDF les rend
   * dans une section dediee "Trajets recents". Trie du plus recent au plus
   * ancien.
   */
  recentTrips: {
    id: string;
    plate: string;
    startedAt: string;
    endedAt: string | null;
    durationSeconds: number;
    distanceKm: number;
    notes: string | null;
    driverName: string | null;
    group: { id: string; name: string } | null;
  }[];
}

@Injectable()
export class ReportsStatsService {
  private readonly logger = new Logger(ReportsStatsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async compute(
    fleetId: string,
    from: Date,
    to: Date,
    requestedBy?: { role: UserRole | string; fleetId: string | null; accessibleVehicleIds?: string[] | 'ALL' },
    filters?: { vehicleIds?: string[]; maxRecentTrips?: number; topN?: number },
  ): Promise<FleetStatsReport> {
    if (requestedBy && requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (requestedBy.fleetId !== fleetId) {
        throw new ForbiddenException('Accès refusé à cette flotte');
      }
    }

    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId } });
    if (!fleet) throw new NotFoundException('Flotte introuvable');

    const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / (24 * 3600 * 1000)));

    // Normalise le filtre vehicleIds demande par l'appelant (filtre groupe /
    // selection multi-vehicules cote front). Liste vide / absente => pas de
    // demande explicite (rapport flotte complet, sauf perimetre user ci-dessous).
    const requestedIds = (filters?.vehicleIds ?? [])
      .map((id) => id?.trim())
      .filter((id): id is string => !!id);
    const uniqueRequestedIds = Array.from(new Set(requestedIds));

    // 🔒 Sprint 5 — borne de PERIMETRE UTILISATEUR (anti-IDOR intra-flotte).
    // Si l'appelant n'a PAS acces a tout (VIEWER/FLEET_MANAGER scope groupe ou
    // vehicules), on borne le rapport a ses vehicules accessibles ET on rejette
    // (403) toute demande explicite hors perimetre — plus strict que l'ancien
    // check « hors flotte ». 'ALL' (admins) => comportement historique.
    // `accessibleVehicleIds` absent (appel interne/cron sans user) => 'ALL'.
    const scope = resolveReportVehicleScope(
      requestedBy?.accessibleVehicleIds ?? 'ALL',
      uniqueRequestedIds,
    );
    const isVehicleScopeRestricted = scope !== 'ALL';
    // Liste effective des vehicleIds qui bornent toutes les requetes ci-dessous.
    const scopedVehicleIds = isVehicleScopeRestricted ? (scope as string[]) : [];

    const vehicles = await this.prisma.vehicle.findMany({
      where: isVehicleScopeRestricted
        ? { fleetId, id: { in: scopedVehicleIds } }
        : { fleetId },
      select: {
        id: true, plate: true, type: true, fuelConsumptionL100km: true,
        // Énergie — SANS elle, le CO₂ de la période ne pouvait pas être calculé : un diesel
        // et une essence n'émettent pas la même chose pour un même litre.
        energy: true,
        // Conso RÉELLE calibrée (méthode du plein) — prime sur l'estimation si mesurée.
        calibratedConsumptionL100km: true, calibratedTanks: true,
        // Fraîcheur du boîtier — JOINTE ici (relation 1-1 déjà chargée par cette
        // requête) plutôt qu'en requête séparée : le VPS a 2 vCPU, un rapport
        // hebdomadaire ne doit pas coûter une requête de plus par flotte.
        // Sert UNIQUEMENT à décider qui compte dans les moyennes (cf. plus bas).
        tracker: { select: { id: true, lastSeenAt: true } },
        // Groupe (unique de-facto) pour l'afficher dans le rapport / PDF.
        groups: {
          select: { group: { select: { id: true, name: true } } },
          orderBy: { group: { name: 'asc' } },
          take: 1,
        },
      },
    });

    // Security check (defense en profondeur, borne FLOTTE) : si une demande
    // explicite de vehicleIds a ete faite, on verifie qu'ils appartiennent tous
    // a la flotte (pour qu'un FLEET_ADMIN ne devine pas des IDs d'une autre
    // flotte). Le perimetre UTILISATEUR (groupe/vehicules) est deja garanti par
    // resolveReportVehicleScope ci-dessus (403 si hors perimetre).
    if (uniqueRequestedIds.length > 0) {
      const foundIds = new Set(vehicles.map((v) => v.id));
      const missing = uniqueRequestedIds.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new BadRequestException(
          'Un ou plusieurs vehicleIds n\'appartiennent pas a la flotte demandee',
        );
      }
    }

    const totalVehicles = vehicles.length;
    const fuelPrice = fleet.fuelPriceEurL;

    // ── Parc EXPLOITÉ : qui a le droit d'entrer dans une MOYENNE ? ────────────
    // Cas réel (prod, 39 véhicules) : FV-941-LZ muet depuis 89 j et FL-787-KV
    // depuis 52 j — batterie débranchée / boîtier déposé — restaient comptés au
    // dénominateur de la distance moyenne, à 0 km garanti. Le chiffre lu chaque
    // semaine par le client était donc mécaniquement sous-évalué, d'un écart qui
    // grandit à chaque semaine de silence supplémentaire.
    //
    // Source de vérité : `Tracker.lastSeenAt` UNIQUEMENT.
    //  - pas Trip/Position : en mode vie privée (RGPD) les positions sont jetées
    //    alors que le boîtier parle → on déclarerait dormant tout véhicule protégé ;
    //  - pas `Tracker.status` : colonne collante, jamais remise à OFFLINE.
    //
    // Dérivé au read-time : aucun champ en base, aucun drapeau, aucun bouton
    // « réactiver ». Dès que le boîtier ré-émet, `lastSeenAt` redevient frais et le
    // véhicule réintègre le dénominateur au rapport suivant, tout seul.
    const now = Date.now();
    const dormancyInputs = vehicles.map((v) => ({
      vehicle: v,
      // `trackerId` = présence d'un boîtier ; `lastSeenAt` = a-t-il déjà parlé, et quand.
      liveness: { trackerId: v.tracker?.id ?? null, lastSeenAt: v.tracker?.lastSeenAt ?? null },
    }));
    // `isVehicleExploited` n'est PAS la négation d'`isVehicleDormant` : un véhicule
    // sans boîtier (les 2 véhicules de test du parc) n'est ni l'un ni l'autre. On
    // garde donc les deux listes, et le reste = « pas équipé ».
    const exploitedVehicleIds = new Set(
      dormancyInputs.filter((d) => isVehicleExploited(d.liveness, now)).map((d) => d.vehicle.id),
    );
    const dormantVehicles = dormancyInputs
      .filter((d) => isVehicleDormant(d.liveness, now))
      .map((d) => ({
        vehicleId: d.vehicle.id,
        plate: d.vehicle.plate,
        // « 89 j » — l'ancienneté rend la mention vérifiable par le client, qui sait
        // alors s'il s'agit d'un véhicule vendu, en atelier, ou d'un boîtier à dépanner.
        silenceLabel: formatSilenceLabel(d.liveness.lastSeenAt, now),
        silenceMs: trackerSilenceMs(d.liveness.lastSeenAt, now) ?? 0,
      }))
      // Le plus silencieux d'abord : quand la place manque dans le rapport, ce sont
      // les plaques les plus anciennes qui méritent d'être nommées.
      .sort((a, b) => b.silenceMs - a.silenceMs || a.plate.localeCompare(b.plate))
      .map(({ vehicleId, plate, silenceLabel }) => ({ vehicleId, plate, silenceLabel }));
    const withoutTrackerCount = Math.max(
      0,
      totalVehicles - exploitedVehicleIds.size - dormantVehicles.length,
    );

    // V1.10 (Sprint 2 perf) — toutes les agregations sont poussees en SQL au
    // lieu de charger tous les trips en memoire + reduce JS. A 30j × 100 vehicules
    // = ~15k trips, on passe d'un payload Prisma ~30 MB en RAM a 4 requetes
    // d'agregation + 1 findMany capee pour le detail "recents".
    //
    // Le filtre vehicleIds (feature d3dca0c) est conserve via tripVehicleFilter
    // injecte dans le where commun.
    const tripVehicleFilter = isVehicleScopeRestricted
      ? { vehicleId: { in: scopedVehicleIds } }
      : {};
    // Mode vie privée (RGPD) : exclut de TOUTES les agrégations les véhicules
    // actuellement en mode privé (trajets + alertes portant une localisation).
    const privacyExclude = { NOT: { vehicle: { privacyModeEnabled: true } } } as const;
    // ⚠️ UN TRAJET APPARTIENT AU JOUR OÙ IL PART.
    //
    // Cette requête retenait les trajets qui CHEVAUCHENT la période (`startedAt <= to` et
    // `endedAt >= from`), alors que l'écran, le CSV et l'Excel retiennent ceux qui y
    // DÉMARRENT. Un trajet parti à 23 h 50 la veille entrait donc dans le PDF sans figurer
    // dans la liste qui l'avait produit — et le total de kilomètres ne tombait jamais juste.
    // Même convention partout : `startedAt` dans [from, to[, trajet terminé.
    const tripWhere = {
      fleetId,
      ...tripVehicleFilter,
      startedAt: { gte: from, lt: to },
      endedAt: { not: null },
      ...privacyExclude,
    } as const;
    const alertWhere = {
      fleetId,
      // Borne haute exclusive, comme les trajets : `to` est le lendemain minuit.
      createdAt: { gte: from, lt: to },
      // Quand un filtre vehicleIds est actif, les alertes sans vehicleId
      // (ex. tracker isole) sont exclues par definition du sous-ensemble.
      ...(isVehicleScopeRestricted ? { vehicleId: { in: scopedVehicleIds } } : {}),
      ...privacyExclude,
    } as const;
    const recentTripsCap = this.clampRecentTripsCap(filters?.maxRecentTrips);

    /**
     * ── EXCÈS ÉTABLIS PAR VÉHICULE, LUS DANS LE DÉTAIL DES ANALYSES (F06) ──────────────
     *
     * En SQL brut parce que le filtre porte sur les ÉLÉMENTS d'un tableau JSON : Prisma ne
     * sait pas exprimer « au moins un segment d'au moins N secondes », et ramener les détails
     * en mémoire chargerait aussi le tracé de chaque trajet — plusieurs dizaines de mégaoctets
     * pour un mois de flotte.
     *
     * ⚠️ Le seuil vient de la CONSTANTE PARTAGÉE, interpolée ici. C'est la seule façon d'avoir
     * une requête SQL qui ne diverge pas de la règle le jour où celle-ci bouge. La FORME du
     * prédicat est, elle, forcément réécrite en SQL — ce commentaire est la seule protection
     * contre l'oubli : si `excesEtabli` gagne une condition, elle doit descendre ici aussi.
     *
     * Mesuré en production le 2026-09-04 : 188 ms sur 30 jours de la plus grosse société.
     * Lancée DANS le Promise.all ci-dessous, donc en parallèle des autres agrégats.
     */
    const excesParVehicule = this.prisma.$queryRaw<
      { vehicleId: string; exces: number; trajets: number; pire: number }[]
    >`
      SELECT ta."vehicleId"                                     AS "vehicleId",
             COUNT(*)::int                                      AS "exces",
             COUNT(DISTINCT ta."tripId")::int                   AS "trajets",
             COALESCE(MAX((s->>'overKmh')::numeric), 0)::float8 AS "pire"
        FROM trip_analyses ta
        JOIN trips t ON t.id = ta."tripId"
        CROSS JOIN LATERAL jsonb_array_elements(ta.detail->'speeding') s
       WHERE ta."fleetId" = ${fleetId}::uuid
         AND t."startedAt" >= ${from}
         AND t."startedAt" <  ${to}
         AND t."endedAt" IS NOT NULL
         ${isVehicleScopeRestricted
            ? Prisma.sql`AND ta."vehicleId" = ANY(${scopedVehicleIds}::uuid[])`
            : Prisma.empty}
         AND (s->>'durationSec')::numeric >= ${EXCES_DUREE_MIN_SEC}
       GROUP BY ta."vehicleId"
    `;

    // 1) Aggregations globales : sum / avg / max / count en une requete SQL.
    // 2) Group by vehicleId : pour topVehicles + activeVehicleIds.
    // 3) Group by type/severity sur alerts.
    // 4) Detail des 30 trajets recents (avec includes pour le PDF).
    // 5) Group by alerts type + severity.
    const [tripAgg, tripsByVehicle, alertsByType, alertsBySeverity, recentTripsRaw, excesRows] =
      await Promise.all([
        this.prisma.trip.aggregate({
          where: tripWhere,
          _count: { _all: true },
          _sum: { distanceKm: true, durationSeconds: true },
          _avg: { avgSpeed: true },
          _max: { maxSpeed: true },
        }),
        this.prisma.trip.groupBy({
          by: ['vehicleId'],
          where: tripWhere,
          // `durationSeconds` : indispensable au récapitulatif par véhicule de l'écran, qui
          // devait sinon l'additionner lui-même sur la seule page chargée.
          _sum: { distanceKm: true, durationSeconds: true },
          _count: { _all: true },
        }),
        this.prisma.alert.groupBy({
          by: ['type'],
          where: alertWhere,
          _count: { _all: true },
        }),
        this.prisma.alert.groupBy({
          by: ['severity'],
          where: alertWhere,
          _count: { _all: true },
        }),
        this.prisma.trip.findMany({
          where: tripWhere,
          select: {
            id: true, vehicleId: true, distanceKm: true, durationSeconds: true,
            startedAt: true, endedAt: true,
            notes: true,
            vehicle: {
              select: {
                plate: true,
                groups: {
                  select: { group: { select: { id: true, name: true } } },
                  orderBy: { group: { name: 'asc' } },
                  take: 1,
                },
              },
            },
            driver: { select: { firstName: true, lastName: true } },
          },
          orderBy: { startedAt: 'desc' },
          take: recentTripsCap,
        }),
        // ⚠️ Best-effort : un échec de cette requête ne doit PAS emporter tout le rapport.
        // Une colonne « Excès » vide se remarque ; un écran Rapports en erreur pour une
        // colonne accessoire serait une régression bien plus grave que son absence.
        excesParVehicule.catch((e: unknown) => {
          this.logger.warn(`Excès par véhicule indisponibles : ${e instanceof Error ? e.message : e}`);
          return [] as { vehicleId: string; exces: number; trajets: number; pire: number }[];
        }),
      ]);
    const excesParVehiculeMap = new Map(excesRows.map((r) => [r.vehicleId, r]));

    const tripCount = tripAgg._count._all;
    const totalKm = tripAgg._sum.distanceKm ?? 0;
    const totalSeconds = tripAgg._sum.durationSeconds ?? 0;
    // ⚠️ Vitesse moyenne = km parcourus / heures de conduite, PAS la moyenne des moyennes
    //    de trajet (`_avg.avgSpeed`). Un trajet de 400 m à 8 km/h pesait autant qu'un
    //    trajet de 180 km à 110 km/h : le PDF disait 45,1 km/h là où l'Excel (pondéré par
    //    la durée) disait 39,3 pour le même véhicule et la même période. Une seule
    //    définition, celle qu'un gestionnaire comprend, partagée par tous les exports.
    const avgSpeedKmh = totalSeconds > 0 ? totalKm / (totalSeconds / 3600) : 0;
    const maxSpeedKmh = tripAgg._max.maxSpeed ?? 0;
    const activeVehicleIds = new Set(tripsByVehicle.map((g) => g.vehicleId));

    // Map perVehicle pour calcul carburant + top.
    const perVehicle = new Map<string, { distanceKm: number; tripCount: number; durationSeconds: number }>();
    for (const g of tripsByVehicle) {
      perVehicle.set(g.vehicleId, {
        distanceKm: g._sum.distanceKm ?? 0,
        tripCount: g._count._all,
        durationSeconds: g._sum.durationSeconds ?? 0,
      });
    }

    // Moyenne kilométrique : MÊME population des deux côtés de la division.
    // On ne divise pas les km de TOUT le parc par le seul parc exploité — ça
    // gonflerait la moyenne d'un véhicule tombé en panne EN COURS de période (ses
    // km comptés, sa place non). Numérateur et dénominateur portent donc tous deux
    // sur les véhicules exploités.
    const exploitedKm = Array.from(exploitedVehicleIds).reduce(
      (sum, id) => sum + (perVehicle.get(id)?.distanceKm ?? 0),
      0,
    );
    // Repli anti-division-par-zéro. Un parc 100 % dormant (client qui a rendu ses
    // boîtiers, flotte hivernée) doit produire un CHIFFRE, jamais NaN ni Infinity :
    // on retombe alors sur le parc entier, et la mention d'exclusion explique au
    // lecteur pourquoi ce chiffre est ce qu'il est.
    const hasExploited = exploitedVehicleIds.size > 0;
    const avgKmBasisVehicles = hasExploited ? exploitedVehicleIds.size : totalVehicles;
    const avgKmBasisKm = hasExploited ? exploitedKm : totalKm;

    let totalLiters = 0;
    let totalCo2Kg = 0;
    const topVehicles: FleetStatsReport['topVehicles'] = [];
    for (const v of vehicles) {
      const stat = perVehicle.get(v.id) ?? { distanceKm: 0, tripCount: 0, durationSeconds: 0 };
      // Conso EFFECTIVE : calibrée (méthode du plein) si mesurée, sinon paramétrée, sinon défaut type.
      const consumptionL100 = (v.calibratedTanks > 0 ? v.calibratedConsumptionL100km : null)
        ?? v.fuelConsumptionL100km
        ?? DEFAULT_CONSUMPTION_L100KM[v.type as keyof typeof DEFAULT_CONSUMPTION_L100KM]
        ?? 8;
      const liters = stat.distanceKm * consumptionL100 / 100;
      totalLiters += liters;
      // ⚠️ Le CO₂ est cumulé PAR VÉHICULE, avec le facteur de son énergie. Multiplier le
      // total de litres de la flotte par un facteur unique donnerait un chiffre faux dès
      // qu'un parc mêle diesel et essence — c'est-à-dire presque toujours.
      totalCo2Kg += co2DuCarburant(liters, v.energy);
      // ⚠️ `tripCount > 0` autant que la distance : un véhicule qui a roulé sans avancer —
      // manœuvres, trajet interrompu — a bien des trajets sur la période, et l'écran le
      // listait. L'omettre ici l'aurait fait disparaître du récapitulatif.
      if (stat.distanceKm > 0 || stat.tripCount > 0) {
        topVehicles.push({
          vehicleId: v.id,
          plate: v.plate,
          distanceKm: Math.round(stat.distanceKm * 10) / 10,
          tripCount: stat.tripCount,
          estimatedConsumptionL: Math.round(liters * 10) / 10,
          group: v.groups?.[0]?.group ?? null,
          durationHours: Math.round((stat.durationSeconds / 3600) * 10) / 10,
          avgSpeedKmh: stat.durationSeconds > 0
            ? Math.round(stat.distanceKm / (stat.durationSeconds / 3600))
            : 0,
          // Absent de la table = aucun excès établi, et c'est bien zéro : la requête ne
          // rend une ligne que pour les véhicules qui en ont.
          speedingCount: excesParVehiculeMap.get(v.id)?.exces ?? 0,
          speedingTripCount: excesParVehiculeMap.get(v.id)?.trajets ?? 0,
          worstOverKmh: Math.round((excesParVehiculeMap.get(v.id)?.pire ?? 0) * 10) / 10,
        });
      }
    }
    topVehicles.sort((a, b) => b.distanceKm - a.distanceKm);

    // P3 carburant — prix RÉELLEMENT CONSTATÉ en station sur la période (moyenne des prix captés aux
    // passages station du périmètre), pour comparer au prix paramétré. Best-effort : null si aucun passage.
    const fuelStopAgg = await this.prisma.tripFuelStop.aggregate({
      where: {
        arrivedAt: { gte: from, lte: to },
        unitPriceEur: { not: null },
        ...(isVehicleScopeRestricted ? { vehicleId: { in: vehicles.map((v) => v.id) } } : { fleetId: fleet.id }),
      },
      _avg: { unitPriceEur: true },
      _count: { _all: true },
    });
    const observedPriceEurL = fuelStopAgg._avg.unitPriceEur != null ? Math.round(fuelStopAgg._avg.unitPriceEur * 1000) / 1000 : null;
    const observedSampleCount = fuelStopAgg._count._all;

    // V1.10 (Sprint 2 perf) — totalAlerts agrege depuis le groupBy au lieu
    // d'un findMany separe. Le where du groupBy applique deja le filtre
    // vehicleIds (cf. alertWhere ci-dessus).
    const totalAlerts = alertsByType.reduce((sum, g) => sum + g._count._all, 0);

    return {
      fleet: { id: fleet.id, name: fleet.name },
      period: { from: from.toISOString(), to: to.toISOString(), days },
      vehicles: {
        total: totalVehicles,
        activeDuringPeriod: activeVehicleIds.size,
        exploited: exploitedVehicleIds.size,
        dormant: dormantVehicles.length,
        withoutTracker: withoutTrackerCount,
        dormantVehicles,
      },
      trips: {
        count: tripCount,
        // Inchangé : le total kilométrique reste celui de TOUT le périmètre, y
        // compris les km parcourus par un véhicule devenu dormant depuis. On ne
        // supprime aucun historique, on ne fait baisser aucun total.
        totalKm: Math.round(totalKm * 10) / 10,
        totalDurationHours: Math.round((totalSeconds / 3600) * 10) / 10,
        avgKmPerVehicle:
          avgKmBasisVehicles > 0 ? Math.round((avgKmBasisKm / avgKmBasisVehicles) * 10) / 10 : 0,
        avgKmBasisVehicles,
        avgKmBasisKm: Math.round(avgKmBasisKm * 10) / 10,
        avgSpeedKmh: Math.round(avgSpeedKmh * 10) / 10,
        maxSpeedKmh: Math.round(maxSpeedKmh * 10) / 10,
      },
      alerts: {
        total: totalAlerts,
        byType: alertsByType.map((g) => ({ type: g.type as string, count: g._count._all })),
        bySeverity: alertsBySeverity.map((g) => ({ severity: g.severity as string, count: g._count._all })),
      },
      consumption: {
        estimatedLiters: Math.round(totalLiters * 10) / 10,
        estimatedCostEur: Math.round(totalLiters * fuelPrice * 100) / 100,
        fuelPriceEurL: fuelPrice,
        observedPriceEurL,
        estimatedCostAtObservedEur: observedPriceEurL != null ? Math.round(totalLiters * observedPriceEurL * 100) / 100 : null,
        observedSampleCount,
        estimatedCo2Kg: Math.round(totalCo2Kg),
      },
      // Le curseur « Top N » de la modale ne pouvait rien au-delà de 10 : tranché ici avant
      // que le PDF ne le lise. Plafond 50, comme le DTO.
      topVehicles: topVehicles.slice(0, Math.min(50, Math.max(1, Math.trunc(filters?.topN ?? 10)))),
      // V1.10 (Sprint 2 perf) — pas de slice ici, le take=recentTripsCap dans
      // le findMany ci-dessus a deja limite cote DB.
      recentTrips: recentTripsRaw.map((t) => ({
        id: t.id,
        plate: t.vehicle?.plate ?? '',
        startedAt: t.startedAt.toISOString(),
        endedAt: t.endedAt?.toISOString() ?? null,
        durationSeconds: t.durationSeconds,
        distanceKm: Math.round(Math.max(0, t.distanceKm) * 10) / 10,
        notes: t.notes ?? null,
        driverName: t.driver ? `${t.driver.firstName} ${t.driver.lastName}` : null,
        group: t.vehicle?.groups?.[0]?.group ?? null,
      })),
    };
  }

  /** Cap defensif sur le nombre de trajets recents embarques dans le rapport.
   *  Default 30 (compat historique) ; jusqu'a 500 quand le caller le demande. */
  private clampRecentTripsCap(requested: number | undefined): number {
    if (requested == null || Number.isNaN(requested)) return 30;
    return Math.min(500, Math.max(1, Math.trunc(requested)));
  }
}

/** Seuil de dormance exprimé en jours, pour le libellé client (« plus de 7 j »). */
const DORMANT_COUNTING_DAYS = Math.round(DORMANT_STOP_COUNTING_MS / (24 * 3600 * 1000));

/** Nombre de plaques nommées dans la mention avant de basculer sur « +N autres ».
 *  6 tient sur ~2 lignes de PDF ; au-delà la mention noierait le rapport. */
const NOTICE_MAX_PLATES = 6;

const plural = (n: number): string => (n > 1 ? 's' : '');

/**
 * Mention CLIENT expliquant pourquoi la moyenne kilométrique ne se divise pas par
 * le parc entier.
 *
 * Un chiffre lu chaque semaine ne doit JAMAIS changer de base en silence : le jour
 * où la moyenne monte parce que deux épaves sont sorties du dénominateur, le
 * rapport doit le dire lui-même, avec les plaques, sinon le client conclut à un bug
 * (ou pire, à une flatterie du chiffre). La mention rappelle aussi que l'exclusion
 * est RÉVERSIBLE et automatique — il n'y a rien à cliquer pour réintégrer.
 *
 * Exportée pour que toutes les surfaces (PDF aujourd'hui, Excel / web ensuite)
 * disent EXACTEMENT la même phrase.
 *
 * @returns `null` quand rien n'est exclu — pas de mention inutile sur un parc sain.
 */
export function buildExploitedScopeNotice(
  report: FleetStatsReport,
  maxPlates: number = NOTICE_MAX_PLATES,
): string | null {
  const { dormant, withoutTracker, dormantVehicles, total } = report.vehicles;
  if (dormant === 0 && withoutTracker === 0) return null;

  const parts: string[] = [];

  if (dormant > 0) {
    const named = dormantVehicles
      .slice(0, Math.max(0, maxPlates))
      .map((v) => (v.silenceLabel ? `${v.plate} (${v.silenceLabel})` : v.plate));
    const rest = dormantVehicles.length - named.length;
    const plates = named.length > 0
      ? ` : ${named.join(', ')}${rest > 0 ? `, +${rest} autre${plural(rest)}` : ''}`
      : '';
    // « silence constaté à la date de génération » : l'ancienneté est mesurée
    // MAINTENANT, pas à la fin de la période couverte. Sans cette précision, un
    // rapport de juin ré-édité en octobre affirmerait « FV-941-LZ, muet depuis
    // 89 j » à propos d'un mois où le boîtier émettait toutes les 30 s — le
    // client y lirait une erreur de l'outil plutôt qu'un état du parc AUJOURD'HUI.
    parts.push(
      `${dormant} véhicule${plural(dormant)} sans signal boîtier depuis plus de ` +
      `${DORMANT_COUNTING_DAYS} j (silence constaté à la date de génération)${plates} — ` +
      `exclu${plural(dormant)} du parc exploité, ` +
      `réintégré${plural(dormant)} dès la première trame reçue.`,
    );
  }

  if (withoutTracker > 0) {
    // « sans boîtier ACTIF » et non « sans boîtier » : ce compteur regroupe DEUX
    // situations que le client ne vit pas pareil — le véhicule réellement pas
    // équipé (les 2 véhicules de test du parc), et celui dont le boîtier vient
    // d'être posé mais n'a jamais émis (SIM/APN/provisionnement KO). Écrire
    // « sans boîtier » au gestionnaire qui a fait installer un boîtier la veille,
    // c'est lui faire ouvrir un ticket pour contester le rapport.
    parts.push(
      `${withoutTracker} véhicule${plural(withoutTracker)} sans boîtier actif ` +
      `(aucun boîtier affecté, ou boîtier jamais connecté) : hors moyenne — ` +
      `aucun kilomètre ne peut y être capté aujourd'hui.`,
    );
  }

  // Toujours en dernier : la base de calcul. C'est la ligne qui permet au client de
  // refaire l'opération lui-même, et qui rappelle que le parc facturé n'a pas bougé.
  const basis = report.trips.avgKmBasisVehicles;
  if (report.vehicles.exploited === 0) {
    // Parc 100 % dormant / non équipé : on ne PEUT pas diviser par le parc exploité
    // (ce serait NaN). On le dit au lieu de laisser croire à une moyenne réelle.
    parts.push(
      `Aucun véhicule exploité à ce jour : distance moyenne calculée à titre ` +
      `indicatif sur le parc entier (${basis} véhicule${plural(basis)}).`,
    );
  } else {
    parts.push(
      `Distance moyenne calculée sur ${basis} véhicule${plural(basis)} ` +
      `exploité${plural(basis)} (${report.trips.avgKmBasisKm.toFixed(1)} km) — ` +
      `parc total inchangé : ${total}.`,
    );
  }

  return parts.join(' ');
}
