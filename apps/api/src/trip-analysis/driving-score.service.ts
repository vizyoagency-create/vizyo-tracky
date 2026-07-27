import { Injectable, Logger } from '@nestjs/common';
import type { DrivingScoreDetailDto, DrivingScoreRowDto, DrivingScoreScope, DrivingScoresDto } from '@vizyo/tracky-shared';
import { formatSilenceLabel, isVehicleDormant } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';

/** Borne dure d'analyses lues (perf). Au-delà, on tronque (le plus récent d'abord). */
const MAX_ANALYSES = 20_000;
/** Trajets à excès listés par ligne (les plus récents) — pour les liens vers le récit IA. */
const MAX_SPEEDING_REFS = 25;

type SpeedingRef = { tripId: string; vehicleId: string; startedAt: Date };

type Agg = {
  id: string; label: string; sublabel: string | null; color: string | null;
  sumScore: number; trips: number; distanceKm: number; speedingTrips: number; harshCount: number; fuelLiters: number; co2Kg: number;
  speedingRefs: SpeedingRef[];
  /** true = entité SORTIE du classement parce que son boîtier s'est tu (scope `vehicle` uniquement). */
  dormant: boolean;
  /** Dernier signal du boîtier — sert à afficher l'ancienneté du silence dans la liste à part. */
  lastSeenAt: Date | null;
};

/**
 * Une ligne écartée du classement pour cause de DORMANCE, enrichie de l'ancienneté du silence.
 *
 * Elle reste dans la réponse : un véhicule ne doit JAMAIS disparaître de l'écran sans explication.
 * Il quitte la compétition (et la moyenne), pas la page — on l'affiche à part avec « muet depuis 89 j »,
 * ce qui transforme un chiffre inexplicable en action concrète (aller voir le boîtier).
 */
export type DormantDrivingScoreRowDto = DrivingScoreRowDto & {
  /** ISO du dernier signal reçu du boîtier (null si illisible). */
  lastSeenAt: string | null;
  /** Ancienneté lisible du silence (« 89 j »), source unique partagée avec le reste de l'app. */
  silenceLabel: string | null;
};

/**
 * Classement + le compte de ce qui en a été retiré. On n'expose jamais un chiffre rétréci en
 * silence : `dormantExcludedCount`/`dormantExcludedTrips` expliquent l'écart entre le parc réel et
 * `rankedCount`/`totalTrips`.
 */
export type DrivingScoresWithDormancyDto = DrivingScoresDto & {
  /** Nombre d'entités sorties du classement pour dormance (0 hors scope `vehicle`). */
  dormantExcludedCount: number;
  /** Nombre de trajets retirés de la moyenne globale avec elles. */
  dormantExcludedTrips: number;
  /** Les lignes écartées, du silence le plus ancien au plus récent. */
  dormantRows: DormantDrivingScoreRowDto[];
};

/** Détail d'une entité + la raison éventuelle de son absence du classement. */
export type DrivingScoreDetailWithDormancyDto = DrivingScoreDetailDto & {
  dormant: boolean;
  silenceLabel: string | null;
  /**
   * Nombre d'entités écartées du classement pour dormance.
   *
   * Indispensable ICI aussi : le « 3e / 12 » de la fiche devient « 3e / 10 » dès que deux boîtiers
   * se taisent. Sans ce chiffre, le client voit son dénominateur maigrir sans la moindre explication
   * et croit à une perte de véhicules.
   */
  dormantExcludedCount: number;
};

/**
 * Notation (2026-07) — SCORE DE CONDUITE agrégé par véhicule / conducteur / groupe. Le score d'un
 * trajet = son éco-score déterministe (0-100, déjà calculé : excès, à-coups, ralenti). On MOYENNE sur
 * la période et on classe. Scoping anti-IDOR (périmètre véhicules de l'utilisateur). Aucun appel IA.
 *
 * Dormance (2026-07) : un véhicule dont le boîtier s'est tu depuis plus d'une semaine ne concourt
 * plus — il est listé à part avec l'ancienneté de son silence. Uniquement dans SON classement :
 * ni le conducteur ni le groupe ne paient une panne matérielle (cf. le commentaire dans la boucle).
 */
@Injectable()
export class DrivingScoreService {
  private readonly logger = new Logger(DrivingScoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  async scores(user: AuthUser, scope: DrivingScoreScope, fromIso?: string, toIso?: string, fleetId?: string): Promise<DrivingScoresWithDormancyDto> {
    const to = toIso ? new Date(toIso) : new Date();
    const from = fromIso ? new Date(fromIso) : new Date(to.getTime() - 30 * 24 * 3600 * 1000);

    // 1. Périmètre véhicules (anti-IDOR).
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(user);
    const vehicleWhere = accessible === 'ALL'
      ? (fleetId ? { fleetId } : {})
      : { vehicleId: { in: accessible.length ? accessible : ['00000000-0000-0000-0000-000000000000'] } };

    // 2. Analyses (bornées) → métriques par trajet.
    const analyses = await this.prisma.tripAnalysis.findMany({
      where: vehicleWhere,
      select: { tripId: true, vehicleId: true, ecoScore: true, distanceKm: true, speedingCount: true, harshAccel: true, harshBrake: true, fuelLiters: true, co2Kg: true },
      orderBy: { computedAt: 'desc' },
      take: MAX_ANALYSES,
    });
    if (analyses.length >= MAX_ANALYSES) this.logger.warn(`scores : ${MAX_ANALYSES} analyses (tronqué).`);
    if (analyses.length === 0) return { scope, from: from.toISOString(), to: to.toISOString(), rows: [], overallScore: null, overallGrade: null, totalTrips: 0, rankedCount: 0, dormantExcludedCount: 0, dormantExcludedTrips: 0, dormantRows: [] };

    // 3. Trajets correspondants DANS la période → conducteur + véhicule.
    const tripIds = analyses.map((a) => a.tripId);
    const trips = await this.prisma.trip.findMany({
      where: { id: { in: tripIds }, startedAt: { gte: from, lte: to } },
      select: { id: true, vehicleId: true, driverId: true, startedAt: true, driver: { select: { firstName: true, lastName: true, color: true } } },
    });
    const tripById = new Map(trips.map((t) => [t.id, t]));

    // 4. Libellés : plaques + modèles + groupes (une seule requête chacun). `tracker` est joint ICI,
    //    dans la requête qui existait déjà : la dormance ne coûte AUCUNE requête supplémentaire
    //    (VPS 2 vCPU déjà saturé).
    const vehIds = [...new Set(trips.map((t) => t.vehicleId))];
    const vehicles = vehIds.length
      ? await this.prisma.vehicle.findMany({ where: { id: { in: vehIds } }, select: { id: true, plate: true, brand: true, model: true, tracker: { select: { id: true, lastSeenAt: true } }, groups: { select: { group: { select: { id: true, name: true } } } } } })
      : [];
    const vehById = new Map(vehicles.map((v) => [v.id, v]));

    // 4bis. DORMANCE (seuil « arrêter de COMPTER », 7 j). Un boîtier muet depuis une semaine ne
    // produit plus aucun trajet : sa moyenne se fige et continue pourtant de peser dans le
    // classement ET dans la moyenne de flotte. En prod, FV-941-LZ (89 j de silence) et FL-787-KV
    // (52 j) figuraient encore au tableau, notés comme s'ils roulaient toujours.
    //
    // Instant de référence = min(maintenant, fin de période) : sur une période PASSÉE explicitement
    // demandée, la question devient « était-il DÉJÀ muet à l'époque ? ». Sinon on réécrirait
    // l'histoire — un véhicule bien vivant en mars sortirait du classement de mars parce que son
    // boîtier est tombé en juillet.
    //
    // Source unique `Tracker.lastSeenAt` : ni Trip/Position (jetées en mode vie privée alors que le
    // boîtier parle → on marquerait dormant tout véhicule sous RGPD), ni `Tracker.status` (collant).
    // Rien n'est écrit : dès la première trame reçue, l'appel suivant reclasse le véhicule tout seul.
    const dormantAt = Math.min(Date.now(), to.getTime());
    const dormantVehicles = new Map<string, Date | null>();
    for (const v of vehicles) {
      if (isVehicleDormant({ trackerId: v.tracker?.id ?? null, lastSeenAt: v.tracker?.lastSeenAt ?? null }, dormantAt)) {
        dormantVehicles.set(v.id, v.tracker?.lastSeenAt ?? null);
      }
    }

    // 5. Agrégation par scope.
    const map = new Map<string, Agg>();
    let overallSum = 0;
    let overallTrips = 0;

    for (const a of analyses) {
      const t = tripById.get(a.tripId);
      if (!t) continue; // hors période
      const veh = vehById.get(t.vehicleId);
      const grp = veh?.groups?.[0]?.group ?? null;

      let key: string | null = null;
      let label = '';
      let sublabel: string | null = null;
      let color: string | null = null;
      if (scope === 'vehicle') {
        key = t.vehicleId; label = veh?.plate ?? '—'; sublabel = [veh?.brand, veh?.model].filter(Boolean).join(' ') || null;
      } else if (scope === 'driver') {
        if (!t.driverId || !t.driver) continue; // trajets sans conducteur exclus du classement conducteurs
        key = t.driverId; label = `${t.driver.firstName} ${t.driver.lastName}`.trim(); color = t.driver.color ?? null; sublabel = veh?.plate ? `dernier véhicule ${veh.plate}` : null;
      } else {
        if (!grp) continue; // véhicules sans groupe exclus du classement groupes
        key = grp.id; label = grp.name; sublabel = null;
      }
      if (!key) continue;

      // ⚠️ La dormance ne sort QUE le VÉHICULE de SON classement. Les trajets qu'il a produits
      // restent entiers dans les classements CONDUCTEUR et GROUPE : c'est le BOÎTIER qui est tombé,
      // pas le conducteur. L'écarter de son classement punirait quelqu'un qui a parfaitement conduit
      // avant la panne — et ferait aussi baisser la note d'un groupe pour une raison matérielle.
      const dormant = scope === 'vehicle' && dormantVehicles.has(t.vehicleId);

      let g = map.get(key);
      if (!g) { g = { id: key, label, sublabel, color, sumScore: 0, trips: 0, distanceKm: 0, speedingTrips: 0, harshCount: 0, fuelLiters: 0, co2Kg: 0, speedingRefs: [], dormant, lastSeenAt: dormant ? (dormantVehicles.get(t.vehicleId) ?? null) : null }; map.set(key, g); }
      g.sumScore += a.ecoScore;
      g.trips += 1;
      g.distanceKm += a.distanceKm;
      if (a.speedingCount > 0) {
        g.speedingTrips += 1;
        g.speedingRefs.push({ tripId: a.tripId, vehicleId: t.vehicleId, startedAt: t.startedAt });
      }
      g.harshCount += a.harshAccel + a.harshBrake;
      g.fuelLiters += a.fuelLiters ?? 0;
      g.co2Kg += a.co2Kg ?? 0;
      // La moyenne globale doit refléter EXACTEMENT les lignes classées : si un dormant sort du
      // tableau mais reste dans la moyenne, le client compare ses véhicules à une moyenne qui ne
      // correspond à aucune ligne visible.
      if (!dormant) {
        overallSum += a.ecoScore;
        overallTrips += 1;
      }
    }

    const toRow = (g: Agg): DrivingScoreRowDto => {
      const score = Math.round(g.sumScore / g.trips);
      return {
        id: g.id, label: g.label, sublabel: g.sublabel, color: g.color,
        score, grade: grade(score), tripCount: g.trips,
        distanceKm: round(g.distanceKm, 1), speedingTrips: g.speedingTrips,
        speedingTripRefs: g.speedingRefs
          .sort((x, y) => y.startedAt.getTime() - x.startedAt.getTime())
          .slice(0, MAX_SPEEDING_REFS)
          .map((r) => ({ tripId: r.tripId, vehicleId: r.vehicleId, startedAt: r.startedAt.toISOString() })),
        harshCount: g.harshCount,
        fuelLiters: round(g.fuelLiters, 1), co2Kg: round(g.co2Kg, 1),
      };
    };

    const aggs = [...map.values()];
    const rows: DrivingScoreRowDto[] = aggs
      .filter((g) => !g.dormant)
      .map(toRow)
      .sort((a, b) => b.score - a.score || b.tripCount - a.tripCount);

    // Les écartés sont RENDUS, pas supprimés (leur historique reste intégralement consultable) :
    // silence le plus ancien en tête, c'est l'ordre dans lequel l'exploitant doit s'en occuper.
    const dormantAggs = aggs.filter((g) => g.dormant);
    const dormantRows: DormantDrivingScoreRowDto[] = dormantAggs
      .map((g) => ({ ...toRow(g), lastSeenAt: g.lastSeenAt?.toISOString() ?? null, silenceLabel: formatSilenceLabel(g.lastSeenAt, dormantAt) }))
      .sort((a, b) => (a.lastSeenAt ?? '').localeCompare(b.lastSeenAt ?? ''));

    const overallScore = overallTrips > 0 ? Math.round(overallSum / overallTrips) : null;
    return {
      scope, from: from.toISOString(), to: to.toISOString(), rows,
      overallScore, overallGrade: overallScore != null ? grade(overallScore) : null, totalTrips: overallTrips,
      rankedCount: rows.length,
      dormantExcludedCount: dormantRows.length,
      dormantExcludedTrips: dormantAggs.reduce((s, g) => s + g.trips, 0),
      dormantRows,
    };
  }

  /**
   * Score PERSO d'UNE entité (véhicule/conducteur/groupe) : sa note + son RANG dans le classement +
   * son écart à la moyenne. Réutilise `scores()` (même périmètre/anti-IDOR) puis extrait l'entité.
   */
  async entityScore(user: AuthUser, scope: DrivingScoreScope, id: string, fromIso?: string, toIso?: string, fleetId?: string): Promise<DrivingScoreDetailWithDormancyDto> {
    const all = await this.scores(user, scope, fromIso, toIso, fleetId);
    const idx = all.rows.findIndex((r) => r.id === id);
    // Un véhicule dormant n'est plus classé, mais sa fiche doit continuer d'afficher sa dernière
    // note connue : on va la chercher dans la liste des écartés. Sans ça, ouvrir la fiche d'un
    // véhicule muet depuis 89 j donnait un écran VIDE (`row: null`) sans dire pourquoi — l'exploitant
    // aurait conclu à un bug de l'app plutôt qu'à un boîtier à aller débrancher/rebrancher.
    const dormantRow = idx >= 0 ? null : (all.dormantRows.find((r) => r.id === id) ?? null);
    const row = idx >= 0 ? all.rows[idx] : dormantRow;

    // Cas RÉEL de production, que `dormantRows` seul ne couvre PAS : FV-941-LZ est muet depuis 89 j,
    // donc il n'a produit AUCUN trajet dans les 30 derniers jours affichés par défaut. Il n'est ni
    // classé, ni dans `dormantRows` — celles-ci ne peuvent contenir que des entités ayant roulé
    // pendant la période. `dormantRows` ne rattrape en fait que les silences COURTS (entre 7 j et la
    // longueur de la période) ; sans le repli ci-dessous, le silence long — le seul qu'on voulait
    // rendre visible — rendait toujours l'écran vide muet sur sa cause.
    //
    // Une seule lecture, uniquement dans cette branche (l'entité n'a déjà rien à afficher), TOUJOURS
    // derrière le contrôle d'accès véhicule : `scores()` n'a rien pu filtrer pour ce véhicule
    // puisqu'il n'avait aucun trajet, donc l'anti-IDOR doit être refait explicitement ici.
    let dormant = dormantRow != null;
    let silenceLabel = dormantRow?.silenceLabel ?? null;
    if (row == null && scope === 'vehicle' && (await this.vehicleAccess.hasAccessToVehicle(user, id))) {
      // `.catch` : cette annotation est un BONUS d'explication, jamais une raison de faire échouer la
      // fiche. Un `id` qui n'est pas un UUID (lien collé de travers) faisait auparavant une réponse
      // vide parfaitement propre — il ne doit pas se mettre à produire une 500.
      const veh = await this.prisma.vehicle
        .findUnique({ where: { id }, select: { tracker: { select: { id: true, lastSeenAt: true } } } })
        .catch(() => null);
      const seenAt = veh?.tracker?.lastSeenAt ?? null;
      // Même instant de référence que `scores()` : sur une période passée, on répond « était-il déjà
      // muet à l'époque ? » plutôt que de projeter la panne d'aujourd'hui sur un rapport d'archive.
      const dormantAt = Math.min(Date.now(), new Date(all.to).getTime());
      if (isVehicleDormant({ trackerId: veh?.tracker?.id ?? null, lastSeenAt: seenAt }, dormantAt)) {
        dormant = true;
        silenceLabel = formatSilenceLabel(seenAt, dormantAt);
      }
    }

    return {
      scope, id, from: all.from, to: all.to,
      row,
      // Pas de rang : il ne concourt plus. Le comparer à une moyenne qu'il ne compose plus n'aurait
      // pas de sens non plus, d'où `vsOverall` laissé à null pour un dormant.
      rank: idx >= 0 ? idx + 1 : null,
      total: all.rows.length,
      overallScore: all.overallScore,
      overallGrade: all.overallGrade,
      vsOverall: idx >= 0 && row && all.overallScore != null ? row.score - all.overallScore : null,
      dormant,
      silenceLabel,
      // Le « / N » ci-dessus a rétréci d'autant : on dit de combien.
      dormantExcludedCount: all.dormantExcludedCount,
    };
  }
}

/** Note lettrée à partir du score 0-100. */
function grade(score: number): string {
  if (score >= 85) return 'A';
  if (score >= 70) return 'B';
  if (score >= 55) return 'C';
  if (score >= 40) return 'D';
  return 'E';
}
function round(v: number, d: number): number { const f = 10 ** d; return Math.round(v * f) / f; }
