import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { PositionUpdateEvent } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

/**
 * V1.7 — Pour les trackers `accConnected = false`, l'ignition est inferee depuis
 * la vitesse GPS dans `PositionsService.ingest`. Quand le vehicule s'arrete
 * (vitesse <= 3 km/h), on garde l'etat precedent (`lastKnownIgnition = true`)
 * pour ne pas flicker pendant un feu rouge ou un arret bref.
 *
 * Ce cron complete cette logique : si un tracker en mode degrade reste a
 * `lastKnownIgnition = true` SANS recevoir de nouvelle trame valide depuis
 * plus de 5 minutes, on bascule l'ignition a `false` (vehicule probablement
 * gare moteur eteint) et on broadcast l'event WS pour rafraichir l'UI.
 *
 * Sans ce cron, le marker resterait vert indefiniment apres l'arret final.
 */
const INFERRED_TIMEOUT_MS = 5 * 60 * 1000;

@Injectable()
export class IgnitionInferredCleanupService {
  private readonly logger = new Logger(IgnitionInferredCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: RealtimeGateway,
  ) {}

  @Interval(60_000)
  async tick(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - INFERRED_TIMEOUT_MS);

      // Trackers a basculer : accConnected=false + ignition courante ON +
      // derniere trame valide trop ancienne (ou jamais recue).
      const stale = await this.prisma.tracker.findMany({
        where: {
          accConnected: false,
          lastKnownIgnition: true,
          OR: [
            { lastValidFrameAt: { lt: cutoff } },
            { lastValidFrameAt: null },
          ],
        },
        include: { vehicle: true },
      });

      if (stale.length === 0) return;

      for (const t of stale) {
        try {
          await this.prisma.tracker.update({
            where: { id: t.id },
            data: {
              lastKnownIgnition: false,
              lastIgnition: false,
              lastIgnitionChangeAt: new Date(),
            },
          });

          // Broadcast WS pour rafraichir le marker / popup.
          // On utilise la derniere position connue ; si aucune, on skip
          // le broadcast (pas grand-chose a afficher cote client).
          if (
            t.vehicle &&
            t.lastLat != null &&
            t.lastLng != null &&
            t.lastPositionAt != null
          ) {
            const event: PositionUpdateEvent = {
              trackerId: t.id,
              vehicleId: t.vehicle.id,
              fleetId: t.vehicle.fleetId,
              lat: t.lastLat,
              lng: t.lastLng,
              speedKmh: t.lastSpeedKmh ?? 0,
              heading: t.lastHeading ?? 0,
              timestamp: t.lastPositionAt.toISOString(),
              ignition: false,
              valid: t.lastValid ?? true,
            };
            this.gateway.broadcastPosition(t.vehicle.fleetId, event);
          }

          this.logger.log(
            `[ACC degraded] ${t.imei} : ignition timeout ${INFERRED_TIMEOUT_MS / 1000}s, set to false`,
          );
        } catch (err) {
          // Une erreur sur un tracker ne doit pas faire planter la boucle.
          this.logger.error(
            `Failed to clean up inferred ignition for tracker ${t.imei}: ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
      }
    } catch (err) {
      // Le cron ne doit jamais throw — on log et on attend le prochain tick.
      this.logger.error(
        `IgnitionInferredCleanupService tick failed: ` +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }
}
