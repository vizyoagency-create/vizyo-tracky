import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AlertSeverity, type AlertRule } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationDispatchService } from './notification-dispatch.service';

/**
 * V1.5 (Sprint M) — Escalade automatique des alertes CRITICAL non acquittees.
 *
 * V1.10 (Sprint 4) — applique maintenant `AlertRule.escalateAfterMin` par
 * regle plutot que le delai hardcode 10min. Cron tick toutes les minutes pour
 * absorber les delais courts (ex: 2min sur des alertes SOS). Pour une alerte
 * donnee on prend le min des escalateAfterMin des regles qui la matchent
 * (vehicleId + alertType + '*'), fallback 10min si aucune n'en specifie.
 *
 * Marque `Alert.escalatedAt` via un claim atomique (updateMany conditionnel)
 * pour rendre l'operation idempotente meme si 2 ticks tournent en parallele.
 */
const DEFAULT_ESCALATE_MIN = 10;
const MIN_ALERT_AGE_MS = 60_000; // ne jamais escalader avant 1min (laisse le dispatch initial finir)

@Injectable()
export class EscalationCronService {
  private readonly logger = new Logger(EscalationCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async run(): Promise<void> {
    const now = Date.now();
    // On scanne les alertes critiques pas encore traitees qui ont > 1min.
    // Le filtre fin sur escalateAfterMin se fait en JS (le delai depend des
    // regles applicables, pas calculable en SQL simplement).
    const candidates = await this.prisma.alert.findMany({
      where: {
        severity: AlertSeverity.CRITICAL,
        acknowledgedAt: null,
        escalatedAt: null,
        createdAt: { lt: new Date(now - MIN_ALERT_AGE_MS) },
      },
      include: { vehicle: true },
      take: 200,
    });

    if (candidates.length === 0) return;

    // Cache des regles par fleetId — evite N+1 sur plusieurs alertes meme flotte.
    const rulesByFleet = new Map<string, AlertRule[]>();
    const dueAlerts = [];
    for (const alert of candidates) {
      let rules = rulesByFleet.get(alert.fleetId);
      if (!rules) {
        rules = await this.prisma.alertRule.findMany({
          where: { fleetId: alert.fleetId, enabled: true },
        });
        rulesByFleet.set(alert.fleetId, rules);
      }
      const delayMin = this.effectiveEscalateMin(alert.type as string, alert.vehicleId, rules);
      const ageMs = now - alert.createdAt.getTime();
      if (ageMs >= delayMin * 60_000) {
        dueAlerts.push(alert);
      }
    }
    if (dueAlerts.length === 0) return;
    this.logger.log(`Escalating ${dueAlerts.length} unack CRITICAL alerts (filtered ${candidates.length - dueAlerts.length} not yet due)`);

    // Renomme la variable locale du loop suivant pour reduire la diff.
    const candidates2 = dueAlerts;

    for (const alert of candidates2) {
      // V1.10 (Sprint 4) — claim atomique anti-race : on tente d'ecrire
      // escalatedAt SI il est encore null. Si un autre tick cron a deja claim
      // cette alerte (count=0), on skip. Empeche le double-dispatch quand un
      // tick precedent prend > 5min (cas dispatch lent email/whatsapp).
      const now = new Date();
      const claim = await this.prisma.alert.updateMany({
        where: { id: alert.id, escalatedAt: null },
        data: { escalatedAt: now },
      });
      if (claim.count === 0) {
        this.logger.debug(`Alert ${alert.id} already escalated by concurrent tick, skip`);
        continue;
      }

      try {
        await this.dispatch.dispatchEscalation(alert);
      } catch (err) {
        this.logger.warn(
          `Escalation dispatch failed for alert ${alert.id}: ${err instanceof Error ? err.message : err}`,
        );
        // Le claim est conserve : ne pas retenter (les destinataires habituels
        // sont deja notifies via le dispatch initial — l'escalade est un bonus,
        // pas un must-have). Si on rollback escalatedAt en cas d'erreur, on
        // risque le double-dispatch si dispatchEscalation a partiellement reussi.
      }
    }
  }

  /**
   * Retourne le delai d'escalade effectif pour une alerte = min des
   * `escalateAfterMin` non-null des regles qui matchent. Fallback DEFAULT
   * (10 min) si aucune regle n'en specifie un.
   *
   * Les regles `vehicleId=null` (catch-all flotte) sont considerees au meme
   * titre que les regles vehicule-specifiques, et le `alertType` doit matcher
   * exactement ou etre '*'.
   */
  private effectiveEscalateMin(
    alertType: string,
    alertVehicleId: string | null,
    rules: AlertRule[],
  ): number {
    let min: number | null = null;
    for (const rule of rules) {
      if (rule.escalateAfterMin == null) continue;
      const typeMatches = rule.alertType === alertType || rule.alertType === '*';
      const vehicleMatches = rule.vehicleId === null || rule.vehicleId === alertVehicleId;
      if (typeMatches && vehicleMatches) {
        if (min === null || rule.escalateAfterMin < min) min = rule.escalateAfterMin;
      }
    }
    return min ?? DEFAULT_ESCALATE_MIN;
  }
}
