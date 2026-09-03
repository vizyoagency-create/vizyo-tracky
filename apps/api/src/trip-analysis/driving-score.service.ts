import { tenantVehicleWhere } from '../common/tenant-vehicle-scope';
import { Injectable, Logger } from '@nestjs/common';
import type {
  DormantDrivingScoreRowDto,
  DrivingScoreDetailDto,
  DrivingScoreRowDto,
  DrivingScoreScope,
  DrivingScoresDto,
} from '@vizyo/tracky-shared';
import { formatSilenceLabel, isVehicleDormant } from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';

/** Borne dure d'analyses lues (perf). Au-delà, on tronque (le plus récent d'abord). */
const MAX_ANALYSES = 20_000;
/** Trajets à excès listés par ligne (les plus récents) — pour les liens vers le récit IA. */
const MAX_SPEEDING_REFS = 25;

/**
 * Analyses minimales pour figurer au CLASSEMENT.
 *
 * ⚠️ Pourquoi ce seuil existe (constat du 2026-08-03). À l'écran, HD-292-SH était 2ᵉ de la
 * flotte avec 100/100 — sur UN SEUL trajet analysé, alors qu'il en avait fait 75 sur la
 * période. Le podium récompensait les véhicules les MOINS analysés.
 *
 * La note ne mesure pas la conduite : elle mesure un ÉCHANTILLON. En production ce dernier
 * allait de 1 trajet sur 75 à 99 sur 201 — comparer ces notes entre elles n'avait aucun sens.
 *
 * ⚠️ 20 n'est pas un chiffre rond choisi au hasard : sur cdef31, la médiane est de 157
 * trajets par véhicule sur 90 jours et UN SEUL véhicule sur 30 passe sous 20. Le seuil
 * écarte donc ce qui n'est pas mesurable, sans amputer le classement.
 *
 * Les écartés restent RENDUS (`insufficientRows`), comme les dormants : on les nomme, on
 * ne les cache pas.
 */
const MIN_ANALYSES_FOR_RANKING = 20;

/**
 * Force de rappel vers la moyenne de flotte, pour le score de CLASSEMENT.
 *
 * ══ Le problème que ça résout ═══════════════════════════════════════════════════════
 *
 * Le seuil ci-dessus écarte l'immesurable, mais ne règle pas l'injustice qui reste : un
 * véhicule noté sur 21 trajets n'a eu que 21 occasions de mal faire, là où un autre en a
 * eu 200. Moins on roule, moins on risque la faute — et le classement récompensait
 * mécaniquement les petits rouleurs.
 *
 * ══ La correction : moyenne bayésienne ═════════════════════════════════════════════
 *
 *     score_classement = (n × score_observé + C × moyenne_flotte) / (n + C)
 *
 * Chaque entité démarre à la moyenne de la flotte et s'en éloigne à mesure qu'elle
 * accumule des trajets. C'est la formule utilisée pour classer des films notés par un
 * nombre très inégal de votants — exactement le même problème.
 *
 * Avec C = 20 :
 *     21 trajets  → la note observée pèse 51 %  (le reste tire vers la moyenne)
 *     60 trajets  → 75 %
 *    200 trajets  → 91 %
 *
 * Un véhicule irréprochable sur 21 trajets reste donc bien classé — mais derrière un
 * véhicule tout aussi propre sur 200. C'est le sens de « équilibré » : la preuve compte
 * autant que la performance.
 *
 * ⚠️ C est ÉGAL au seuil, et ce n'est pas une coïncidence : au moment précis où une
 * entité devient classable, sa note pèse la moitié. Deux constantes différentes ici
 * créeraient une marche invisible à l'entrée du classement.
 *
 * ⚠️ La note AFFICHÉE reste la note observée — c'est celle qui décrit la conduite, et un
 * conducteur doit reconnaître la sienne. Seul l'ORDRE utilise le score pondéré.
 */
const RANKING_CONFIDENCE = MIN_ANALYSES_FOR_RANKING;

/**
 * En deçà de cet écart, deux scores de classement sont tenus pour ÉQUIVALENTS, et c'est
 * le nombre de trajets qui départage.
 *
 * ⚠️ Pourquoi il faut ce complément à la moyenne bayésienne. Celle-ci rapproche les petits
 * échantillons de la moyenne de flotte, mais elle n'INVERSE jamais un ordre : un véhicule
 * à 97/100 sur 21 trajets restait devant un véhicule à 96/100 sur 300, quelle que soit la
 * force du rappel. Le vérifier a demandé de poser le calcul — la formule seule ne suffit
 * pas, et augmenter sa constante aurait écrasé les écarts RÉELS en même temps, au point
 * de transformer le classement en compteur de kilomètres.
 *
 * Un point d'écart mesuré sur 21 trajets n'est pas un fait : c'est du bruit. Sous ce
 * seuil, on tranche donc par ce qui est solide — le volume sur lequel la performance a été
 * démontrée. Au-delà, l'écart de conduite reprend la main, ce qui est bien le but.
 */
const RANKING_TIE_POINTS = 1;

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

// ⚠️ `DormantDrivingScoreRowDto` a été DÉPLACÉ dans le contrat partagé (trip-analysis.dto.ts),
// où sa documentation complète l'accompagne.
// Déclaré ici, il n'existait que pour l'API : le web recevait les données mais son type
// `DrivingScoresDto` les ignorait, donc aucun écran ne pouvait les afficher. Réexporté pour
// les appelants existants.
export type { DormantDrivingScoreRowDto } from '@vizyo/tracky-shared';

/**
 * ⚠️ N'AJOUTE PLUS RIEN : tous les champs (dormance, seuil d'analyses) vivent désormais
 * dans `DrivingScoresDto`, côté contrat PARTAGÉ.
 *
 * Ils étaient déclarés ici, dans une extension propre à l'API. Le serveur les envoyait,
 * mais le web — qui type ses réponses avec `DrivingScoresDto` — ne les voyait pas : aucun
 * écran ne pouvait les afficher sans erreur de compilation. Le classement rétrécissait
 * donc en silence, ce que le commentaire d'origine voulait précisément empêcher.
 *
 * L'alias est conservé pour ne pas casser les appelants existants.
 */
export type DrivingScoresWithDormancyDto = DrivingScoresDto;

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
    // Meme motif que la carte des stations : `'ALL'` ne doit jamais valoir « aucun filtre ».
    const vehicleWhere = tenantVehicleWhere(accessible, user, fleetId);

    // 2. Analyses (bornées) → métriques par trajet.
    const analyses = await this.prisma.tripAnalysis.findMany({
      // ⚠️ `gpsPoints: { gt: 0 }` — une analyse SANS aucune position est remplie de zéros par
      // le préprocesseur, et son éco-score vaut alors 100 : la note maximale, pour un trajet
      // dont on ne sait rien. Ces analyses vides gonflaient la moyenne du classement, et un
      // véhicule mal suivi remontait au podium précisément parce qu'il était mal suivi.
      where: { ...vehicleWhere, gpsPoints: { gt: 0 } },
      select: { tripId: true, vehicleId: true, ecoScore: true, distanceKm: true, speedingCount: true, harshAccel: true, harshBrake: true, fuelLiters: true, co2Kg: true },
      orderBy: { computedAt: 'desc' },
      take: MAX_ANALYSES,
    });
    if (analyses.length >= MAX_ANALYSES) this.logger.warn(`scores : ${MAX_ANALYSES} analyses (tronqué).`);
    if (analyses.length === 0) return { scope, from: from.toISOString(), to: to.toISOString(), rows: [], overallScore: null, overallGrade: null, totalTrips: 0, rankedCount: 0, dormantExcludedCount: 0, dormantExcludedTrips: 0, dormantRows: [], minAnalysesForRanking: MIN_ANALYSES_FOR_RANKING, insufficientRows: [], insufficientCount: 0 };

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
      ? await this.prisma.vehicle.findMany({ where: { id: { in: vehIds } }, select: { id: true, plate: true, brand: true, model: true, outOfServiceReason: true, tracker: { select: { id: true, lastSeenAt: true } }, groups: { select: { group: { select: { id: true, name: true } } } } } })
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
      /**
       * ⚠️ HORS SERVICE — meme sortie du classement que la dormance, mais SANS DELAI.
       *
       * Un vehicule accidente ou dont le boitier est debranche au garage garde une note
       * figee qui continue de peser sur le rang des autres ET sur la moyenne de flotte.
       * La dormance finit par l'ecarter, mais seulement apres sept jours de silence :
       * pendant une semaine, un vehicule qu'on SAIT hors service faussait le classement.
       * Le motif etant DECLARE et non deduit, il n'y a rien a attendre.
       *
       * ⚠️ Sa NOTE reste affichee sur sa fiche : elle porte sur des trajets reels, elle
       *    n'a rien d'invente. Ce qu'on retire, c'est le rang et la comparaison — pas
       *    l'historique.
       */
      // ⚠️ `!= null` et NON `!== null` : la forme stricte est VRAIE pour `undefined`, donc un
      //    champ absent d'un `select` aurait ecarte du classement la flotte ENTIERE, en
      //    silence. Le repli doit toujours pencher du cote « en service » — un vehicule
      //    manquant au classement se remarque bien moins qu'un vehicule en trop.
      const horsService = v.outOfServiceReason != null;
      if (horsService || isVehicleDormant({ trackerId: v.tracker?.id ?? null, lastSeenAt: v.tracker?.lastSeenAt ?? null }, dormantAt)) {
        dormantVehicles.set(v.id, v.tracker?.lastSeenAt ?? null);
      }
    }

    // ══ TRAJETS RÉELLEMENT PARCOURUS (pour le TAUX D'ANALYSE) ═══════════════════════
    //
    // ⚠️ L'écran affichait « 1 trajet » pour HD-292-SH — qui en avait fait 75. Ce « 1 »
    // est le nombre de trajets ANALYSÉS, mais rien ne le disait : on lisait naturellement
    // « ce véhicule n'a roulé qu'une fois ». Impossible, dès lors, de comprendre pourquoi
    // sa note valait moins que celle d'un autre.
    //
    // Un `groupBy` et non un `findMany` : sur 90 jours, cdef31 compte ~4 700 trajets ;
    // les charger pour en compter le nombre serait absurde sur un VPS à 2 vCPU. Ici, une
    // ligne par couple (véhicule, conducteur) — quelques dizaines.
    //
    // ⚠️ MÊME `vehicleWhere` que les analyses : le comptage doit être borné au périmètre
    // exact de l'utilisateur. Un filtre plus large ferait fuir un total inter-flottes dans
    // un simple ratio — une fuite discrète, mais une fuite.
    const realTripRows = await this.prisma.trip.groupBy({
      by: ['vehicleId', 'driverId'],
      where: { ...vehicleWhere, endedAt: { not: null }, startedAt: { gte: from, lte: to } },
      _count: { _all: true },
    });
    const realTripsByKey = new Map<string, number>();
    const addReal = (key: string | null, n: number): void => {
      if (!key) return;
      realTripsByKey.set(key, (realTripsByKey.get(key) ?? 0) + n);
    };
    for (const r of realTripRows) {
      const n = r._count._all;
      if (scope === 'vehicle') addReal(r.vehicleId, n);
      else if (scope === 'driver') addReal(r.driverId, n);
      else addReal(vehById.get(r.vehicleId)?.groups?.[0]?.group?.id ?? null, n);
    }

    // 5. Agrégation par scope.
    const map = new Map<string, Agg>();

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
    }

    const toRow = (g: Agg): DrivingScoreRowDto => {
      const score = Math.round(g.sumScore / g.trips);
      return {
        id: g.id, label: g.label, sublabel: g.sublabel, color: g.color,
        score, grade: grade(score), tripCount: g.trips,
        // Trajets RÉELLEMENT parcourus sur la période : c'est ce qui permet à l'écran de
        // dire « note sur 1 des 75 trajets » au lieu d'un « 1 trajet » qui trompe.
        // Repli sur `g.trips` : un total inférieur aux analyses serait incohérent, et
        // afficherait un taux supérieur à 100 %.
        totalTripCount: Math.max(realTripsByKey.get(g.id) ?? 0, g.trips),
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

    // ══ SEUIL DE REPRÉSENTATIVITÉ ════════════════════════════════════════════════════
    //
    // ⚠️ Constat du 2026-08-03, relevé à l'écran : HD-292-SH était 2ᵉ de la flotte avec
    // 100/100 — sur UN SEUL trajet analysé, alors qu'il en avait fait 75 sur la période.
    // Le podium récompensait donc les véhicules les MOINS analysés, exactement l'inverse
    // de ce que l'écran promet (« une compétition amicale pour progresser »).
    //
    // La note ne mesure pas la conduite : elle mesure un ÉCHANTILLON. Et cet échantillon
    // va de 1 trajet sur 75 à 99 sur 201 selon les véhicules — comparer ces notes entre
    // elles n'a aucun sens.
    //
    // Les écartés sont RENDUS, jamais supprimés, comme les dormants : leur note reste
    // consultable, elle ne fausse simplement plus le classement ni la moyenne de flotte.
    const classables = aggs.filter((g) => !g.dormant && g.trips >= MIN_ANALYSES_FOR_RANKING);
    const insuffisants = aggs.filter((g) => !g.dormant && g.trips < MIN_ANALYSES_FOR_RANKING);

    // ══ ORDRE DU CLASSEMENT : moyenne bayésienne ═════════════════════════════════════
    //
    // La moyenne de flotte se calcule AVANT le tri, sur les seules lignes classables :
    // c'est le point d'ancrage vers lequel les petits échantillons sont ramenés.
    const fleetSum = classables.reduce((s, g) => s + g.sumScore, 0);
    const fleetTrips = classables.reduce((s, g) => s + g.trips, 0);
    const fleetMean = fleetTrips > 0 ? fleetSum / fleetTrips : 0;

    /**
     * Score de CLASSEMENT — jamais affiché, il ne sert qu'à ordonner.
     *
     * ⚠️ Un véhicule noté sur 21 trajets n'a eu que 21 occasions de mal faire, là où un
     * autre en a eu 200 : sans cette pondération, moins on roule, mieux on est classé.
     * Ici, chaque entité part de la moyenne de flotte et gagne le droit de s'en écarter à
     * mesure qu'elle accumule des trajets.
     */
    const rankingScore = (g: Agg): number =>
      (g.trips * (g.sumScore / g.trips) + RANKING_CONFIDENCE * fleetMean) /
      (g.trips + RANKING_CONFIDENCE);

    const rows: DrivingScoreRowDto[] = classables
      .map((g) => ({ row: toRow(g), rank: rankingScore(g), trips: g.trips }))
      .sort((a, b) => {
        // ⚠️ DEUX SCORES À MOINS D'UN POINT NE SONT PAS DISTINGUABLES.
        //
        // La moyenne bayésienne rapproche les petits échantillons de la moyenne, mais elle
        // n'INVERSE jamais un ordre : un véhicule à 97/100 sur 21 trajets restait devant un
        // véhicule à 96/100 sur 300, quel que soit le poids donné au rappel. C'est une
        // propriété de la formule, pas un réglage à durcir — augmenter la constante
        // écraserait aussi les écarts réels, et le classement deviendrait un compteur de
        // kilomètres.
        //
        // Or un point d'écart mesuré sur 21 trajets n'est pas un fait : c'est du bruit.
        // Sous ce seuil, on tranche donc par ce qui EST solide — le nombre de trajets sur
        // lequel la performance a été démontrée.
        if (Math.abs(a.rank - b.rank) < RANKING_TIE_POINTS) return b.trips - a.trips;
        return b.rank - a.rank;
      })
      .map((x) => x.row);

    // Ordre : le plus proche du seuil en tête — c'est celui qui rejoindra le classement
    // en premier, donc celui dont la note commence à vouloir dire quelque chose.
    const insufficientRows: DrivingScoreRowDto[] = insuffisants
      .map(toRow)
      .sort((a, b) => b.tripCount - a.tripCount);

    // Les écartés sont RENDUS, pas supprimés (leur historique reste intégralement consultable) :
    // silence le plus ancien en tête, c'est l'ordre dans lequel l'exploitant doit s'en occuper.
    const dormantAggs = aggs.filter((g) => g.dormant);
    const dormantRows: DormantDrivingScoreRowDto[] = dormantAggs
      .map((g) => ({ ...toRow(g), lastSeenAt: g.lastSeenAt?.toISOString() ?? null, silenceLabel: formatSilenceLabel(g.lastSeenAt, dormantAt) }))
      .sort((a, b) => (a.lastSeenAt ?? '').localeCompare(b.lastSeenAt ?? ''));

    // ⚠️ La moyenne est RECALCULÉE depuis les seules lignes classées.
    //
    // Elle était accumulée dans la boucle sur les analyses, avec le seul filtre `dormant` —
    // impossible d'y appliquer le seuil, puisqu'on ne connaît le nombre d'analyses d'un
    // agrégat qu'une fois la boucle terminée. Sans ce recalcul, la moyenne aurait continué
    // d'inclure des notes que le tableau n'affiche plus, et le client aurait comparé ses
    // véhicules à une valeur ne correspondant à aucune ligne visible — le défaut que le
    // commentaire de la boucle cherchait justement à éviter.
    const rankedSum = classables.reduce((s, g) => s + g.sumScore, 0);
    const rankedTrips = classables.reduce((s, g) => s + g.trips, 0);
    const overallScore = rankedTrips > 0 ? Math.round(rankedSum / rankedTrips) : null;
    return {
      scope, from: from.toISOString(), to: to.toISOString(), rows,
      overallScore, overallGrade: overallScore != null ? grade(overallScore) : null, totalTrips: rankedTrips,
      rankedCount: rows.length,
      dormantExcludedCount: dormantRows.length,
      dormantExcludedTrips: dormantAggs.reduce((s, g) => s + g.trips, 0),
      dormantRows,
      minAnalysesForRanking: MIN_ANALYSES_FOR_RANKING,
      insufficientRows,
      insufficientCount: insufficientRows.length,
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
