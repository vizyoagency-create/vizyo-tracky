import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { COUPE_CIRCUIT_PUSH_EVENT, type CoupeCircuitPushEvent } from './coupe-circuit-push.events';
import { NotificationDispatchService } from './notification-dispatch.service';

/**
 * Coupe-circuit — ce qui doit prévenir les super-admins, poussé par le socle générique.
 *
 * Reçoit les événements `coupe-circuit.push` (coupes retenues, preuve SMS en défaut, téléphone
 * passerelle hors ligne, remise en route non confirmée) et les remet à `notifyUsers` :
 * `PUSH_ROLLOUT` s'applique (SUPER_ADMIN_ONLY aujourd'hui — c'est le propriétaire qui reçoit),
 * les préférences aussi, l'anti-spam aussi (15 min par sujet, plafond horaire), et chaque envoi
 * — ou retenue — s'écrit au journal des notifications. Best-effort : la ligne du centre
 * d'alerte est déjà écrite quand l'événement part ; un échec ici se note et ne casse rien.
 */
@Injectable()
export class CoupeCircuitPushService {
  private readonly logger = new Logger(CoupeCircuitPushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly dispatch: NotificationDispatchService,
  ) {}

  @OnEvent(COUPE_CIRCUIT_PUSH_EVENT, { async: true })
  async prevenir(event: CoupeCircuitPushEvent): Promise<number> {
    try {
      const admins = await this.prisma.user.findMany({
        where: { role: UserRole.SUPER_ADMIN, isActive: true },
        select: { id: true },
      });
      if (admins.length === 0) return 0;
      return await this.dispatch.notifyUsers({
        userIds: admins.map((a) => a.id),
        category: 'SYSTEM',
        kind: event.kind,
        subjectKey: event.subjectKey,
        title: event.title,
        body: event.body,
        url: event.url ?? '/admin/alerts',
      });
    } catch (e) {
      this.logger.warn(
        `notification coupe-circuit (${event.kind} / ${event.subjectKey}) non envoyée : ${e instanceof Error ? e.message : String(e)}`,
      );
      return 0;
    }
  }
}
