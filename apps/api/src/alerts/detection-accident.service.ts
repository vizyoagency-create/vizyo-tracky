import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertSeverity, AlertType, UserRole } from '@prisma/client';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { soupconsAccident, SILENCE_MIN_MS, type EtatBoitier } from './detection-accident.shared';

/**
 * Veille ACCIDENT — le boîtier roulait, puis s'est tu.
 *
 * ── Pourquoi un balayage périodique, et pas une réaction à la trame ──────────────────
 *
 * Toutes les autres alertes naissent d'une trame reçue. Celle-ci naît d'une trame qui
 * N'ARRIVE PAS. Une absence ne se remarque qu'en la cherchant : il n'existe aucun événement
 * sur lequel se brancher. D'où le balayage.
 *
 * ── Pourquoi toutes les 15 minutes, alors que le seuil est de 2 heures ───────────────
 *
 * Le seuil décide de ce qui est anormal ; la période décide du retard à l'annonce. Un
 * balayage horaire ajouterait jusqu'à une heure aux deux heures de silence. Quinze minutes
 * coûtent une requête par quart d'heure et bornent le retard au même quart d'heure.
 *
 * ── Restriction aux super-administrateurs, et ce qu'elle n'est pas ───────────────────
 *
 * L'alerte est CRÉÉE, visible et consultable par qui a le droit de la voir. Seule la
 * NOTIFICATION est restreinte. La différence est celle qui a déjà été tranchée pour les
 * coupures d'alimentation : supprimer l'alerte fabriquerait une cécité à la place d'un
 * bruit. Ici la raison est plus forte encore — cette règle n'a JAMAIS été validée sur un
 * vrai accident, faute d'en avoir un dans les données conservées. On sait qu'elle ne crie
 * pas à tort ; on ignore encore si elle crie à temps. Réveiller un client sur cette base
 * serait prématuré.
 */
@Injectable()
export class DetectionAccidentService {
  private readonly logger = new Logger(DetectionAccidentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async balayer(): Promise<void> {
    try {
      const soupcons = await this.examiner();
      for (const s of soupcons) {
        await this.poserAlerte(s);
      }
      if (soupcons.length > 0) {
        this.logger.warn(`[ACCIDENT] ${soupcons.length} boîtier(s) muet(s) après avoir roulé`);
      }
    } catch (err) {
      // La veille ne doit jamais faire tomber le processus qu'elle surveille.
      this.logger.error(`Veille accident interrompue : ${err instanceof Error ? err.message : err}`);
    }
  }

  /** Lit l'état du parc et applique la règle pure. Séparé du cron pour être testable. */
  async examiner(maintenant = new Date()) {
    const maintenantMs = maintenant.getTime();
    // On ne considère QUE les boîtiers dont le silence a déjà atteint le seuil : inutile de
    // rapatrier le parc entier pour n'en garder qu'une poignée.
    const limite = new Date(maintenantMs - SILENCE_MIN_MS);
    const trackers = await this.prisma.tracker.findMany({
      where: {
        lastSeenAt: { not: null, lt: limite },
        vehicleId: { not: null },
      },
      select: {
        id: true,
        lastSeenAt: true,
        lastLat: true,
        lastLng: true,
        vehicle: { select: { id: true, plate: true, fleetId: true } },
      },
    });
    if (trackers.length === 0) return [];

    // La vitesse vient du dernier POINT, pas du tracker : c'est la seule source qui dise à
    // quelle allure il roulait quand il s'est tu.
    const etats: EtatBoitier[] = [];
    for (const t of trackers) {
      const dernier = await this.prisma.position.findFirst({
        where: { trackerId: t.id, valid: true },
        orderBy: { timestamp: 'desc' },
        select: { speedKmh: true },
      });
      // Une alerte déjà posée depuis le début du silence : on ne répète pas. Sans cette
      // garde, un boîtier définitivement mort produirait une alerte CRITIQUE toutes les
      // demi-heures, indéfiniment — le déluge qu'on vient de corriger ailleurs.
      const dejaAlerte =
        (await this.prisma.alert.count({
          where: {
            trackerId: t.id,
            type: AlertType.ACCIDENT,
            createdAt: { gte: t.lastSeenAt! },
          },
        })) > 0;
      etats.push({
        trackerId: t.id,
        plaque: t.vehicle?.plate ?? null,
        derniereTrameA: t.lastSeenAt,
        derniereVitesseKmh: dernier?.speedKmh ?? null,
        lat: t.lastLat,
        lng: t.lastLng,
        dejaAlerte,
      });
    }
    const soupcons = soupconsAccident(etats, maintenantMs);
    // On rattache la société et le véhicule, nécessaires à la création de l'alerte.
    return soupcons
      .map((s) => {
        const t = trackers.find((x) => x.id === s.trackerId);
        return t?.vehicle ? { ...s, vehicleId: t.vehicle.id, fleetId: t.vehicle.fleetId } : null;
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  private async poserAlerte(s: {
    trackerId: string;
    vehicleId: string;
    fleetId: string;
    plaque: string | null;
    derniereVitesseKmh: number;
    silenceMs: number;
    lat: number | null;
    lng: number | null;
    constat: string;
  }): Promise<void> {
    const alert = await this.prisma.alert.create({
      data: {
        fleetId: s.fleetId,
        vehicleId: s.vehicleId,
        trackerId: s.trackerId,
        type: AlertType.ACCIDENT,
        severity: AlertSeverity.CRITICAL,
        // Le titre annonce ce qu'on a VU. « Accident détecté » serait une promesse que la
        // règle ne tient pas : elle observe un silence après une vitesse, pas un choc.
        title: `🚨 Boîtier muet après avoir roulé — ${s.plaque ?? 'véhicule'}`,
        message: s.constat,
        payload: {
          detection: 'telemetrie',
          derniereVitesseKmh: s.derniereVitesseKmh,
          silenceH: Number((s.silenceMs / 3_600_000).toFixed(1)),
        } as never,
        latitude: s.lat,
        longitude: s.lng,
      },
      include: { vehicle: true, tracker: true },
    });

    this.gateway.broadcastAlert(alert);

    // ⚠️ RESTRICTION VOLONTAIRE ET PROVISOIRE. Cf. l'en-tête de cette classe : l'alerte
    // existe pour tout le monde, la notification ne part qu'aux super-administrateurs, le
    // temps de vérifier sur le terrain que la règle dit vrai. La liste est résolue ici et
    // passée explicitement — le dispatcher applique ensuite son chemin normal, sans
    // exception : permissions, périmètre véhicule, préférences, plafond, journal.
    const superAdmins = await this.prisma.user.findMany({
      where: { role: UserRole.SUPER_ADMIN, isActive: true },
      select: { id: true },
    });
    this.dispatch
      .dispatchAlert(alert, { restreindreAuxUtilisateurs: superAdmins.map((u) => u.id) })
      .catch((err) => {
        this.logger.warn(
          `Notification accident ${alert.id} non partie : ${err instanceof Error ? err.message : err}`,
        );
      });
  }
}
