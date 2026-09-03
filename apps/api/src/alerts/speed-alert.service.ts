import { Injectable, Logger } from '@nestjs/common';
import type { Alert } from '@prisma/client';
import { decideAlerteExces, reglageEffectif, type DecisionAlerteVitesse, type ReglageAlerteVitesse } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { AlertsService } from './alerts.service';

/**
 * Lot V5 (2026-09-03) — LE MAILLON QUI MANQUAIT : de l'analyse de trajet à l'alerte.
 *
 * ── CE QUI SE PASSAIT ────────────────────────────────────────────────────────────────────
 * L'analyse mesurait les excès contre la limite légale, les rangeait dans `trip_analyses`,
 * et personne n'en était prévenu : `trip-analysis/` ne contenait pas une référence à
 * `AlertsService`. La seule alerte d'excès venait d'un bit d'alarme du boîtier, sans limite
 * légale. Sur trente jours, 3 400 trajets avec excès n'avaient aucune alerte ; le trajet à
 * 168 km/h n'en avait pas non plus.
 *
 * ── CE QUE FAIT CE SERVICE ───────────────────────────────────────────────────────────────
 * Appelé après CHAQUE écriture d'analyse — première analyse comme ré-analyse. Il lit le
 * réglage effectif du véhicule (société, surchargée par le véhicule), applique la décision
 * PARTAGÉE `decideAlerteExces`, et confie la création à `AlertsService`, qui déduplique
 * par trajet. La ré-analyse d'un trajet qui gagne un excès (cas du 180 km/h dont la limite
 * n'a été connue que le lendemain) produit donc bien son alerte, une seule fois.
 *
 * ⚠️ OPT-IN. Rien ne part tant que la société n'a pas activé ses alertes de vitesse : au
 * déploiement, aucun client n'est arrosé pour des trajets qu'il n'a pas demandé à surveiller.
 */

/**
 * Au-delà de cet âge, un trajet ne produit plus d'alerte, même s'il vient d'être analysé.
 *
 * L'automatisation rattrape jusqu'à soixante jours de trajets, et la reprise des analyses
 * à couverture faible en rejoue vingt-cinq par passage. Une notification « il y a trois
 * semaines, vous rouliez à 140 » ne prévient de rien : elle réveille. L'excès reste écrit
 * dans l'analyse et dans les rapports ; seule la NOTIFICATION est réservée au récent.
 */
export const FRAICHEUR_MAX_MS = 48 * 60 * 60 * 1000;

export interface TrajetAAlerter {
  id: string;
  vehicleId: string;
  trackerId: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

export interface AnalyseAAlerter {
  maxSpeedKmh: number;
  speeding: { startAt: string; endAt: string; durationSec: number; maxSpeedKmh: number; limitKmh: number; overKmh: number; lat: number; lng: number }[];
  track?: { lat: number; lng: number; t: string; speedKmh: number }[];
}

/** Ce que l'évaluation a décidé, pour le journal et les tests. */
export type IssueEvaluation =
  | { issue: 'trop-ancien' }
  | { issue: 'vehicule-inconnu' }
  | { issue: 'desactive'; reglage: ReglageAlerteVitesse }
  | { issue: 'rien-a-signaler'; reglage: ReglageAlerteVitesse }
  | { issue: 'deja-alerte'; decision: DecisionAlerteVitesse }
  | { issue: 'alerte'; decision: DecisionAlerteVitesse; alert: Alert };

@Injectable()
export class SpeedAlertService {
  private readonly logger = new Logger(SpeedAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alerts: AlertsService,
  ) {}

  /**
   * Évalue un trajet fraîchement analysé et crée l'alerte s'il y a lieu.
   *
   * Ne lève jamais vers l'appelant pour une raison métier : une analyse réussie reste une
   * analyse réussie. Les erreurs techniques (base injoignable) remontent, et c'est
   * l'appelant qui les journalise sans faire échouer l'analyse.
   */
  async evaluer(trip: TrajetAAlerter, analyse: AnalyseAAlerter, maintenant = Date.now()): Promise<IssueEvaluation> {
    const fin = (trip.endedAt ?? trip.startedAt).getTime();
    if (maintenant - fin > FRAICHEUR_MAX_MS) return { issue: 'trop-ancien' };

    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: trip.vehicleId },
      select: {
        id: true, plate: true, fleetId: true,
        speedAlertEnabled: true, speedAlertOverKmh: true,
        fleet: { select: { speedAlertEnabled: true, speedAlertOverKmh: true, speedAlertAbsoluteKmh: true } },
      },
    });
    if (!vehicle) return { issue: 'vehicule-inconnu' };

    const reglage = reglageEffectif(vehicle.fleet, vehicle);
    if (!reglage.enabled) return { issue: 'desactive', reglage };

    const decision = decideAlerteExces(
      { maxSpeedKmh: analyse.maxSpeedKmh, speeding: analyse.speeding ?? [], track: analyse.track },
      reglage,
    );
    if (!decision) return { issue: 'rien-a-signaler', reglage };

    const alert = await this.alerts.createSpeedingAlert({
      trip,
      vehicle: { id: vehicle.id, plate: vehicle.plate, fleetId: vehicle.fleetId },
      decision,
      reglage,
    });
    if (!alert) return { issue: 'deja-alerte', decision };

    this.logger.log(
      `Excès de vitesse alerté pour ${vehicle.plate} — ${decision.speedKmh} km/h, ` +
        `${decision.motif === 'limite' ? `limite ${decision.limitKmh}` : `plafond ${reglage.absoluteKmh}`} (+${decision.overKmh}), trajet ${trip.id}`,
    );
    return { issue: 'alerte', decision, alert };
  }
}
