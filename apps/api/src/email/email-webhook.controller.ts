import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  OnModuleInit,
  Post,
  RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmailStatus } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Webhook ENTRANT depuis Resend (events de délivrabilité). Calque le pattern
 * fail-closed de SmsWebhookController : rawBody + vérif signature + rejet si secret
 * absent en production. Resend signe en **Svix** (headers svix-id / svix-timestamp /
 * svix-signature, secret 'whsec_…'). Met à jour la ligne EmailLog par `providerId`.
 *
 * Config Resend : dashboard → Webhooks → ajouter `https://<domaine>/api/email/webhook`,
 * events email.sent/delivered/opened/clicked/bounced/complained/delivery_delayed.
 */

/**
 * Priorité de statut — un event ne régresse JAMAIS un statut plus avancé
 * (ex: un `delivered` reçu après un `opened` ne réécrit pas OPENED). Les états
 * d'échec (bounced/failed/complained) l'emportent pour rester visibles.
 */
const STATUS_PRIORITY: Record<EmailStatus, number> = {
  QUEUED: 0,
  SENT: 1,
  DELIVERED: 2,
  OPENED: 3,
  CLICKED: 4,
  BOUNCED: 5,
  FAILED: 5,
  COMPLAINED: 6,
};

const EVENT_MAP: Record<string, { status: EmailStatus; stamp?: 'openedAt' | 'clickedAt' | 'bouncedAt' }> = {
  'email.sent': { status: EmailStatus.SENT },
  'email.delivered': { status: EmailStatus.DELIVERED },
  'email.delivery_delayed': { status: EmailStatus.QUEUED },
  'email.opened': { status: EmailStatus.OPENED, stamp: 'openedAt' },
  'email.clicked': { status: EmailStatus.CLICKED, stamp: 'clickedAt' },
  'email.bounced': { status: EmailStatus.BOUNCED, stamp: 'bouncedAt' },
  'email.failed': { status: EmailStatus.FAILED },
  'email.complained': { status: EmailStatus.COMPLAINED },
};

interface ResendEvent {
  type?: string;
  data?: {
    email_id?: string;
    id?: string;
    bounce?: { type?: string; subType?: string; message?: string };
    [k: string]: unknown;
  };
}

@Controller('email')
export class EmailWebhookController implements OnModuleInit {
  private readonly logger = new Logger(EmailWebhookController.name);

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  private get isProd(): boolean {
    return this.config.get('NODE_ENV', { infer: true }) === 'production';
  }

  /** Fail-closed : en prod SANS secret, le webhook rejette tout → alerte au boot. */
  onModuleInit(): void {
    if (this.isProd && !this.config.get('RESEND_WEBHOOK_SECRET', { infer: true })) {
      this.logger.error(
        'CRITICAL: RESEND_WEBHOOK_SECRET non configuré en production — /email/webhook rejette tous les appels (fail-closed).',
      );
      this.errorLogger
        .record(
          'RESEND_WEBHOOK_SECRET manquant en production (webhook e-mail fail-closed)',
          'email-webhook',
          { phase: 'boot' },
        )
        .catch(() => undefined);
    }
  }

  @Post('webhook')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('svix-id') svixId: string | undefined,
    @Headers('svix-timestamp') svixTimestamp: string | undefined,
    @Headers('svix-signature') svixSignature: string | undefined,
    @Body() body: ResendEvent,
  ): Promise<{ ok: boolean }> {
    const secret = this.config.get('RESEND_WEBHOOK_SECRET', { infer: true });

    if (!secret) {
      // Fail-closed : sans secret on ne peut PAS authentifier. Prod → rejet, dev → toléré.
      if (this.isProd) {
        this.logger.error('Webhook Resend : secret absent en production — rejet (fail-closed)');
        this.errorLogger
          .record('Webhook Resend: secret absent en production — appel rejeté (fail-closed)', 'email-webhook', {
            type: body?.type,
          })
          .catch((e) => this.logger.error('ErrorLog persist failed', e));
        return { ok: false };
      }
      this.logger.warn('Webhook Resend : pas de secret configuré (dev) — signature non vérifiée');
    } else if (!this.verifySvix(req.rawBody, svixId, svixTimestamp, svixSignature, secret)) {
      this.logger.warn('Webhook Resend : signature invalide, rejet');
      this.errorLogger
        .record('Webhook Resend: signature Svix invalide', 'email-webhook', { type: body?.type, svixId })
        .catch((e) => this.logger.error('ErrorLog persist failed', e));
      return { ok: false };
    }

    const providerId = body?.data?.email_id ?? body?.data?.id;
    if (!body?.type || !providerId) {
      // Event sans type/id exploitable : 200 pour éviter que Resend ne retente en boucle.
      return { ok: true };
    }

    await this.applyEvent(body.type, providerId, body.data ?? {});
    return { ok: true };
  }

  /** Applique l'event à la ligne EmailLog (best-effort, sans régression de statut). */
  private async applyEvent(type: string, providerId: string, data: NonNullable<ResendEvent['data']>): Promise<void> {
    const mapped = EVENT_MAP[type];
    if (!mapped) {
      this.logger.debug(`Event Resend ignoré: ${type}`);
      return;
    }
    try {
      const existing = await this.prisma.emailLog.findUnique({ where: { providerId } });
      if (!existing) {
        this.logger.debug(`EmailLog introuvable pour providerId ${providerId} (${type})`);
        return;
      }

      const patch: Record<string, unknown> = {};
      if (STATUS_PRIORITY[mapped.status] >= STATUS_PRIORITY[existing.status]) {
        patch.status = mapped.status;
      }
      const now = new Date();
      if (mapped.stamp === 'openedAt' && !existing.openedAt) patch.openedAt = now;
      if (mapped.stamp === 'clickedAt' && !existing.clickedAt) patch.clickedAt = now;
      if (mapped.stamp === 'bouncedAt' && !existing.bouncedAt) patch.bouncedAt = now;
      if (type === 'email.bounced' || type === 'email.failed') {
        if (data.bounce?.type) patch.errorCode = String(data.bounce.subType ?? data.bounce.type).slice(0, 120);
        if (data.bounce?.message) patch.errorMessage = String(data.bounce.message).slice(0, 500);
      }

      if (Object.keys(patch).length === 0) return;
      await this.prisma.emailLog.update({ where: { providerId }, data: patch });
    } catch (e) {
      this.logger.warn(`EmailLog webhook update failed (${type}/${providerId}): ${String(e)}`);
    }
  }

  /**
   * Vérif signature Svix (format Resend). Secret 'whsec_<base64>' → clé = base64-décodée.
   * Signature attendue = base64(HMAC-SHA256(clé, `${id}.${timestamp}.${rawBody}`)), comparée
   * en timing-safe aux signatures `v1,<sig>` du header. Anti-replay ±5 min.
   */
  private verifySvix(
    raw: Buffer | undefined,
    id: string | undefined,
    timestamp: string | undefined,
    header: string | undefined,
    secret: string,
  ): boolean {
    if (!raw || !id || !timestamp || !header) return false;
    const ts = Number.parseInt(timestamp, 10);
    if (!Number.isFinite(ts) || Math.abs(Math.floor(Date.now() / 1000) - ts) > 300) return false;

    let key: Buffer;
    try {
      key = Buffer.from(secret.startsWith('whsec_') ? secret.slice(6) : secret, 'base64');
    } catch {
      return false;
    }
    if (key.length === 0) return false;

    const expected = createHmac('sha256', key)
      .update(`${id}.${timestamp}.${raw.toString('utf8')}`)
      .digest('base64');
    const expectedBuf = Buffer.from(expected);

    // header = "v1,<sig> v1,<sig2> …" (une signature par clé de signature active).
    return header.split(' ').some((part) => {
      const sig = part.includes(',') ? part.split(',')[1] : part;
      if (!sig) return false;
      const b = Buffer.from(sig);
      return b.length === expectedBuf.length && b.length > 0 && timingSafeEqual(expectedBuf, b);
    });
  }
}
