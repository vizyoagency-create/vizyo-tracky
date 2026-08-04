import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GpsDeadZoneStatus } from '@prisma/client';
import { TRACKER_ONLINE_THRESHOLD_MS } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from '../alerts/alerts.service';
import { GpsDeadZonesService } from '../gps-dead-zones/gps-dead-zones.service';
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
  /**
   * Plafond de SILENCE d'une zone confirmée bénigne (env `GPS_DEADZONE_MAX_SILENCE_H`,
   * défaut 24 h). Au-delà, on alerte malgré la zone : voir TRK-011.
   *
   * Calibrage : un stationnement de nuit ordinaire dure ~12 h et doit rester silencieux ;
   * 24 h laisse passer un week-end court sans crier, tout en bornant une antenne morte.
   */
  private readonly benignMaxSilenceMs: number;
  private readonly benignMaxSilenceLabel: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly deadZones: GpsDeadZonesService,
    private readonly errorLogger: ErrorLogger,
  ) {
    const min = Number(process.env.GPS_LOST_ALERT_MIN);
    this.alertStaleMs = (Number.isFinite(min) && min > 0 ? min : 120) * 60_000;

    const maxH = Number(process.env.GPS_DEADZONE_MAX_SILENCE_H);
    const hours = Number.isFinite(maxH) && maxH > 0 ? maxH : 24;
    this.benignMaxSilenceMs = hours * 3_600_000;
    this.benignMaxSilenceLabel = hours >= 24 && hours % 24 === 0 ? `${hours / 24} j` : `${hours} h`;
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
      let suppressed = 0;
      for (const t of suspects) {
        if (!t.vehicle) continue;
        try {
          const agoLabel = this.ageLabel(t.lastPositionAt, now);

          // Zones mortes GPS : enregistrer la perte (idempotent par épisode via `lostAt`) et
          // récupérer le contexte de récurrence. Nécessite une dernière position (point d'ancrage) —
          // un boîtier jamais localisé ne peut pas être rattaché à une zone.
          const hasAnchor = t.lastLat != null && t.lastLng != null && t.lastPositionAt != null;
          const rec = hasAnchor
            ? await this.deadZones
                .recordLoss({
                  vehicleId: t.vehicle.id,
                  fleetId: t.vehicle.fleetId,
                  trackerId: t.id,
                  lat: t.lastLat as number,
                  lng: t.lastLng as number,
                  lostAt: t.lastPositionAt as Date,
                })
                .catch((err) => {
                  // Le clustering des zones mortes cesse d'apprendre si recordLoss échoue
                  // en boucle (drift enum, contrainte) → visible au centre d'alerte.
                  this.errorLogger.recordBackground(err instanceof Error ? err : new Error(String(err)), 'gps-dead-zones', {
                    imei: t.imei, vehicleId: t.vehicle?.id, phase: 'recordLoss',
                  });
                  return null;
                })
            : null;
          const zone = rec?.zone ?? null;

          // Zone confirmée « normale » par un opérateur (parking souterrain habituel) → on N'ALERTE
          // PLUS : c'est le cœur de la feature (ne plus se déplacer / être re-signalé à chaque fois).
          // La zone reste visible sur la fiche véhicule et la carte l'explique calmement.
          //
          // ⚠️ MAIS CE SILENCE EST BORNÉ (incident TRK-011, 2026-08-04). La confirmation de
          // l'opérateur porte sur un LIEU (« ce parking est normal »), pas sur une DURÉE. Sans
          // borne, une antenne morte sur un véhicule garé dans son parking habituel devenait
          // strictement indistinguable d'un stationnement ordinaire — et n'était JAMAIS signalée :
          // ni alerte flotte, ni ligne au centre d'alerte. Constaté sur FS-253-HR, vivant et sans
          // position depuis 12 h, avec zéro trace nulle part. Le périmètre s'élargissait en plus
          // d'un véhicule à chaque confirmation d'opérateur.
          //
          // Au-delà du plafond, on alerte MALGRÉ la zone — et le message dit pourquoi il parle
          // quand même, sinon l'opérateur irait reconfirmer une zone déjà confirmée.
          const benignSilenceExceeded =
            zone?.status === GpsDeadZoneStatus.CONFIRMED_BENIGN &&
            (t.lastPositionAt === null || now - t.lastPositionAt.getTime() >= this.benignMaxSilenceMs);

          if (zone && zone.status === GpsDeadZoneStatus.CONFIRMED_BENIGN && !benignSilenceExceeded) {
            suppressed++;
            continue;
          }

          const recurrence = zone
            ? {
                count: zone.occurrences,
                recognized:
                  zone.status === GpsDeadZoneStatus.RECURRING ||
                  zone.occurrences >= this.deadZones.minOccurrences,
                suspect: zone.status === GpsDeadZoneStatus.SUSPECT,
              }
            : undefined;

          const created = await this.alerts.createGpsLostAlert(
            { id: t.id, imei: t.imei, lastLat: t.lastLat, lastLng: t.lastLng, lastPositionAt: t.lastPositionAt },
            t.vehicle,
            agoLabel,
            undefined,
            recurrence,
            benignSilenceExceeded ? { thresholdLabel: this.benignMaxSilenceLabel } : undefined,
          );
          // Nouvelle alerte (pas un doublon) → on la remonte AUSSI au centre d'alertes admin
          // (ErrorLog) : c'est le canal que le super-admin regarde. Un seul enregistrement par
          // épisode (la dédup de createGpsLostAlert renvoie null si déjà ouverte) → pas de spam.
          // On N'INONDE PAS le centre admin pour une zone récurrente NON suspecte (parking habituel) :
          // l'alerte fleet-admin suffit (avec le « confirmez la zone »).
          // ⚠️ `benignSilenceExceeded` FORCE la remontée : sans lui, une zone confirmée a
          // `recognized: true` (elle dépasse le seuil d'occurrences), donc la condition
          // ci-dessous vaudrait `false` et le dépassement n'aurait produit AUCUNE ligne —
          // exactement le trou qu'on vient de boucher.
          const shouldErrorLog =
            benignSilenceExceeded || !recurrence?.recognized || recurrence?.suspect === true;
          if (created && shouldErrorLog) {
            raised++;
            const reason = benignSilenceExceeded
              ? `GPS perdu ANORMALEMENT LONG : ${t.vehicle.plate} (${t.imei}) — sans position depuis ${agoLabel}, ` +
                `à un endroit pourtant confirmé normal (${zone?.occurrences ?? '?'} épisodes). ` +
                `La zone explique une perte courte, pas au-delà de ${this.benignMaxSilenceLabel} : antenne à vérifier.`
              : recurrence?.suspect
                ? `GPS perdu (zone SUSPECTE, ${recurrence.count}e fois) : ${t.vehicle.plate} (${t.imei}) — brouilleur possible, à surveiller.`
                : `GPS perdu : ${t.vehicle.plate} (${t.imei}) — boîtier vivant mais sans position GPS depuis ${agoLabel}. Antenne à vérifier.`;
            await this.errorLogger
              .record(new Error(reason), 'gps-integrity', {
                imei: t.imei,
                vehicleId: t.vehicle.id,
                fleetId: t.vehicle.fleetId,
                lastPositionAt: t.lastPositionAt?.toISOString() ?? null,
                deadZoneId: zone?.id ?? null,
                deadZoneOccurrences: zone?.occurrences ?? null,
                benignSilenceExceeded: benignSilenceExceeded || undefined,
              })
              .catch(() => undefined);
          } else if (created) {
            // Alerte fleet-admin créée mais volontairement non remontée au centre admin (zone récurrente
            // habituelle) — on compte quand même pour le log de synthèse.
            raised++;
          }
        } catch (err) {
          this.errorLogger.recordBackground(err instanceof Error ? err : new Error(String(err)), 'gps-integrity', {
            imei: t.imei, phase: 'per-tracker',
          });
        }
      }
      if (suspects.length) {
        this.logger.log(
          `GPS-integrity: ${suspects.length} boîtier(s) vivant(s) sans position GPS ` +
            `(${raised} nouvelle(s) alerte(s), ${suppressed} en zone confirmée).`,
        );
      }
    } catch (err) {
      // Le cron ne doit jamais throw — mais un tick qui échoue en boucle = détecteur
      // « GPS perdu » entièrement mort : ça doit se voir au centre d'alerte (dédup ErrorLogger).
      this.errorLogger.recordBackground(err instanceof Error ? err : new Error(String(err)), 'gps-integrity', {
        phase: 'tick',
      });
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
