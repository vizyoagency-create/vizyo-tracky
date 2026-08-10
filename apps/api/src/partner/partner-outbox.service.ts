import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { PartnerClientService } from './partner-client.service';
import { PartnerConfigService } from './partner.config';

/** Rejeu exponentiel borné : 0 s, 30 s, 2 min, 10 min, 1 h, puis 1 h. */
const BACKOFF_SECONDS = [0, 30, 120, 600, 3600];
const MAX_ATTEMPTS = 12;

/**
 * Émission fiable des webhooks partenaires.
 *
 * ⚠️ Un webhook de révocation PERDU est une révocation perdue. On persiste donc
 * l'événement DANS la transaction de révocation, puis on l'émet — jamais l'inverse.
 * Si l'émission échoue, le cron rejoue.
 *
 * ⚠️ Ce n'est PAS la seule garantie : le partenaire découvrira aussi la révocation
 * au prochain renouvellement de bail (≤ 10 min) et à chaque lecture. Trois chemins
 * indépendants, dont aucun n'est critique à lui seul.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §9.1
 */
@Injectable()
export class PartnerOutboxService {
  private readonly logger = new Logger(PartnerOutboxService.name);
  /** Anti-recouvrement : `@Cron` ne l'empêche PAS tout seul (piège connu). */
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: PartnerClientService,
    private readonly config: PartnerConfigService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async dispatchPending(): Promise<void> {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    try {
      const due = await this.prisma.partnerOutboxEvent.findMany({
        where: { deliveredAt: null, nextAttemptAt: { lte: new Date() }, attempts: { lt: MAX_ATTEMPTS } },
        orderBy: { createdAt: 'asc' },
        take: 50,
      });
      for (const event of due) {
        await this.deliver(event);
      }
    } finally {
      this.running = false;
    }
  }

  /** Tentative immédiate après une révocation — le cron n'est que le filet. */
  async dispatchNow(linkId: string): Promise<void> {
    if (!this.config.enabled) return;
    const pending = await this.prisma.partnerOutboxEvent.findMany({
      where: { linkId, deliveredAt: null },
      orderBy: { createdAt: 'asc' },
    });
    for (const event of pending) {
      await this.deliver(event);
    }
  }

  private async deliver(event: {
    id: string;
    type: string;
    payload: unknown;
    attempts: number;
  }): Promise<void> {
    try {
      await this.client.sendWebhook({
        // L'id de l'événement sert de clé d'idempotence au receveur : un rejeu
        // du même webhook ne doit pas produire deux purges.
        eventId: event.id,
        type: event.type,
        payload: event.payload,
      });
      await this.prisma.partnerOutboxEvent.update({
        where: { id: event.id },
        data: { deliveredAt: new Date(), attempts: event.attempts + 1, lastError: null },
      });
      this.logger.log(`Webhook ${event.type} delivre (event=${event.id})`);
    } catch (err) {
      const attempts = event.attempts + 1;
      const delay = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length - 1)] ?? 3600;
      await this.prisma.partnerOutboxEvent.update({
        where: { id: event.id },
        data: {
          attempts,
          nextAttemptAt: new Date(Date.now() + delay * 1000),
          lastError: err instanceof Error ? err.message.slice(0, 300) : String(err),
        },
      });
      // WARN et pas ERROR : le partenaire injoignable est un cas NORMAL que les
      // deux autres chemins de révocation couvrent déjà.
      this.logger.warn(`Webhook ${event.type} en échec (tentative ${attempts}/${MAX_ATTEMPTS})`);
    }
  }
}
