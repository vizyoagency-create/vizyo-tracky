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
  CLE_NON_ATTRIBUE,
  cleImputationTrajet,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { resolveDriverScope } from '../common/driver-scope';

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

/**
 * Combien de véhicules immobiles la synthèse nomme avant de s'en tenir au compte.
 *
 * ⚠️ Le reste n'est pas jeté : `idleTotal` le porte, et l'écran le dit. Une liste tronquée
 * en silence laisserait croire qu'un parc de deux cents véhicules n'en a que vingt à l'arrêt.
 */
const MAX_VEHICULES_IMMOBILES = 24;

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
    /**
     * ── LES VÉHICULES QUI N'ONT PAS ROULÉ (F11) ────────────────────────────────────────
     *
     * `activeDuringPeriod` disait COMBIEN avaient roulé ; personne ne disait LESQUELS n'ont
     * pas bougé. C'est pourtant l'information qui décide d'une mutualisation ou d'une
     * restitution — et le récapitulatif par véhicule, qui ne liste que ceux qui ont roulé,
     * la rendait structurellement invisible : un véhicule immobile n'y a aucune ligne.
     *
     * `silencieux` distingue « il n'a pas servi » de « son boîtier s'est tu » : le premier
     * se mutualise, le second se répare. Les confondre ferait rendre un véhicule qui roule.
     *
     * ⚠️ Liste PLAFONNÉE ; `idleTotal` porte le compte réel, pour que la troncature se dise.
     */
    idleVehicles: { vehicleId: string; plate: string; group: { id: string; name: string } | null; silencieux: boolean }[];
    idleTotal: number;
    /**
     * Véhicules du périmètre que le client a mis en MODE VIE PRIVÉE, donc absents de TOUT ce
     * rapport — `total` compris. Rendu pour que les surfaces puissent le DIRE : un parc qui
     * rétrécit sans explication se lit comme une perte de véhicules, et « 5 sur 34 » chez un
     * client qui en compte 39 est une question sans réponse.
     */
    hiddenByPrivacy: number;
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
     * Ralenti moteur cumulé de TOUT le périmètre, en secondes (F12). Premier gaspillage
     * carburant réductible par simple consigne, calculé par trajet depuis toujours et agrégé
     * nulle part jusqu'ici.
     */
    idleSecondsTotal: number;
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
    /**
     * ── RALENTI MOTEUR : LE PREMIER GASPILLAGE MAÎTRISABLE (F12) ─────────────────────
     *
     * Moteur tournant à l'arrêt. Il est calculé PAR TRAJET depuis toujours, et agrégé nulle
     * part : personne ne pouvait dire « ce véhicule a passé onze heures au ralenti ce
     * mois-ci », alors que c'est le poste de dépense qu'une simple consigne réduit.
     *
     * ⚠️ En secondes, comme partout ailleurs dans le produit ; c'est l'écran qui met en
     * forme. Rendre des heures ici obligerait chaque lecteur à savoir si l'arrondi a déjà
     * eu lieu.
     */
    idleSeconds: number;
  }[];
  /**
   * ── « QUI ROULE, ET QUI DÉPASSE ? » — LE MÊME RÉCAPITULATIF, PAR IMPUTATION (F13) ──
   *
   * `topVehicles` répond à « quel VÉHICULE roule et dépasse ? ». Personne ne pouvait
   * répondre à « combien de kilomètres a fait tel conducteur ce mois-ci, avec combien
   * d'excès ? » : l'écran des scores savait déjà imputer un trajet, le rapport non.
   *
   * MÊME forme de chiffres que `topVehicles` (distance, conduite, trajets, vitesse moyenne,
   * excès, ralenti), aux mêmes arrondis : l'écran réutilise ses cellules telles quelles, et
   * les deux vues ne peuvent pas se mettre à compter différemment.
   *
   * ⚠️ Les deux vues sortent de la MÊME passe : le total d'un véhicule est la SOMME de ses
   * conducteurs. Deux agrégations séparées finiraient par ne plus tomber juste — et c'est
   * `topVehicles` que le client lit tous les jours, dans l'écran comme dans le PDF/Excel.
   *
   * Trié par distance décroissante et plafonné comme `topVehicles` (cf. `topN`) ;
   * `byAttributionTotal` porte le compte RÉEL, pour que la troncature se dise.
   *
   * ⚠️ Déclaré OPTIONNEL parce que d'autres producteurs de cette forme n'en fabriquent pas
   * (les fixtures du PDF construisent un `FleetStatsReport` complet à la main). `compute`,
   * lui, le renseigne TOUJOURS : un consommateur qui ne le trouve pas doit se taire, jamais
   * afficher zéro.
   */
  byAttribution?: {
    /** `driver:<id>` ou `group:<id>` — la clé du CLASSEMENT, cf. `cleAttribution` ci-dessous. */
    key: string;
    /** Nom du conducteur, sinon nom du groupe. */
    label: string;
    kind: 'driver' | 'group';
    tripCount: number;
    distanceKm: number;
    durationHours: number;
    avgSpeedKmh: number;
    speedingCount: number;
    speedingTripCount: number;
    worstOverKmh: number;
    idleSeconds: number;
  }[];
  /** Compte RÉEL des lignes d'imputation ; la liste ci-dessus est plafonnée. */
  byAttributionTotal?: number;
  /**
   * Trajets sans conducteur NI groupe : comptés, JAMAIS une ligne — on ne note pas
   * « personne », et on ne lui attribue pas non plus de kilomètres.
   *
   * ⚠️ Ce n'est pas un cas marginal. Mesuré en production le 2026-09-05 : chez mh cars,
   * 1 866 trajets sur 1 886 n'ont ni conducteur ni groupe. Les taire ferait lire une image
   * complète là où presque rien n'est imputé à quiconque.
   */
  unattributedTrips?: { tripCount: number; distanceKm: number; durationHours: number };
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
    filters?: {
      vehicleIds?: string[];
      maxRecentTrips?: number;
      topN?: number;
      /**
       * Filtre CONDUCTEUR (F13) — UUID, ou `none` pour les trajets sans conducteur. Même
       * convention et même validation que `GET /trips` : les deux écrans se lisent côte à
       * côte, ils ne peuvent pas parler deux langues.
       */
      driverId?: string;
    },
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
        // Mode vie privée (RGPD) — CHARGÉ ICI, et pas seulement subi dans les `where`.
        // `TripFuelStop` n'a pas de relation `vehicle` (cf. schema.prisma) : l'agrégat des
        // passages en station ne peut PAS écrire `NOT: { vehicle: { privacyModeEnabled } }`
        // comme le font `tripWhere` et `alertWhere`, il lui faut la liste des identifiants.
        // Sans ce drapeau ici, cette exclusion-là n'est pas exprimable (cf. plus bas).
        privacyModeEnabled: true,
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

    /**
     * ── LE PARC QUE CE RAPPORT A LE DROIT DE DÉCRIRE (RGPD) ──────────────────────────────
     *
     * Un véhicule que le client a mis en MODE VIE PRIVÉE n'a ni trajet, ni kilomètre, ni
     * alerte dans ce rapport : `tripWhere`, `alertWhere` et les deux requêtes SQL écrites à
     * la main l'excluent tous. Il restait pourtant dans le RECENSEMENT, et c'est un
     * quatrième endroit où ce garde lâchait — le plus sournois, parce qu'il ne fuitait
     * aucune donnée mais faisait ÉCRIRE UN MENSONGE :
     *
     *   - `activeDuringPeriod` comparait les véhicules qui ont roulé à un total qui
     *     comptait des véhicules dont on s'interdit de savoir s'ils ont roulé ;
     *   - `idleVehicles` NOMMAIT SA PLAQUE sous « n'a fait aucun trajet », alors qu'il en a
     *     peut-être fait cinquante. C'est l'information qui décide d'une restitution : le
     *     client aurait rendu un véhicule qui roule, sur la foi de son propre réglage.
     *
     * Le recensement porte donc sur le parc VISIBLE. ⚠️ Et le compte des exclus est rendu
     * (`hiddenByPrivacy`), parce qu'un total qui rétrécit sans le dire est le même défaut
     * déplacé : « 5 véhicules sur 34 » quand le parc en compte 39 se lit comme une perte.
     *
     * Aucun véhicule n'est en mode vie privée en production au 2026-09-06 : ce garde est
     * posé avant que le cas n'arrive, pas après.
     */
    const vehiclesVisibles = vehicles.filter((v) => !v.privacyModeEnabled);
    const totalVehicles = vehiclesVisibles.length;
    const hiddenByPrivacy = vehicles.length - vehiclesVisibles.length;
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
    // ⚠️ Sur le parc VISIBLE : un véhicule en mode vie privée ne doit pas non plus voir sa
    // plaque nommée sous « boîtier muet depuis 89 j » — la mention est publique.
    const dormancyInputs = vehiclesVisibles.map((v) => ({
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
    /**
     * ── FILTRE CONDUCTEUR (F13, seconde moitié) ───────────────────────────────────────
     *
     * `undefined` = aucun filtre, `null` = trajets SANS conducteur, sinon l'identifiant.
     * Même règle et même validation que `GET /trips` (cf. `common/driver-scope`) : l'écran
     * Rapports pose UN filtre et attend qu'il vaille pour le tableau ET pour la synthèse.
     *
     * ⚠️ Le test est `!== undefined`, jamais une vérité simple : `null` DOIT descendre dans
     * le `where` (« sans conducteur » est un filtre, pas une absence de filtre).
     */
    const driverScope = resolveDriverScope(filters?.driverId);
    const tripDriverFilter: { driverId?: string | null } =
      driverScope === undefined ? {} : { driverId: driverScope };
    const tripWhere = {
      fleetId,
      ...tripVehicleFilter,
      ...tripDriverFilter,
      startedAt: { gte: from, lt: to },
      endedAt: { not: null },
      ...privacyExclude,
    } as const;
    /**
     * ⚠️ AUCUN FILTRE CONDUCTEUR ICI, ET C'EST UNE DÉCISION, PAS UN OUBLI.
     *
     * Une alerte appartient à un VÉHICULE : elle n'a pas de conducteur. La restreindre à
     * l'aide de `Trip.driverId` demanderait de rattacher chaque alerte au trajet en cours à
     * son horodatage — une jointure approximative dont le résultat, présenté comme un fait,
     * accuserait une personne d'alertes qu'on ne peut pas lui imputer.
     *
     * Les alertes restent donc calculées sur le PÉRIMÈTRE VÉHICULE. L'écran doit le DIRE
     * quand un conducteur est sélectionné (carte « Alertes de la période ») : une carte
     * muette laisserait croire que ce conducteur a déclenché toutes ces alertes.
     */
    const alertWhere = {
      fleetId,
      // Borne haute exclusive, comme les trajets : `to` est le lendemain minuit.
      createdAt: { gte: from, lt: to },
      // Quand un filtre vehicleIds est actif, les alertes sans vehicleId
      // (ex. tracker isole) sont exclues par definition du sous-ensemble.
      ...(isVehicleScopeRestricted ? { vehicleId: { in: scopedVehicleIds } } : {}),
      ...privacyExclude,
    } as const;
    /**
     * Le même filtre, pour les DEUX requêtes écrites à la main (excès établis, ralenti).
     * Elles joignent déjà `trips t`, donc la colonne est à portée — mais elles ne partagent
     * PAS `tripWhere`, et c'est exactement ainsi que le mode vie privée leur avait échappé
     * (relevé en revue le 2026-09-05). Une seule expression, injectée aux deux endroits.
     */
    const filtreConducteurSql =
      driverScope === undefined
        ? Prisma.empty
        : driverScope === null
          ? Prisma.sql`AND t."driverId" IS NULL`
          : Prisma.sql`AND t."driverId" = ${driverScope}::uuid`;
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
    /**
     * Ralenti moteur cumulé par véhicule sur la période (F12).
     *
     * ⚠️ Requête SÉPARÉE de celle des excès : celle-ci fait un LATERAL sur les segments de
     * dépassement, donc une ligne par segment — y additionner `idleSec` compterait le ralenti
     * d'un trajet autant de fois qu'il porte d'excès. Deux questions, deux requêtes.
     *
     * ⚠️ `idleSec` est une colonne, pas du JSON : la lecture ne détoaste aucun détail.
     *
     * ⚠️ `t."driverId"` DANS LE GROUP BY (F13) : la même passe alimente la vue par véhicule
     * et la vue par imputation. Les partitions sont disjointes — un trajet a exactement un
     * véhicule et au plus un conducteur — donc additionner les lignes d'un véhicule redonne
     * EXACTEMENT le ralenti d'avant ce lot. Une seconde requête aurait fini par diverger.
     */
    /**
     * ⚠️ LE MODE VIE PRIVÉE BORNE CETTE REQUÊTE AUSSI (RGPD).
     *
     * `privacyExclude` ne vit que dans `tripWhere` et `alertWhere` : ces deux requêtes écrites à
     * la main l'ignoraient. Relevé en revue le 2026-09-05, et reproduit : un groupe contenant UN
     * véhicule normal et UN véhicule en vie privée voyait la ligne du groupe naître du premier
     * (2 trajets, 12 km) puis encaisser les excès du second (40 excès, +55 km/h). L'écran publiait
     * ainsi la conduite d'un véhicule que le client a explicitement mis sous vie privée, sur une
     * ligne dont les compteurs ne pouvaient pas concorder. Le garde-fou plus bas ne protège que la
     * CRÉATION d'une ligne : il ne pouvait rien contre l'abondement d'une ligne déjà née.
     *
     * Ce filtre remet aussi d'aplomb `consumption.idleSecondsTotal`, qui sommait le ralenti de
     * TOUS les véhicules, privés compris — un total de flotte qui ne retombait sur aucune somme.
     */
    const ralentiParVehicule = this.prisma.$queryRaw<{ vehicleId: string; driverId: string | null; ralenti: number }[]>`
      SELECT ta."vehicleId" AS "vehicleId",
             t."driverId"   AS "driverId",
             COALESCE(SUM(ta."idleSec"), 0)::int AS "ralenti"
        FROM trip_analyses ta
        JOIN trips t ON t.id = ta."tripId"
        JOIN vehicles v ON v.id = ta."vehicleId" AND v."privacyModeEnabled" IS NOT TRUE
       WHERE ta."fleetId" = ${fleetId}::uuid
         AND t."startedAt" >= ${from}
         AND t."startedAt" <  ${to}
         AND t."endedAt" IS NOT NULL
         ${isVehicleScopeRestricted
            ? Prisma.sql`AND ta."vehicleId" = ANY(${scopedVehicleIds}::uuid[])`
            : Prisma.empty}
         ${filtreConducteurSql}
       GROUP BY ta."vehicleId", t."driverId"
    `;

    /**
     * ⚠️ `t."driverId"` dans le GROUP BY pour la même raison que ci-dessus. `COUNT(DISTINCT
     * ta."tripId")` reste sommable : un trajet ne portant qu'un seul conducteur, il ne peut
     * pas être compté dans deux partitions du même véhicule.
     */
    const excesParVehicule = this.prisma.$queryRaw<
      { vehicleId: string; driverId: string | null; exces: number; trajets: number; pire: number }[]
    >`
      SELECT ta."vehicleId"                                     AS "vehicleId",
             t."driverId"                                       AS "driverId",
             COUNT(*)::int                                      AS "exces",
             COUNT(DISTINCT ta."tripId")::int                   AS "trajets",
             COALESCE(MAX((s->>'overKmh')::numeric), 0)::float8 AS "pire"
        FROM trip_analyses ta
        JOIN trips t ON t.id = ta."tripId"
        JOIN vehicles v ON v.id = ta."vehicleId" AND v."privacyModeEnabled" IS NOT TRUE
        CROSS JOIN LATERAL jsonb_array_elements(ta.detail->'speeding') s
       WHERE ta."fleetId" = ${fleetId}::uuid
         AND t."startedAt" >= ${from}
         AND t."startedAt" <  ${to}
         AND t."endedAt" IS NOT NULL
         ${isVehicleScopeRestricted
            ? Prisma.sql`AND ta."vehicleId" = ANY(${scopedVehicleIds}::uuid[])`
            : Prisma.empty}
         ${filtreConducteurSql}
         AND (s->>'durationSec')::numeric >= ${EXCES_DUREE_MIN_SEC}
       GROUP BY ta."vehicleId", t."driverId"
    `;

    // 1) Aggregations globales : sum / avg / max / count en une requete SQL.
    // 2) Group by vehicleId : pour topVehicles + activeVehicleIds.
    // 3) Group by type/severity sur alerts.
    // 4) Detail des 30 trajets recents (avec includes pour le PDF).
    // 5) Group by alerts type + severity.
    const [tripAgg, tripsByVehicle, alertsByType, alertsBySeverity, recentTripsRaw, excesRows, ralentiRows] =
      await Promise.all([
        this.prisma.trip.aggregate({
          where: tripWhere,
          _count: { _all: true },
          _sum: { distanceKm: true, durationSeconds: true, movingSeconds: true },
          _avg: { avgSpeed: true },
          _max: { maxSpeed: true },
        }),
        this.prisma.trip.groupBy({
          // ⚠️ `driverId` en plus du véhicule (F13) : UNE passe pour les DEUX vues du
          // récapitulatif. Le total d'un véhicule est la somme de ses conducteurs — cf.
          // `perVehicle` plus bas, qui réagrège exactement les chiffres d'avant ce lot.
          by: ['vehicleId', 'driverId'],
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
          return [] as { vehicleId: string; driverId: string | null; exces: number; trajets: number; pire: number }[];
        }),
        // Même règle : une colonne accessoire ne doit pas emporter tout le rapport.
        ralentiParVehicule.catch((e: unknown) => {
          this.logger.warn(`Ralenti par véhicule indisponible : ${e instanceof Error ? e.message : e}`);
          return [] as { vehicleId: string; driverId: string | null; ralenti: number }[];
        }),
      ]);
    /**
     * Repli des deux requêtes brutes sur le SEUL véhicule, pour `topVehicles`.
     *
     * ⚠️ Ces chiffres doivent rester EXACTEMENT ceux d'avant ce lot : c'est la carte que le
     * client lit tous les jours, et le PDF comme l'Excel s'en servent. La somme est exacte
     * parce que les partitions (véhicule, conducteur) sont disjointes — y compris pour
     * `trajets`, qui compte des trajets DISTINCTS ne pouvant appartenir qu'à une seule.
     */
    const excesParVehiculeMap = new Map<string, { exces: number; trajets: number; pire: number }>();
    for (const r of excesRows) {
      const e = excesParVehiculeMap.get(r.vehicleId) ?? { exces: 0, trajets: 0, pire: 0 };
      e.exces += r.exces;
      e.trajets += r.trajets;
      e.pire = Math.max(e.pire, r.pire);
      excesParVehiculeMap.set(r.vehicleId, e);
    }
    const ralentiParVehiculeMap = new Map<string, number>();
    for (const r of ralentiRows) {
      ralentiParVehiculeMap.set(r.vehicleId, (ralentiParVehiculeMap.get(r.vehicleId) ?? 0) + r.ralenti);
    }

    const tripCount = tripAgg._count._all;
    const totalKm = tripAgg._sum.distanceKm ?? 0;
    const totalSeconds = tripAgg._sum.durationSeconds ?? 0;
    const totalMovingSeconds = tripAgg._sum.movingSeconds ?? 0;
    /**
     * ⚠️ Vitesse moyenne = km parcourus / TEMPS ROULANT, PAS la moyenne des moyennes de
     * trajet (`_avg.avgSpeed`). Un trajet de 400 m à 8 km/h pesait autant qu'un trajet de
     * 180 km à 110 km/h : le PDF disait 45,1 km/h là où l'Excel (pondéré par la durée) disait
     * 39,3 pour le même véhicule et la même période.
     *
     * Le dénominateur était la durée TOTALE ; c'est désormais le temps roulant, pour que la
     * synthèse de flotte et la ligne d'un trajet mesurent enfin la même chose. Sans ce
     * changement, la fiche d'un véhicule aurait annoncé 36 km/h de moyenne sur des trajets
     * qui affichent chacun 42 : deux nombres justes, incomparables, et rien pour le dire.
     *
     * Repli sur la durée totale quand AUCUN trajet du périmètre n'a de temps roulant connu —
     * c'est-à-dire des trajets d'avant la reprise dont les positions ont été purgées. Mieux
     * vaut un ordre de grandeur explicable qu'un zéro sur une flotte qui a roulé.
     */
    const denomSec = totalMovingSeconds > 0 ? totalMovingSeconds : totalSeconds;
    const avgSpeedKmh = denomSec > 0 ? totalKm / (denomSec / 3600) : 0;
    const maxSpeedKmh = tripAgg._max.maxSpeed ?? 0;
    const activeVehicleIds = new Set(tripsByVehicle.map((g) => g.vehicleId));
    /**
     * Ceux du périmètre qui n'ont AUCUN trajet sur la période. Triés plaque en tête, et
     * les silencieux d'abord : c'est la ligne qu'on veut voir en premier, parce qu'elle
     * demande une réparation et non une décision d'exploitation.
     */
    const silencieuxIds = new Set(dormantVehicles.map((d) => d.vehicleId));
    // ⚠️ Sur le parc VISIBLE. Un véhicule en mode vie privée n'a AUCUN trajet dans ce
    // rapport par construction : le lister ici l'accuserait de n'avoir pas roulé, plaque à
    // l'appui, sur la foi d'une absence que le client a lui-même demandée.
    const idleVehicles = vehiclesVisibles
      .filter((v) => !activeVehicleIds.has(v.id))
      .map((v) => ({
        vehicleId: v.id,
        plate: v.plate,
        group: v.groups?.[0]?.group ?? null,
        silencieux: silencieuxIds.has(v.id),
      }))
      .sort((a, b) => Number(b.silencieux) - Number(a.silencieux) || a.plate.localeCompare(b.plate, 'fr'));

    /**
     * Premier groupe du véhicule — la MÊME source que la colonne « groupe » de `topVehicles`
     * et de `recentTrips` (relation `groups` chargée plus haut, ordonnée par nom, `take: 1`).
     * Le modèle est mono-groupe de facto ; on ne réinterroge pas la base pour le savoir.
     */
    const groupeParVehicule = new Map(vehicles.map((v) => [v.id, v.groups?.[0]?.group ?? null]));

    /**
     * ── LA CLÉ D'IMPUTATION EST CELLE DU CLASSEMENT (F13) ─────────────────────────────
     *
     * Conducteur si `trip.driverId` est renseigné, sinon PREMIER groupe du véhicule, sinon
     * « non attribué ». La règle vit dans le CONTRAT PARTAGÉ (`cleImputationTrajet`), d'où
     * l'écran des scores la tire aussi pour sa 4ᵉ portée : deux copies auraient donné deux
     * réponses à la même question — « combien a roulé ce conducteur ce mois-ci ? ».
     *
     * Pourquoi le repli sur le groupe n'est pas un détail, mesuré en production le
     * 2026-09-05 : chez cdef31, 2 675 trajets sur 2 707 n'ont PAS de conducteur mais ont un
     * groupe — sans ce repli, 99 % du parc serait « non attribué » et la vue ne dirait rien.
     */
    const cleAttribution = (driverId: string | null, vehicleId: string): string =>
      cleImputationTrajet(driverId, groupeParVehicule.get(vehicleId)?.id ?? null);

    // Map perVehicle pour calcul carburant + top.
    const perVehicle = new Map<string, { distanceKm: number; tripCount: number; durationSeconds: number }>();
    /** Agrégat par clé d'imputation, alimenté par la MÊME passe que `perVehicle`. */
    const parAttribution = new Map<string, {
      key: string; kind: 'driver' | 'group'; driverId: string | null; groupName: string | null;
      distanceKm: number; durationSeconds: number; tripCount: number;
      speedingCount: number; speedingTripCount: number; worstOverKmh: number; idleSeconds: number;
    }>();
    /** Les trajets qu'on ne peut imputer à personne : comptés, jamais classés. */
    const nonAttribue = { tripCount: 0, distanceKm: 0, durationSeconds: 0 };
    const ligneAttribution = (driverId: string | null, vehicleId: string) => {
      const key = cleAttribution(driverId, vehicleId);
      if (key === CLE_NON_ATTRIBUE) return null;
      let a = parAttribution.get(key);
      if (!a) {
        a = {
          key,
          kind: driverId ? 'driver' : 'group',
          driverId: driverId ?? null,
          groupName: driverId ? null : (groupeParVehicule.get(vehicleId)?.name ?? null),
          distanceKm: 0, durationSeconds: 0, tripCount: 0,
          speedingCount: 0, speedingTripCount: 0, worstOverKmh: 0, idleSeconds: 0,
        };
        parAttribution.set(key, a);
      }
      return a;
    };

    for (const g of tripsByVehicle) {
      const km = g._sum.distanceKm ?? 0;
      const sec = g._sum.durationSeconds ?? 0;
      const n = g._count._all;
      // Vue VÉHICULE : on réagrège sur les conducteurs. Le groupBy porte désormais
      // ['vehicleId', 'driverId'] — sans cette somme, un véhicule à deux conducteurs ne
      // rendrait dans `topVehicles` que les kilomètres du dernier groupe lu.
      const v = perVehicle.get(g.vehicleId) ?? { distanceKm: 0, tripCount: 0, durationSeconds: 0 };
      v.distanceKm += km;
      v.tripCount += n;
      v.durationSeconds += sec;
      perVehicle.set(g.vehicleId, v);
      // Vue IMPUTATION : même passe, autre clé.
      const a = ligneAttribution(g.driverId ?? null, g.vehicleId);
      if (a) {
        a.distanceKm += km;
        a.durationSeconds += sec;
        a.tripCount += n;
      } else {
        nonAttribue.tripCount += n;
        nonAttribue.distanceKm += km;
        nonAttribue.durationSeconds += sec;
      }
    }

    // Excès et ralenti reportés sur la ligne d'imputation.
    // ⚠️ On ne CRÉE aucune ligne ici : les deux requêtes brutes ignorent le mode vie privée
    // (RGPD), que `tripWhere` exclut. Créer une ligne depuis elles ferait apparaître, dans
    // le récapitulatif, un conducteur dont aucun kilomètre n'est compté — et `topVehicles`,
    // qui ne lit ses excès que pour les véhicules ayant roulé, ne le montrerait pas.
    for (const r of excesRows) {
      const a = parAttribution.get(cleAttribution(r.driverId ?? null, r.vehicleId));
      if (!a) continue;
      a.speedingCount += r.exces;
      a.speedingTripCount += r.trajets;
      a.worstOverKmh = Math.max(a.worstOverKmh, r.pire);
    }
    for (const r of ralentiRows) {
      const a = parAttribution.get(cleAttribution(r.driverId ?? null, r.vehicleId));
      if (a) a.idleSeconds += r.ralenti;
    }

    // Moyenne kilométrique : MÊME population des deux côtés de la division.
    // On ne divise pas les km de TOUT le parc par le seul parc exploité — ça
    // gonflerait la moyenne d'un véhicule tombé en panne EN COURS de période (ses
    // km comptés, sa place non). Numérateur et dénominateur portent donc tous deux
    // sur les véhicules exploités.
    //
    // ⚠️ UN FILTRE CONDUCTEUR EST UNE POPULATION, LUI AUSSI (F13, relevé en revue).
    //
    // Le numérateur descend de `tripWhere`, donc du filtre ; le dénominateur venait du
    // PARC. Les 400 km d'une seule personne se divisaient par les 35 véhicules exploités
    // de la société : « 11,4 km » là où la réponse est 400, dont 34 véhicules qu'elle n'a
    // jamais conduits. Et ce chiffre n'existe QUE dans le PDF — aucun écran ne l'affiche,
    // donc rien ne pouvait le démentir une fois le fichier parti par courriel.
    //
    // La base suit donc le filtre : les véhicules exploités que CE filtre a fait rouler.
    // Sans filtre, `baseMoyenneIds` EST `exploitedVehicleIds` — le chiffre que le client
    // compare d'une semaine sur l'autre ne bouge pas d'un dixième.
    const baseMoyenneIds = driverScope === undefined
      ? exploitedVehicleIds
      : new Set([...exploitedVehicleIds].filter((id) => activeVehicleIds.has(id)));
    const exploitedKm = Array.from(baseMoyenneIds).reduce(
      (sum, id) => sum + (perVehicle.get(id)?.distanceKm ?? 0),
      0,
    );
    // Repli anti-division-par-zéro. Un parc 100 % dormant (client qui a rendu ses
    // boîtiers, flotte hivernée) doit produire un CHIFFRE, jamais NaN ni Infinity :
    // on retombe alors sur le parc entier, et la mention d'exclusion explique au
    // lecteur pourquoi ce chiffre est ce qu'il est.
    //
    // ⚠️ SOUS FILTRE, CE REPLI NE DOIT SURTOUT PAS RENDRE LE PARC. Un conducteur qui n'a
    // roulé que sur des véhicules devenus dormants vide `baseMoyenneIds` : retomber sur
    // `totalVehicles` rouvrirait par la porte de derrière la faute qu'on vient de fermer.
    // On replie sur les véhicules que ce filtre a fait rouler — et `totalKm` est
    // exactement leur somme, donc les deux moitiés restent accordées. Aucun trajet du
    // tout : 0 et 0, et le garde de `avgKmPerVehicle` rend 0 sans diviser.
    const hasExploited = baseMoyenneIds.size > 0;
    const avgKmBasisVehicles = hasExploited
      ? baseMoyenneIds.size
      : (driverScope === undefined ? totalVehicles : activeVehicleIds.size);
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
          idleSeconds: ralentiParVehiculeMap.get(v.id) ?? 0,
        });
      }
    }
    topVehicles.sort((a, b) => b.distanceKm - a.distanceKm);
    /** Profondeur demandée par l'appelant, UNE seule fois : les deux vues se plafonnent pareil. */
    const topN = Math.min(50, Math.max(1, Math.trunc(filters?.topN ?? 10)));

    /**
     * Noms des conducteurs des lignes d'imputation — une requête, et AUCUNE quand pas un
     * seul trajet ne porte de conducteur. C'est le cas courant, pas l'exception : mh cars
     * comptait 1 866 trajets sans conducteur sur 1 886 au 2026-09-05.
     *
     * ⚠️ Bornée à la flotte du rapport, comme tout le reste : un `driverId` ne vient jamais
     * d'ailleurs, mais une jointure de nom ne doit pas être le seul endroit qui l'oublie.
     */
    const driverIds = [...new Set(
      [...parAttribution.values()].map((a) => a.driverId).filter((id): id is string => !!id),
    )];

    // P3 carburant — prix RÉELLEMENT CONSTATÉ en station sur la période (moyenne des prix captés aux
    // passages station du périmètre), pour comparer au prix paramétré. Best-effort : null si aucun passage.
    // Lancé EN PARALLÈLE de la lecture des conducteurs : le VPS a 2 vCPU, deux allers-retours
    // séquentiels de plus par rapport hebdomadaire se paient sur chaque société.
    /**
     * ── CE CHIFFRE NE SUIT PAS LE FILTRE CONDUCTEUR, ET C'EST DÉLIBÉRÉ (F13) ─────────────
     *
     * `TripFuelStop` n'a PAS de conducteur : un passage en station est un arrêt du VÉHICULE.
     * Le `where` ci-dessous reste donc borné au périmètre véhicule, `driverScope` n'y entre
     * pas — et ce n'est pas un oubli, c'est le seul choix qui ne fabrique aucun énoncé faux :
     *
     *   · le neutraliser sous filtre (rendre `null`) ferait écrire à l'écran « Aucun prix
     *     relevé en station sur la période ». FAUX : des prix ont bien été relevés, ils ne
     *     sont simplement imputables à personne ;
     *   · le filtrer par les véhicules qu'a conduits la personne ferait un chiffre HYBRIDE —
     *     les pleins faits par les autres sur ces mêmes véhicules y entreraient — sous un
     *     nom propre, ce qui est pire que le chiffre de parc, parce que ça se croit filtré.
     *
     * Ce qui n'était pas permis, c'est de se TAIRE : muet sous un nom propre, « 12 passages
     * station » s'attribue tout seul à la personne nommée. Les TROIS surfaces le disent donc
     * désormais, chacune à sa manière — l'écran (`noteCarburantConducteur` de
     * `reports.component.ts`) et le PDF (`renderKpis`) GARDENT le chiffre et écrivent
     * pourquoi ; le classeur Excel, qui liste les arrêts un par un, les RETIRE et l'écrit
     * (une liste nominative d'arrêts d'autrui n'a pas d'excuse).
     *
     * ⚠️ Seuls les LITRES valorisés suivent le filtre : `estimatedCostAtObservedEur` vaut
     * litres-du-filtre × prix-du-parc, et les trois surfaces l'annoncent en ces termes.
     */
    /**
     * ── LA VIE PRIVÉE, ELLE, BORNE BIEN CE CHIFFRE — ET CE N'EST PAS LE MÊME SUJET ────────
     *
     * Ne pas confondre les deux axes. Le FILTRE CONDUCTEUR ne s'applique pas ici (ci-dessus,
     * c'est une décision). Le MODE VIE PRIVÉE, lui, retire le véhicule DU PÉRIMÈTRE : ses
     * trajets, ses alertes, ses excès, son ralenti et son classement en sortent tous, et le
     * classeur Excel refuse même de le traiter. Ses passages en station doivent en sortir
     * aussi, sans quoi le PDF du lundi imprime « N passages station » dont une part vient
     * d'un véhicule que le client a explicitement soustrait au regard — et la phrase que ce
     * lot ajoute juste à côté (« ils portent sur les véhicules du périmètre ») devient fausse.
     *
     * ⚠️ POURQUOI CET AGRÉGAT AVAIT ÉCHAPPÉ AUX DEUX RATTRAPAGES PRÉCÉDENTS. `TripFuelStop`
     * porte `vehicleId` en SCALAIRE, sans relation `vehicle` déclarée : `privacyExclude`
     * (`NOT: { vehicle: { privacyModeEnabled: true } }`) lui est littéralement inapplicable.
     * C'est la même raison qui avait fait manquer les deux requêtes écrites à la main le
     * 2026-09-05 — une borne qui ne s'exprime pas de la même façon est une borne qu'on
     * oublie. L'exclusion passe donc par les identifiants, d'où le drapeau chargé plus haut.
     *
     * Sur un parc SANS véhicule privé, le `where` reste à l'octet près celui d'avant : la
     * liste des exclus est vide, aucune clé n'est ajoutée.
     */
    const idsSousViePrivee = vehicles.filter((v) => v.privacyModeEnabled).map((v) => v.id);
    const bornePassagesStation = isVehicleScopeRestricted
      // Périmètre restreint : le `in` ne retient que les véhicules VISIBLES. Une seule clé
      // `vehicleId`, jamais deux homonymes dont la seconde écraserait la première.
      ? { vehicleId: { in: vehicles.filter((v) => !v.privacyModeEnabled).map((v) => v.id) } }
      // Parc entier : `notIn` plutôt qu'un `in` de tout le parc — la liste des privés est
      // courte et l'index (fleetId, arrivedAt) reste utilisable.
      : { fleetId: fleet.id, ...(idsSousViePrivee.length > 0 ? { vehicleId: { notIn: idsSousViePrivee } } : {}) };
    const [fuelStopAgg, driverRows] = await Promise.all([
      this.prisma.tripFuelStop.aggregate({
        where: {
          /**
           * ⚠️ BORNE HAUTE EXCLUSIVE, comme les trajets (`tripWhere`), les alertes
           * (`alertWhere`) et les deux requêtes brutes : `to` est le LENDEMAIN minuit, jamais
           * un 23:59:59 (tous les appelants le construisent par `parisDayStart`). Avec `lte`,
           * un passage horodaté à minuit pile — et la milliseconde vaut TOUJOURS zéro, les
           * horodatages des boîtiers sont à la seconde — entrait dans DEUX rapports voisins
           * et pesait dans les deux moyennes `observedPriceEurL` que le client compare d'un
           * mois sur l'autre. Le rapport hebdomadaire du lundi produit chaque semaine deux
           * fenêtres dont la borne est exactement le même instant. Même arbitrage, mot pour
           * mot, que `trips.service.list`.
           */
          arrivedAt: { gte: from, lt: to },
          unitPriceEur: { not: null },
          ...bornePassagesStation,
        },
        _avg: { unitPriceEur: true },
        _count: { _all: true },
      }),
      driverIds.length > 0
        ? this.prisma.driver.findMany({
            where: { id: { in: driverIds }, fleetId },
            select: { id: true, firstName: true, lastName: true },
          })
        : Promise.resolve([] as { id: string; firstName: string; lastName: string }[]),
    ]);
    const nomParConducteur = new Map(driverRows.map((d) => [d.id, `${d.firstName} ${d.lastName}`.trim()]));

    const byAttribution: NonNullable<FleetStatsReport['byAttribution']> = [...parAttribution.values()]
      .map((a) => ({
        key: a.key,
        label: a.kind === 'driver'
          // Supprimer un conducteur remet `Trip.driverId` à NULL (onDelete: SetNull) : ce
          // repli ne devrait jamais s'afficher. Une ligne sans nom vaut quand même mieux
          // qu'une ligne escamotée, qui emporterait ses kilomètres avec elle.
          ? (nomParConducteur.get(a.driverId ?? '') || 'Conducteur inconnu')
          : (a.groupName ?? 'Groupe sans nom'),
        kind: a.kind,
        tripCount: a.tripCount,
        distanceKm: Math.round(a.distanceKm * 10) / 10,
        durationHours: Math.round((a.durationSeconds / 3600) * 10) / 10,
        // ⚠️ Kilomètres ÷ heures de conduite, comme `topVehicles` et comme la vitesse
        // moyenne de flotte — jamais la moyenne des moyennes de trajet.
        avgSpeedKmh: a.durationSeconds > 0
          ? Math.round(a.distanceKm / (a.durationSeconds / 3600))
          : 0,
        speedingCount: a.speedingCount,
        speedingTripCount: a.speedingTripCount,
        worstOverKmh: Math.round(a.worstOverKmh * 10) / 10,
        idleSeconds: a.idleSeconds,
      }))
      // Départage par le libellé : l'ordre d'une Map suit l'ordre des lignes rendues par la
      // base, qui n'est garanti par rien. Deux appels identiques doivent classer pareil.
      .sort((x, y) => y.distanceKm - x.distanceKm || x.label.localeCompare(y.label, 'fr'));
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
        idleVehicles: idleVehicles.slice(0, MAX_VEHICULES_IMMOBILES),
        idleTotal: idleVehicles.length,
        hiddenByPrivacy,
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
        idleSecondsTotal: ralentiRows.reduce((n, r) => n + Math.max(0, r.ralenti), 0),
      },
      // Le curseur « Top N » de la modale ne pouvait rien au-delà de 10 : tranché ici avant
      // que le PDF ne le lise. Plafond 50, comme le DTO.
      topVehicles: topVehicles.slice(0, topN),
      // MÊME plafond que la vue par véhicule : les deux moitiés d'une bascule ne peuvent pas
      // montrer des profondeurs différentes sans que le lecteur croie à une donnée manquante.
      byAttribution: byAttribution.slice(0, topN),
      // Le compte RÉEL, pour que la troncature se dise au lieu de se deviner.
      byAttributionTotal: byAttribution.length,
      unattributedTrips: {
        tripCount: nonAttribue.tripCount,
        distanceKm: Math.round(nonAttribue.distanceKm * 10) / 10,
        durationHours: Math.round((nonAttribue.durationSeconds / 3600) * 10) / 10,
      },
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
 * @param options.filtreConducteur le rapport ne porte que sur UN conducteur (F13). La
 *   dernière phrase change alors de sujet : voir le commentaire qui la surplombe.
 * @returns `null` quand rien n'est exclu — pas de mention inutile sur un parc sain.
 */
export function buildExploitedScopeNotice(
  report: FleetStatsReport,
  options?: { maxPlates?: number; filtreConducteur?: boolean },
): string | null {
  const maxPlates = options?.maxPlates ?? NOTICE_MAX_PLATES;
  const { dormant, withoutTracker, dormantVehicles, total, hiddenByPrivacy } = report.vehicles;
  // ⚠️ `hiddenByPrivacy` OUVRE AUSSI L'ENCART. Un parc sain mais partiellement masqué n'a ni
  // dormant ni véhicule sans boîtier : l'encart rendait donc `null`, et le document sortait
  // avec un parc rétréci sans un mot. Le papier voyage par courriel et ressort d'un classeur
  // des mois plus tard, sans écran pour le démentir.
  if (dormant === 0 && withoutTracker === 0 && hiddenByPrivacy === 0) return null;

  const parts: string[] = [];

  if (hiddenByPrivacy > 0) {
    // En PREMIER : c'est la ligne qui explique pourquoi le total du parc n'est pas celui que
    // le client a en tête. Lue après les dormants, elle arriverait trop tard.
    parts.push(
      `${hiddenByPrivacy} véhicule${plural(hiddenByPrivacy)} en mode vie privée — ` +
      `exclu${plural(hiddenByPrivacy)} de TOUT ce rapport, y compris du parc total : ` +
      `ni trajet, ni kilomètre, ni alerte n'en est rapporté.`,
    );
  }

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
  if (options?.filtreConducteur) {
    /**
     * ⚠️ SOUS FILTRE CONDUCTEUR, LA PHRASE DE FLOTTE DEVIENT UN FAUX.
     *
     * « Distance moyenne calculée sur 35 véhicules exploités (400.0 km) — parc total
     * inchangé : 39 » présente les kilomètres d'UNE personne comme ceux du parc exploité,
     * et donne au lecteur les deux moitiés d'une division qui ne décrivent pas la même
     * population. La base a changé (cf. `baseMoyenneIds`) : la phrase change avec elle.
     *
     * Formulée sans nommer personne : elle vaut pour un conducteur choisi comme pour
     * « sans conducteur », et le nom est déjà imprimé en gras en tête de document.
     *
     * ⚠️ `basis === 0` EST ATTEIGNABLE : un conducteur qui n'a pas roulé du mois (congés,
     * arrêt) ne fait rouler aucun véhicule, la base est vide et `avgKmPerVehicle` vaut 0
     * par garde. Écrire « 0.0 km sur 0 véhicule » imprimerait une division par zéro dans
     * un document que le client relit — on dit l'absence de base au lieu de la mettre en
     * forme. Le reste de la mention (plaques dormantes, parc total) est inchangé : il
     * décrit le parc, que le filtre ne touche pas.
     */
    parts.push(
      basis > 0
        ? `Rapport filtré sur un conducteur : la distance moyenne se divise par les seuls ` +
          `véhicules que ce filtre retient, jamais par le parc — ` +
          `${report.trips.avgKmBasisKm.toFixed(1)} km sur ${basis} véhicule${plural(basis)}. ` +
          `Parc total inchangé : ${total}.`
        : `Rapport filtré sur un conducteur : aucun trajet retenu par ce filtre sur la ` +
          `période — la distance moyenne n'a pas de base et vaut 0, elle ne se divise en ` +
          `aucun cas par le parc. Parc total inchangé : ${total}.`,
    );
  } else if (report.vehicles.exploited === 0) {
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
