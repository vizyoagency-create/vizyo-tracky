import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SEUIL_BATTERIE_COUPURE } from './alarme-alimentation';
import { AlertsService } from './alerts.service';

/**
 * TRK-040 — LE RÉEXAMEN DIFFÉRÉ DES ALARMES D'ALIMENTATION « À BATTERIE PLEINE ».
 *
 * ══ Pourquoi ce cron existe (DZ-034-CA, 2026-08-21) ═══════════════════════════════════
 *
 * Une alarme d'alimentation à batterie pleine est classée « contact coupé » — et c'est le
 * bon défaut par défaut : 202 fausses CRITIQUES en 24 h avant ce choix. Mais à l'instant
 * zéro d'une VRAIE coupure, la batterie de secours est pleine PAR DÉFINITION : les deux
 * cas sont indiscernables au moment où on les sépare. Sur DZ-034-CA, le verdict « pas en
 * péril » écrit à 06:48 a survécu à la mort du boîtier (12:43) — 6 h 12 entre l'annonce
 * et la première alerte.
 *
 * Le classement bénin n'est donc plus un verdict : c'est un SURSIS. `alerts.service`
 * ouvre un soupçon (`powerLossSuspectAt` = heure de la PREMIÈRE trame de l'épisode,
 * `powerLossSuspectBattery` = batterie du moment), et ce cron relit LA PENTE : si la
 * batterie est depuis passée sous le seuil, la coupure est confirmée — avec l'heure du
 * début d'épisode dans le message, pas celle de la découverte.
 *
 * ══ Trois décisions de conception, chacune payée ══════════════════════════════════════
 *
 *  - LE RÉEXAMEN EST RÉCURRENT À PARTIR DE T+30, pas unique À T+30 : à 06:53, la salve
 *    de DZ-034-CA montrait ENCORE 100 % ; la baisse (96 → 83) n'est apparue qu'à 07:00.
 *    Un réexamen unique aurait raté le cas mesuré. L'épisode se referme par le contact
 *    remis (ingestion), par l'alerte confirmée, ou pas du tout — et c'est voulu.
 *  - LE SEUIL EST CELUI DU PROPRIÉTAIRE (`SEUIL_BATTERIE_COUPURE`), réutilisé tel quel :
 *    pas de deuxième seuil, pas de « delta de N points » qui serait un seuil déguisé.
 *    On ne baisse pas le seuil (interdiction de la fiche) — on attend qu'il parle.
 *  - LA PENTE EXIGE UNE LECTURE POSTÉRIEURE AU SOUPÇON (`lastBatteryAt > suspectAt`) :
 *    juger sur une lecture antérieure serait inventer une pente avec un point.
 */
@Injectable()
export class PowerCutRecheckService {
  private readonly logger = new Logger(PowerCutRecheckService.name);
  private running = false;

  /** T+30 min : avant ça, une batterie pleine ne dit rien — la pente n'existe pas encore. */
  private static readonly REEXAMEN_MS = 30 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  /**
   * ⚠️ RIEN ENTRE CE DÉCORATEUR ET SA MÉTHODE (le lien décorateur → cible se perd à la
   * compilation — déjà payé dans ce dépôt). Toutes les 5 min à la seconde :45 —
   * gps-integrity occupe déjà :15, et le créneau doit rester lisible dans le catalogue
   * des traitements de fond.
   */
  @Cron('45 */5 * * * *')
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.reexaminer();
    } catch (e) {
      this.errorLogger.recordBackground(
        e instanceof Error ? e : new Error(String(e)),
        'power-cut-recheck',
      );
    } finally {
      this.running = false;
    }
  }

  private async reexaminer(): Promise<void> {
    const suspects = await this.prisma.tracker.findMany({
      where: {
        powerLossSuspectAt: {
          not: null,
          lte: new Date(Date.now() - PowerCutRecheckService.REEXAMEN_MS),
        },
      },
      include: { vehicle: true },
    });

    for (const t of suspects) {
      // Filet : contact revenu mais soupçon pas encore refermé par l'ingestion (un
      // boîtier muet depuis son kt n'existe pas en pratique — le filet ne coûte rien).
      if (t.lastKnownIgnition === true) {
        await this.refermer(t.id);
        continue;
      }

      const penteConfirmee =
        t.lastBatteryPercent != null &&
        t.lastBatteryAt != null &&
        t.powerLossSuspectAt != null &&
        t.lastBatteryAt > t.powerLossSuspectAt &&
        t.lastBatteryPercent < SEUIL_BATTERIE_COUPURE;

      if (!penteConfirmee || !t.vehicle) {
        // Batterie encore pleine, lecture antérieure au soupçon, ou boîtier sans
        // véhicule : on NE FAIT RIEN. Le soupçon reste ouvert, revu au tick suivant —
        // c'est le « récurrent à partir de T+30 » du commentaire d'en-tête.
        continue;
      }

      const alerte = await this.alerts.createPowerCutConfirmedAlert(
        t,
        t.vehicle,
        {
          suspectAt: t.powerLossSuspectAt!,
          suspectBattery: t.powerLossSuspectBattery,
          currentBattery: t.lastBatteryPercent!,
        },
      );

      // Correctif 3 sur le chemin différé : la note « pas en péril » est remplacée par
      // la vérité du moment, et le soupçon se referme — l'épisode est porté par l'alerte.
      await this.prisma.tracker
        .update({
          where: { id: t.id },
          data: {
            lastPowerNotice:
              `Coupure d'alimentation CONFIRMÉE au réexamen : batterie passée de ` +
              `${t.powerLossSuspectBattery ?? '?'} % à ${t.lastBatteryPercent} % depuis la ` +
              `première trame de l'épisode. L'examen initial avait classé « contact coupé ».`,
            lastPowerNoticeAt: new Date(),
            powerLossSuspectAt: null,
            powerLossSuspectBattery: null,
          },
        })
        .catch(() => undefined);

      if (alerte) {
        this.logger.warn(
          `[power-cut-recheck] coupure confirmée par la pente pour ${t.vehicle.plate} ` +
            `(${t.powerLossSuspectBattery ?? '?'} % → ${t.lastBatteryPercent} %).`,
        );
      }
    }
  }

  private async refermer(trackerId: string): Promise<void> {
    await this.prisma.tracker
      .update({
        where: { id: trackerId },
        data: { powerLossSuspectAt: null, powerLossSuspectBattery: null },
      })
      .catch(() => undefined);
  }
}
