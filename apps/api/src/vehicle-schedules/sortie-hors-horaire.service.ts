import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { CommandStatus, EngineAction } from '@prisma/client';
import { AlertsService } from '../alerts/alerts.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  SORTIE_HORS_CHAMP_EVENT,
  type SortieHorsChampEvent,
} from '../positions/sortie-hors-champ.event';
import { evaluateSchedule } from './schedule-evaluator';

/**
 * ══ TRK-046 — LE FILET DE SÉCURITÉ : « véhicule hors champ roule hors horaire autorisé » ═══
 *
 * La présomption de stationnement (un véhicule hors champ GPS dans un parking validé est
 * considéré stationné, la coupe programmée ne lui est plus martelée) n'est acceptable que si
 * la SORTIE ne passe jamais inaperçue. Ce service écoute la réapparition émise par
 * l'ingestion et tranche la seule question qui reste : cette réapparition en mouvement
 * tombe-t-elle pendant la plage où le planning veut le véhicule immobilisé ?
 *
 * Quatre abstentions, toutes voulues :
 *  - pas de planning actif → la sortie n'enfreint rien ;
 *  - override manuel en cours → un humain a explicitement autorisé (coupe/reprise manuelle) ;
 *  - dans la plage autorisée → trajet normal ;
 *  - un RESTORE créé PENDANT l'obscurité → quelqu'un a délibérément rendu le véhicule
 *    utilisable (déverrouillage conducteur, reprise manuelle) : l'alerter serait crier sur
 *    une autorisation.
 *
 * ⚠️ L'heure évaluée est CELLE DE LA TRAME (`evt.at`), pas celle du traitement : l'évaluateur
 * de planning est pur et prend une base — leçon TRK-044, jamais deux horloges pour une règle.
 */
@Injectable()
export class SortieHorsHoraireService {
  private readonly logger = new Logger(SortieHorsHoraireService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
  ) {}

  @OnEvent(SORTIE_HORS_CHAMP_EVENT)
  async onSortieHorsChamp(evt: SortieHorsChampEvent): Promise<void> {
    try {
      const at = new Date(evt.at);

      const schedule = await this.prisma.vehicleSchedule.findFirst({
        where: { vehicleId: evt.vehicleId, enabled: true },
      });
      if (!schedule) return;
      if (schedule.overrideUntil && at < schedule.overrideUntil) return;

      const evaluation = evaluateSchedule(schedule, at);
      if (evaluation.state !== 'OUT_OF_WINDOW') return;

      // Un RESTORE né pendant l'obscurité = autorisation explicite de rouler (déverrouillage
      // conducteur, reprise manuelle). Les refus (REJECTED_SPEED/FAILED) ne comptent pas :
      // une commande qui n'a pas abouti n'a rien autorisé.
      const restoreAutorise = await this.prisma.engineControlCommand.findFirst({
        where: {
          trackerId: evt.trackerId,
          action: EngineAction.RESTORE,
          createdAt: { gte: new Date(evt.sombreDepuis) },
          status: { notIn: [CommandStatus.REJECTED_SPEED, CommandStatus.FAILED] },
        },
        select: { id: true },
      });
      if (restoreAutorise) return;

      await this.alerts.createSortieHorsHoraireAlert(
        { id: evt.trackerId, imei: evt.imei },
        { id: evt.vehicleId, plate: evt.plate, fleetId: evt.fleetId },
        {
          sombreMin: Math.round(evt.sombreMs / 60000),
          speedKmh: evt.speedKmh,
          lat: evt.lat,
          lng: evt.lng,
          lieuValide: evt.lieuValide,
          windowDesc: evaluation.windowDesc,
        },
      );
    } catch (err) {
      // Un écouteur d'événement qui lève casse le flux pour TOUS les abonnés — on journalise,
      // on n'interrompt jamais l'ingestion. Le pire cas est une alerte manquée, jamais une
      // trame perdue.
      this.logger.error(
        { vehicleId: evt.vehicleId, error: err instanceof Error ? err.message : String(err) },
        'Échec du traitement d\'une sortie hors champ',
      );
    }
  }
}
