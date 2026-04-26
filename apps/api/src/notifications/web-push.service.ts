import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import webpush, { PushSubscription as WebPushSubscription } from 'web-push';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';

/**
 * V1.5 (Sprint M) — Web Push notifications via VAPID.
 *
 * Mode no-op si VAPID_PUBLIC_KEY est vide. Pour generer les cles :
 *   npx web-push generate-vapid-keys
 *
 * Le frontend (Sprint M) utilise `getPublicKey()` pour s'abonner via Service
 * Worker. Le backend stocke les subscriptions dans `push_subscriptions` et
 * utilise `sendToUser(userId, payload)` pour broadcaster a tous les devices
 * d'un utilisateur.
 */

export interface PushPayload {
  title: string;
  body: string;
  icon?: string;
  data?: Record<string, unknown>;
  url?: string; // URL a ouvrir au clic
}

@Injectable()
export class WebPushService {
  private readonly logger = new Logger(WebPushService.name);
  private readonly enabled: boolean;
  private readonly publicKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {
    this.publicKey = this.config.get('VAPID_PUBLIC_KEY', { infer: true });
    const privateKey = this.config.get('VAPID_PRIVATE_KEY', { infer: true });
    const subject = this.config.get('VAPID_SUBJECT', { infer: true });
    this.enabled = !!(this.publicKey && privateKey);
    if (this.enabled) {
      webpush.setVapidDetails(subject, this.publicKey, privateKey);
      this.logger.log('Web Push enabled (VAPID configured)');
    } else {
      this.logger.warn('Web Push disabled (VAPID_PUBLIC_KEY missing)');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  getPublicKey(): string {
    return this.publicKey;
  }

  async subscribe(userId: string, sub: WebPushSubscription, userAgent?: string): Promise<void> {
    await this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        userId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent,
      },
      update: {
        userId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        userAgent,
        lastSeenAt: new Date(),
      },
    });
  }

  async unsubscribe(endpoint: string, userId: string): Promise<void> {
    await this.prisma.pushSubscription.deleteMany({
      where: { endpoint, userId },
    });
  }

  async listForUser(userId: string) {
    return this.prisma.pushSubscription.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
    });
  }

  /**
   * Send a push to all subscriptions of a user. Returns the number of
   * successful deliveries. Subscriptions returning 410 Gone are pruned.
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<{ sent: number; failed: number }> {
    if (!this.enabled) return { sent: 0, failed: 0 };
    const subs = await this.listForUser(userId);
    if (subs.length === 0) return { sent: 0, failed: 0 };

    const body = JSON.stringify(payload);
    let sent = 0;
    let failed = 0;
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
        sent++;
      } catch (err: unknown) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) {
          // Subscription expired or unregistered — prune.
          await this.prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => {/* ignore */});
        } else {
          this.logger.warn(`Push delivery failed (${status ?? '?'}) for sub ${sub.id}`);
        }
        failed++;
      }
    }
    return { sent, failed };
  }
}
