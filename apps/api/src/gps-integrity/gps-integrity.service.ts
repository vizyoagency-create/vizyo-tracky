import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TRACKER_ONLINE_THRESHOLD_MS } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { ErrorLogger } from '../observability/error-logger.service';

/**
 * Incident FS-253 — détecteur « GPS perdu ».
 *
 * Contexte : un boîtier Coban peut rester parfaitement JOIGNABLE (réseau GPRS/SMS OK,
 * `lastSeenAt` frais) tout en n'ayant PLUS de lock GPS — il envoie alors uniquement des
 * trames `no_fix` (LBS, sans coordonnées). Symptômes observés sur FS-253 : la dernière
 * position (donc la vitesse/contact affichés) reste FIGÉE pendant des heures, la coupe
 * horaire ne peut pas être confirmée, et — surtout — RIEN ne le signalait : un GPS perdu
 * ne déclenche ni l'état OFFLINE (le boîtier est vivant) ni `fixCommandFailing`, donc il
 * était totalement absent du centre d'alertes.
 *
 * Ce cron comble ce trou. Il repère les boîtiers VIVANTS qui émettent des `no_fix`
 * RÉCENTS (ils TENTENT de reporter mais sans lock) alors que leur dernière position GPS
 * est PÉRIMÉE, et lève une alerte véhicule `GPS_LOST` (visible fleet-admin) + une entrée
 * au centre d'alertes admin (ErrorLog). Le `no_fix` récent est le discriminant qui évite
 * de faux-positiver une voiture simplement garée : un boîtier garé SAIN est MUET (heartbeat
 * seulement), il n'émet pas de `no_fix`.
 */
@Injectable()
export class GpsIntegrityService {
  private readonly logger = new Logger(GpsIntegrityService.name);
  /** Anti-overlap : un passage lent ne doit pas se chevaucher avec le suivant. */
  private running = false;
  /** Âge de position au-delà duquel on ALERTE (réglable via env, défaut 2 h). */
  private readonly alertStaleMs: number;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly errorLogger: ErrorLogger,
  ) {
    const min = Number(process.env.GPS_LOST_ALERT_MIN);
    this.alertStaleMs = (Number.isFinite(min) && min > 0 ? min : 120) * 60_000;
  }

  // Toutes les 5 min, décalé de 15 s pour ne pas percuter les crons alignés sur :00.
  @Cron('15 */5 * * * *')
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = Date.now();
      const aliveSince = new Date(now - TRACKER_ONLINE_THRESHOLD_MS); // 15 min
      const posStaleBefore = new Date(now - this.alertStaleMs); // 2 h par défaut

      // Boîtiers vivants + no_fix récents + position périmée (ou jamais localisés alors
      // qu'ils émettent activement des no_fix depuis un moment).
      const suspects = await this.prisma.tracker.findMany({
        where: {
          vehicleId: { not: null },
          lastSeenAt: { gte: aliveSince },
          lastNoFixAt: { gte: aliveSince },
          OR: [{ lastPositionAt: null }, { lastPositionAt: { lt: posStaleBefore } }],
        },
        select: {
          id: true,
          imei: true,
          lastLat: true,
          lastLng: true,
          lastPositionAt: true,
          vehicle: { select: { id: true, plate: true, fleetId: true } },
        },
      });

      let raised = 0;
      for (const t of suspects) {
        if (!t.vehicle) continue;
        try {
          const agoLabel = this.ageLabel(t.lastPositionAt, now);
          const created = await this.alerts.createGpsLostAlert(
            { id: t.id, imei: t.imei, lastLat: t.lastLat, lastLng: t.lastLng, lastPositionAt: t.lastPositionAt },
            t.vehicle,
            agoLabel,
          );
          // Nouvelle alerte (pas un doublon) → on la remonte AUSSI au centre d'alertes admin
          // (ErrorLog) : c'est le canal que le super-admin regarde. Un seul enregistrement par
          // épisode (la dédup de createGpsLostAlert renvoie null si déjà ouverte) → pas de spam.
          if (created) {
            raised++;
            await this.errorLogger
              .record(
                new Error(
                  `GPS perdu : ${t.vehicle.plate} (${t.imei}) — boîtier vivant mais sans position GPS depuis ${agoLabel}. Antenne à vérifier.`,
                ),
                'gps-integrity',
                {
                  imei: t.imei,
                  vehicleId: t.vehicle.id,
                  fleetId: t.vehicle.fleetId,
                  lastPositionAt: t.lastPositionAt?.toISOString() ?? null,
                },
              )
              .catch(() => undefined);
          }
        } catch (err) {
          this.logger.error(
            `GPS-integrity: échec sur ${t.imei}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      if (suspects.length) {
        this.logger.log(
          `GPS-integrity: ${suspects.length} boîtier(s) vivant(s) sans position GPS (${raised} nouvelle(s) alerte(s)).`,
        );
      }
    } catch (err) {
      // Le cron ne doit jamais throw — on log et on attend le prochain tick.
      this.logger.error(
        `GpsIntegrityService tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private ageLabel(lastPositionAt: Date | null, now: number): string {
    if (!lastPositionAt) return 'toujours (jamais localisé)';
    const min = Math.floor((now - lastPositionAt.getTime()) / 60_000);
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60);
    if (h < 48) return `${h} h`;
    return `${Math.floor(h / 24)} j`;
  }
}
