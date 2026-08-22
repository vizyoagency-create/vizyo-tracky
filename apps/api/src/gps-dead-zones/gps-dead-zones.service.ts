import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  GpsDeadZone,
  GpsDeadZoneLabel,
  GpsDeadZoneStatus,
  GpsLossEvent,
  Prisma,
  UserRole,
} from '@prisma/client';
import { distanceMeters } from '../common/utils/haversine';
import { PrismaService } from '../prisma/prisma.service';
import { ReverseGeocodeService } from '../geocoding/reverse-geocode.service';

/**
 * Zones mortes GPS (2026-07) — suivi de l'incident FS-253.
 *
 * Problème : un véhicule qui perd son lock GPS peut être en panne d'antenne (à réparer,
 * FS-253) OU simplement garé dans un endroit qui masque le ciel — parking souterrain/couvert,
 * tunnel — voire sous un brouilleur. La différence ne se voit pas sur UNE perte, mais sur la
 * RÉCURRENCE : si le même véhicule reperd le GPS au MÊME endroit, c'est structurel, pas une
 * panne. Reconnaître ces zones évite de « partir vérifier » à chaque fois (ce que l'exploitant
 * a dû faire pour FS-253) et permet de taire l'alerte sur un parking habituel confirmé.
 *
 * Ancre de clustering : la dernière position VALIDE avant la perte. Quand le boîtier perd le
 * fix, `Tracker.lastLat/lastLng/lastPositionAt` restent FIGÉS sur ce dernier point (l'ingestion
 * `no_fix` ne réécrit aucune coordonnée) — c'est le point d'entrée de la zone (rampe de parking,
 * bouche de tunnel). On regroupe ces points par proximité, par véhicule.
 *
 * Idempotence : un épisode de perte est identifié par `lostAt` (= la position figée), donc
 * un même épisode ne compte qu'UNE fois même si le cron gps-integrity le re-sélectionne à
 * chaque tick (contrainte unique `(vehicleId, lostAt)`). Deux stationnements distincts ont un
 * `lostAt` différent → deux occurrences.
 */
/**
 * Marge de regroupement des DOUBLONS d'un même épisode de perte.
 *
 * Le cron d'intégrité peut ouvrir plusieurs épisodes pour une seule perte s'il tourne
 * pendant que la donnée est incohérente. Ces doublons naissent à quelques minutes les uns
 * des autres : une heure les couvre très largement.
 *
 * ⚠️ Ce n'est PAS une durée maximale d'absence — voir le commentaire de `recordRecovery`.
 * Un épisode de cinq semaines est parfaitement légitime et doit se fermer normalement.
 */
const MARGE_DOUBLON_EPISODE_MS = 60 * 60 * 1000;

@Injectable()
export class GpsDeadZonesService {
  private readonly logger = new Logger(GpsDeadZonesService.name);

  /** Rayon (m) de rattachement d'une perte à une zone existante. Réglable via env. */
  readonly matchRadiusM: number;
  /** Occurrences (épisodes distincts) à partir desquelles une zone est « reconnue » (RECURRING). */
  readonly minOccurrences: number;
  /**
   * Occurrences à partir desquelles une zone est AUTOMATIQUEMENT qualifiée de parking
   * souterrain, donc rendue silencieuse — décision du propriétaire, 2026-08-17.
   *
   * Réglable via `GPS_DEADZONE_AUTO_PARKING_OCCURRENCES`, défaut **2**.
   *
   * ⚠️ **Plancher dur à 2, jamais 1.** La toute PREMIÈRE perte dans un lieu doit toujours
   * alerter : c'est le seul moment où l'exploitant apprend qu'un véhicule a perdu le GPS
   * quelque part. Un seuil à 1 rendrait le détecteur muet dès la première occurrence, donc
   * entièrement inutile. Le plancher est structurel, pas conventionnel.
   */
  readonly autoParkingOccurrences: number;
  /** Borne haute du rayon observé d'une zone (évite qu'un cluster n'avale toute une ville). */
  private readonly maxRadiusM = 400;

  constructor(
    private readonly prisma: PrismaService,
    private readonly geocode: ReverseGeocodeService,
  ) {
    const radius = Number(process.env.GPS_DEADZONE_MATCH_RADIUS_M);
    this.matchRadiusM = Number.isFinite(radius) && radius > 0 ? radius : 150;
    const min = Number(process.env.GPS_DEADZONE_MIN_OCCURRENCES);
    this.minOccurrences = Number.isFinite(min) && min >= 2 ? Math.floor(min) : 3;
    const auto = Number(process.env.GPS_DEADZONE_AUTO_PARKING_OCCURRENCES);
    this.autoParkingOccurrences = Number.isFinite(auto) && auto >= 2 ? Math.floor(auto) : 2;
  }

  /**
   * Enregistre un épisode de perte GPS et le rattache (ou crée) une zone morte.
   *
   * IDEMPOTENT : renvoie sans rien recompter si l'épisode `(vehicleId, lostAt)` est déjà connu.
   * Renvoie `null` si les coordonnées sont invalides (on ne peut pas géolocaliser la perte).
   *
   * L'insertion de l'épisode (contrainte unique) sert de VERROU : le premier appelant qui réussit
   * l'insert « possède » l'épisode et fait le clustering ; un appel concurrent tombe sur la
   * violation d'unicité et ne recompte pas (pas de double comptage du centroïde/occurrences).
   */
  async recordLoss(input: {
    vehicleId: string;
    fleetId: string;
    trackerId: string | null;
    lat: number;
    lng: number;
    lostAt: Date;
  }): Promise<{ zone: GpsDeadZone; isNewEpisode: boolean } | null> {
    const { vehicleId, fleetId, trackerId, lat, lng, lostAt } = input;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    // 1) Verrou d'idempotence. On VÉRIFIE d'abord l'existence : une perte GPS EN COURS est ré-observée
    //    à chaque tick avec le MÊME `lostAt`, donc `create()` heurterait la contrainte unique
    //    `(vehicleId, lostAt)` en boucle → Prisma logge un `prisma:error` à chaque tick (bruit, faux
    //    positif). Le check préalable évite la violation dans le cas courant ; `create()` reste sous
    //    try/catch P2002 pour la course rare (deux ticks concurrents entre le check et l'insert).
    const already = await this.prisma.gpsLossEvent.findUnique({
      where: { vehicleId_lostAt: { vehicleId, lostAt } },
      include: { zone: true },
    });
    if (already) {
      // Épisode déjà enregistré (même `lostAt`) → idempotent, on ne re-cluster pas.
      return already.zone ? { zone: already.zone, isNewEpisode: false } : null;
    }

    let event: GpsLossEvent;
    try {
      event = await this.prisma.gpsLossEvent.create({
        data: { vehicleId, fleetId, trackerId, lat, lng, lostAt },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // Course rare : un autre tick a inséré l'épisode entre le check et le create → idempotent.
        const existing = await this.prisma.gpsLossEvent.findUnique({
          where: { vehicleId_lostAt: { vehicleId, lostAt } },
          include: { zone: true },
        });
        return existing?.zone ? { zone: existing.zone, isNewEpisode: false } : null;
      }
      throw err;
    }

    // 2) On possède l'épisode → on cluster (rattacher à la zone la plus proche, sinon en créer une).
    const zones = await this.prisma.gpsDeadZone.findMany({ where: { vehicleId } });
    const match = this.nearestZone(zones, lat, lng);
    const zone = match
      ? await this.extendZone(match, lat, lng)
      : await this.prisma.gpsDeadZone.create({
          data: {
            vehicleId,
            fleetId,
            centroidLat: lat,
            centroidLng: lng,
            radiusM: 0,
            occurrences: 1,
            status:
              this.minOccurrences <= 1 ? GpsDeadZoneStatus.RECURRING : GpsDeadZoneStatus.LEARNING,
          },
        });

    // 3) Lier l'épisode à sa zone.
    await this.prisma.gpsLossEvent.update({ where: { id: event.id }, data: { zoneId: zone.id } });

    // 4) Nommer la zone (géocodage best-effort, non bloquant) si pas encore fait.
    void this.ensurePlaceLabel(zone);

    return { zone, isNewEpisode: true };
  }

  /**
   * TRK-028 — le RETOUR du signal. Ferme l'épisode que ce retour termine réellement.
   *
   * ⚠️ APPELÉ DEPUIS LE CHEMIN D'INGESTION, donc sous contrainte de coût. L'appelant
   * (`positions.service`) ne déclenche cette écriture QUE lorsqu'une position valide
   * arrive après un silence assez long pour qu'un épisode ait pu être ouvert — sur une
   * trame ordinaire, il n'y a même pas de requête. Sans ce filtre, on paierait deux
   * requêtes par trame et par véhicule, sur la route la plus chaude du système.
   *
   * IDEMPOTENT : le `where` ne retient que `recoveredAt: null`. Un second appel ne trouve
   * plus rien et n'écrase aucune date déjà posée — la PREMIÈRE position valide après la
   * perte est la bonne, pas la dixième.
   *
   * ── TRK-031 : POURQUOI CE N'EST PLUS « TOUS LES ÉPISODES OUVERTS » (2026-08-20) ──────
   *
   * Ce code fermait TOUS les épisodes ouverts du véhicule à la date du jour. Le
   * commentaire assumait ce choix : « un véhicule peut porter plusieurs épisodes ouverts
   * si le cron a tourné pendant que la donnée était incohérente ; on les ferme tous
   * plutôt que d'en laisser traîner un qui fausserait toutes les moyennes ensuite. »
   *
   * L'intention est juste pour des DOUBLONS DU MÊME ÉPISODE. Elle est fausse pour un
   * épisode d'un autre mois — et elle produit précisément ce qu'elle voulait éviter.
   * Mesuré le 2026-08-19 : FS-253-HR ressort de son parking à 13:48:56 et **neuf**
   * épisodes se referment à cette seconde, avec des durées de 6,94 à **35,18 jours**.
   * Huit sont fabriquées : pendant les prétendus 35 jours, le boîtier a émis **5 027
   * positions**. La médiane de la zone est passée à 16 jours pour un parking dont le
   * véhicule ressort en une semaine — sur l'écran même que TRK-028 avait créé pour
   * cesser de rester vague avec l'exploitant.
   *
   * 🔑 Un rattrapage sans date de coupure réécrit le passé avec le présent. Une fonction
   * idempotente sur le flux qu'elle produit ne l'est pas sur le stock qu'elle n'a pas
   * produit.
   *
   * ── LA RÈGLE RETENUE, ET POURQUOI PAS UNE FENÊTRE FIXE ───────────────────────────────
   *
   * L'épisode que ce retour referme est **le plus récent encore ouvert**. On ferme celui-là
   * et ses doublons — les épisodes ouverts dans la MARGE qui le précède, qui décrivent la
   * même perte. Les plus anciens restent ouverts : ce sont des restes d'avant le correctif,
   * ils relèvent de l'assainissement (`prisma/assainir-episodes-gps.ts`), pas de l'ingestion.
   *
   * ⚠️ Une fenêtre fixe du type « ne fermer que si la perte a moins de 7 jours » aurait été
   * FAUSSE : un véhicule réellement absent cinq semaines a une absence de cinq semaines, et
   * la refuser laisserait son épisode ouvert pour toujours. La borne ne doit pas porter sur
   * l'ANCIENNETÉ de la perte, mais sur le fait qu'un épisode plus récent existe.
   */
  async recordRecovery(input: { vehicleId: string; at: Date }): Promise<number> {
    const { vehicleId, at } = input;
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) return 0;

    const courant = await this.prisma.gpsLossEvent.findFirst({
      where: { vehicleId, recoveredAt: null },
      orderBy: { lostAt: 'desc' },
      select: { lostAt: true },
    });
    if (!courant) return 0;

    /**
     * ⚠️ UN RETOUR NE PEUT PAS PRÉCÉDER LA PERTE, et ce n'est pas théorique : `at` est
     * l'heure BOÎTIER de la trame, et un Coban qui rejoue son tampon après une coupure
     * réseau émet des horodatages antérieurs au temps réel (c'est tout le sujet de
     * TRK-015). Sans ce garde-fou, une trame rejouée poserait une date de retour AVANT
     * la perte : durée négative, silencieusement écartée du calcul de médiane, et un
     * épisode marqué clos qui ne l'est pas.
     */
    if (at.getTime() <= courant.lostAt.getTime()) {
      this.logger.debug(
        `Vehicule ${vehicleId} : retour a ${at.toISOString()} anterieur a la perte ` +
          `(${courant.lostAt.toISOString()}) — ignore, trame probablement rejouee.`,
      );
      return 0;
    }

    const seuilDoublon = new Date(courant.lostAt.getTime() - MARGE_DOUBLON_EPISODE_MS);
    const { count } = await this.prisma.gpsLossEvent.updateMany({
      where: { vehicleId, recoveredAt: null, lostAt: { gte: seuilDoublon } },
      data: { recoveredAt: at },
    });
    if (count > 0) {
      this.logger.log(
        `Vehicule ${vehicleId} : signal GPS retrouve, ${count} episode(s) clos a ${at.toISOString()}.`,
      );
    }
    return count;
  }

  /**
   * La durée TYPIQUE d'une absence sur une zone, en minutes — la médiane, pas la moyenne.
   *
   * ⚠️ LA MÉDIANE, ET C'EST UNE DÉCISION. Un véhicule qui dort trois jours au parking
   * pendant les congés produit un épisode de 72 h ; la moyenne s'envole et annonce une
   * durée que l'exploitant ne verra jamais. La médiane décrit le cas ordinaire, qui est
   * précisément ce qu'on cherche à faire comprendre.
   *
   * `null` tant qu'aucun épisode n'est clos : on ne devine pas une durée, on se tait.
   */
  private dureeTypiqueMinutes(events: { lostAt: Date; recoveredAt: Date | null }[]): number | null {
    const durees = events
      .filter((e) => e.recoveredAt)
      .map((e) => (e.recoveredAt as Date).getTime() - e.lostAt.getTime())
      .filter((ms) => ms > 0)
      .sort((a, b) => a - b);
    if (durees.length === 0) return null;
    const milieu = Math.floor(durees.length / 2);
    const ms =
      durees.length % 2 === 1 ? durees[milieu] : (durees[milieu - 1] + durees[milieu]) / 2;
    return Math.round(ms / 60_000);
  }

  /** Zone du véhicule la plus proche du point ET dans le rayon de rattachement, ou null. */
  private nearestZone(zones: GpsDeadZone[], lat: number, lng: number): GpsDeadZone | null {
    let best: GpsDeadZone | null = null;
    let bestDist = Infinity;
    for (const z of zones) {
      const d = distanceMeters(z.centroidLat, z.centroidLng, lat, lng);
      if (d <= this.matchRadiusM && d < bestDist) {
        best = z;
        bestDist = d;
      }
    }
    return best;
  }

  /** Étend une zone : centroïde en moyenne mobile, rayon = plus grand écart observé (borné). */
  private extendZone(zone: GpsDeadZone, lat: number, lng: number): Promise<GpsDeadZone> {
    const n = zone.occurrences;
    const centroidLat = (zone.centroidLat * n + lat) / (n + 1);
    const centroidLng = (zone.centroidLng * n + lng) / (n + 1);
    const spread = distanceMeters(centroidLat, centroidLng, lat, lng);
    const radiusM = Math.min(Math.max(zone.radiusM, spread), this.maxRadiusM);
    const occurrences = n + 1;
    // Seule une zone encore en apprentissage passe automatiquement à RECURRING. Les décisions
    // opérateur (CONFIRMED_BENIGN / SUSPECT) sont préservées — elles ne doivent pas régresser.
    let status =
      zone.status === GpsDeadZoneStatus.LEARNING && occurrences >= this.minOccurrences
        ? GpsDeadZoneStatus.RECURRING
        : zone.status;
    let label = zone.label;

    /**
     * 🔑 **Qualification AUTOMATIQUE en parking souterrain (décision du propriétaire, 17/08).**
     *
     * Cause réelle constatée sur le terrain : les véhicules se garent dans des **parkings
     * souterrains**. Le boîtier reste joignable (GSM passe) mais perd le ciel — d'où un
     * `no_fix` frais et une position figée, exactement le motif que ce détecteur cherche.
     * Reperdre le GPS **au même endroit** est donc la signature d'un lieu, pas d'une panne.
     *
     * Règle : à la **2ᵉ** occurrence, on pose `UNDERGROUND_PARKING` + `CONFIRMED_BENIGN`,
     * ce qui rend le lieu silencieux (cf. `GpsIntegrityService`). La 1ʳᵉ perte, elle, alerte
     * toujours — c'est le seul signal utile.
     *
     * ⚠️ **On ne touche JAMAIS une zone qu'un opérateur a revue** (`reviewedAt` non nul) :
     * un humain qui a posé `SUSPECT` (brouilleur possible) ne doit pas voir sa décision
     * écrasée par une heuristique. Le test porte sur `reviewedAt`, pas sur le statut : c'est
     * la seule marque fiable de « quelqu'un a une opinion ici ».
     *
     * ⚠️ **Ce que ça coûte, écrit noir sur blanc** — une antenne morte produit aussi des
     * pertes répétées au même endroit (là où le véhicule se gare d'habitude). À partir de la
     * 2ᵉ, elle sera donc classée parking et deviendra silencieuse : c'est le trou de TRK-011,
     * désormais atteignable SANS décision humaine. Le fait reste **mesurable** (section
     * `gps_sans_fix` de l'audit quotidien, compteur `suppressed` du cron, fiche véhicule),
     * il n'est simplement plus **notifié** — ce qui est la demande explicite. Le garde-fou
     * qui reste à écrire est physique, pas temporel : ne silencier que si le contact est
     * COUPÉ (une voiture qui roule sans fix n'est pas dans un parking). Il exige de persister
     * l'ACC des trames `no_fix`, qui ne l'est pas aujourd'hui — cf. TRK-027.
     */
    // ⚠️ Tests de PRÉSENCE, pas d'égalité stricte. Prisma rend `reviewedAt: null` et
    // `label: 'UNKNOWN'` ; un objet partiel rend `undefined` pour les deux. Les quatre
    // valeurs disent la même chose — « personne n'a d'opinion sur cette zone ». Une égalité
    // stricte ferait passer les tests (mocks sans le champ) tout en se comportant autrement
    // en production : c'est la définition d'un test qui verrouille un bug.
    const jamaisQualifiee = !zone.label || zone.label === GpsDeadZoneLabel.UNKNOWN;
    if (!zone.reviewedAt && jamaisQualifiee && occurrences >= this.autoParkingOccurrences) {
      label = GpsDeadZoneLabel.UNDERGROUND_PARKING;
      status = GpsDeadZoneStatus.CONFIRMED_BENIGN;
      this.logger.log(
        `Zone ${zone.id} qualifiee AUTOMATIQUEMENT parking souterrain ` +
          `(${occurrences} pertes au meme endroit >= seuil ${this.autoParkingOccurrences}) — ` +
          'les pertes GPS y deviennent silencieuses.',
      );
    }

    return this.prisma.gpsDeadZone.update({
      where: { id: zone.id },
      data: { centroidLat, centroidLng, radiusM, occurrences, lastSeenAt: new Date(), status, label },
    });
  }

  /** Géocodage inverse best-effort du centroïde (ville/commune), une seule fois par zone. */
  private async ensurePlaceLabel(zone: GpsDeadZone): Promise<void> {
    if (zone.placeLabel) return;
    try {
      const label = await this.geocode.label(zone.centroidLat, zone.centroidLng);
      if (label) {
        await this.prisma.gpsDeadZone.update({ where: { id: zone.id }, data: { placeLabel: label } });
      }
    } catch {
      // Best-effort : un échec de géocodage ne doit jamais casser le flux d'enregistrement.
    }
  }

  /**
   * Zone morte correspondant à une position courante (dernière position figée d'un véhicule
   * GPS-perdu), ou null. Utilisé pour l'affichage « actuellement dans une zone connue ».
   */
  async matchZoneForPoint(vehicleId: string, lat: number, lng: number): Promise<GpsDeadZone | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const zones = await this.prisma.gpsDeadZone.findMany({ where: { vehicleId } });
    return this.nearestZone(zones, lat, lng);
  }

  /** Liste des zones mortes d'un véhicule (scopée par accès), triées par récurrence. */
  async listForVehicle(vehicleId: string, requestedBy: RequestedBy): Promise<GpsDeadZoneDto[]> {
    await this.assertVehicleAccess(vehicleId, requestedBy);
    const zones = await this.prisma.gpsDeadZone.findMany({
      where: { vehicleId },
      orderBy: [{ occurrences: 'desc' }, { lastSeenAt: 'desc' }],
      include: { events: { orderBy: { lostAt: 'desc' }, take: 5 } },
    });
    return zones.map((z) => this.toDto(z, z.events));
  }

  /**
   * Zones mortes pour la CARTE (flotte accessible) : parkings souterrains confirmés + zones
   * récurrentes/suspectes, avec la plaque du véhicule. Scopé au périmètre d'accès (anti-IDOR).
   * On exclut les zones encore en simple apprentissage (< seuil) pour ne pas polluer la carte.
   */
  async listForMap(requestedBy: RequestedBy, fleetId?: string): Promise<GpsDeadZoneMapDto[]> {
    const where: Prisma.GpsDeadZoneWhereInput = {};
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) return [];
      where.fleetId = requestedBy.fleetId;
    } else if (fleetId) {
      where.fleetId = fleetId;
    }
    if (requestedBy.accessibleVehicleIds && requestedBy.accessibleVehicleIds !== 'ALL') {
      where.vehicleId = {
        in: requestedBy.accessibleVehicleIds.length
          ? requestedBy.accessibleVehicleIds
          : ['00000000-0000-0000-0000-000000000000'],
      };
    }
    // Uniquement les zones « installées » : reconnues (récurrentes), confirmées ou suspectes.
    where.OR = [
      {
        status: {
          in: [GpsDeadZoneStatus.RECURRING, GpsDeadZoneStatus.CONFIRMED_BENIGN, GpsDeadZoneStatus.SUSPECT],
        },
      },
      { occurrences: { gte: this.minOccurrences } },
    ];
    const zones = await this.prisma.gpsDeadZone.findMany({
      where,
      include: { vehicle: { select: { plate: true } } },
      orderBy: [{ occurrences: 'desc' }],
      take: 500,
    });
    return zones.map((z) => ({
      id: z.id,
      vehicleId: z.vehicleId,
      plate: z.vehicle?.plate ?? null,
      centroidLat: z.centroidLat,
      centroidLng: z.centroidLng,
      radiusM: Math.round(z.radiusM),
      occurrences: z.occurrences,
      status: z.status,
      label: z.label,
      suggestedLabel: this.suggestedLabel(z),
      placeLabel: z.placeLabel,
    }));
  }

  /**
   * Revue opérateur d'une zone : qualifier (label) et/ou décider du statut.
   * - CONFIRMED_BENIGN → endroit normal (parking) : on cesse d'alerter sur les pertes ici.
   * - SUSPECT → à surveiller (brouilleur ?) : on continue d'alerter.
   * - RECURRING → revenir à l'état « reconnu » automatique (annule une confirmation).
   */
  async review(
    zoneId: string,
    requestedBy: RequestedBy,
    dto: { status?: GpsDeadZoneStatus; label?: GpsDeadZoneLabel; note?: string | null },
  ): Promise<GpsDeadZoneDto> {
    const zone = await this.prisma.gpsDeadZone.findUnique({ where: { id: zoneId } });
    if (!zone) throw new NotFoundException('Zone morte introuvable');
    await this.assertVehicleAccess(zone.vehicleId, requestedBy);

    const data: Prisma.GpsDeadZoneUpdateInput = { reviewedById: requestedBy.userId, reviewedAt: new Date() };
    if (dto.status) data.status = dto.status;
    if (dto.label) data.label = dto.label;
    if (dto.note !== undefined) {
      const trimmed = (dto.note ?? '').trim().slice(0, 500);
      data.note = trimmed.length ? trimmed : null;
    }
    const updated = await this.prisma.gpsDeadZone.update({
      where: { id: zoneId },
      data,
      include: { events: { orderBy: { lostAt: 'desc' }, take: 5 } },
    });
    return this.toDto(updated, updated.events);
  }

  /**
   * Scoping véhicule (anti-IDOR) — mêmes règles que VehiclesService.findOne : filtre tenant
   * intégré + périmètre granulaire ; 404 (pas 403) pour ne pas révéler l'existence cross-fleet.
   */
  private async assertVehicleAccess(vehicleId: string, requestedBy: RequestedBy): Promise<void> {
    const where: Prisma.VehicleWhereInput = { id: vehicleId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Véhicule introuvable');
      where.fleetId = requestedBy.fleetId;
    }
    if (
      requestedBy.accessibleVehicleIds &&
      requestedBy.accessibleVehicleIds !== 'ALL' &&
      !requestedBy.accessibleVehicleIds.includes(vehicleId)
    ) {
      throw new NotFoundException('Véhicule introuvable');
    }
    const vehicle = await this.prisma.vehicle.findFirst({ where, select: { id: true } });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');
  }

  /**
   * Suggestion (non contraignante) de nature quand la zone est récurrente et non encore qualifiée.
   *
   * Depuis le 17/08, une zone JAMAIS revue est qualifiée automatiquement dès
   * `autoParkingOccurrences` — la suggestion ne concerne donc plus que les zones qu'un
   * opérateur a revues en laissant le libellé à `UNKNOWN`. Même seuil, pour que l'écran ne
   * suggère jamais autre chose que ce que l'automatisme aurait posé.
   */
  private suggestedLabel(zone: GpsDeadZone): GpsDeadZoneLabel | null {
    if (zone.label !== GpsDeadZoneLabel.UNKNOWN) return null;
    return zone.occurrences >= this.autoParkingOccurrences
      ? GpsDeadZoneLabel.UNDERGROUND_PARKING
      : null;
  }

  private toDto(zone: GpsDeadZone, events: GpsLossEvent[] = []): GpsDeadZoneDto {
    return {
      id: zone.id,
      vehicleId: zone.vehicleId,
      fleetId: zone.fleetId,
      centroidLat: zone.centroidLat,
      centroidLng: zone.centroidLng,
      radiusM: Math.round(zone.radiusM),
      occurrences: zone.occurrences,
      firstSeenAt: zone.firstSeenAt.toISOString(),
      lastSeenAt: zone.lastSeenAt.toISOString(),
      status: zone.status,
      label: zone.label,
      suggestedLabel: this.suggestedLabel(zone),
      placeLabel: zone.placeLabel,
      note: zone.note,
      reviewedAt: zone.reviewedAt ? zone.reviewedAt.toISOString() : null,
      // TRK-028 — calculée sur les épisodes fournis. `listForVehicle` en passe assez pour
      // que la médiane ait un sens ; ailleurs (carte), la valeur reste nulle et l'écran
      // n'annonce rien plutôt que d'annoncer une durée tirée d'un seul épisode.
      typicalOutageMinutes: this.dureeTypiqueMinutes(events),
      recentEvents: events.map((e) => ({
        lat: e.lat,
        lng: e.lng,
        lostAt: e.lostAt.toISOString(),
        detectedAt: e.detectedAt.toISOString(),
        recoveredAt: e.recoveredAt ? e.recoveredAt.toISOString() : null,
      })),
    };
  }
}

export interface RequestedBy {
  userId: string;
  role: UserRole | string;
  fleetId: string | null;
  accessibleVehicleIds?: string[] | 'ALL';
}

export interface GpsDeadZoneEventDto {
  lat: number;
  lng: number;
  lostAt: string;
  detectedAt: string;
  /** TRK-028 — retour du signal, ou `null` si l'épisode est encore ouvert. */
  recoveredAt: string | null;
}

export interface GpsDeadZoneDto {
  id: string;
  vehicleId: string;
  fleetId: string;
  centroidLat: number;
  centroidLng: number;
  radiusM: number;
  occurrences: number;
  firstSeenAt: string;
  lastSeenAt: string;
  status: GpsDeadZoneStatus;
  label: GpsDeadZoneLabel;
  /** Nature suggérée (heuristique) tant que l'opérateur n'a pas qualifié la zone. */
  suggestedLabel: GpsDeadZoneLabel | null;
  placeLabel: string | null;
  note: string | null;
  reviewedAt: string | null;
  /**
   * TRK-028 — durée MÉDIANE d'une absence sur cette zone, en minutes. `null` tant
   * qu'aucun épisode n'a été vu se refermer : on ne devine pas une durée.
   */
  typicalOutageMinutes: number | null;
  recentEvents: GpsDeadZoneEventDto[];
}

/** Zone morte allégée pour l'affichage carte (marqueur parking souterrain), avec la plaque. */
export interface GpsDeadZoneMapDto {
  id: string;
  vehicleId: string;
  plate: string | null;
  centroidLat: number;
  centroidLng: number;
  radiusM: number;
  occurrences: number;
  status: GpsDeadZoneStatus;
  label: GpsDeadZoneLabel;
  suggestedLabel: GpsDeadZoneLabel | null;
  placeLabel: string | null;
}
