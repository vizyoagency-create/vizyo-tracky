import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio from 'twilio';
import type { Twilio } from 'twilio';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';

/**
 * V1.5 (Sprint I) — SMS Gateway via Twilio.
 *
 * Mode "no-op" : si TWILIO_ACCOUNT_SID est vide, le service log les envois mais
 * ne fait pas d'appel reseau. Permet de developper / tester en local sans
 * credentials Twilio.
 *
 * Toutes les routes consommatrices sont reservees SUPER_ADMIN (cf.
 * SmsAdminController, decision §0.3 de docs/13-roadmap-v1.5-finition.md).
 */

export interface SendSmsResult {
  ok: boolean;
  twilioSid?: string;
  error?: string;
}

@Injectable()
export class SmsGatewayService {
  private readonly logger = new Logger(SmsGatewayService.name);
  private readonly client: Twilio | null;
  private readonly fromNumber: string;
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
  ) {
    const sid = this.config?.get('TWILIO_ACCOUNT_SID', { infer: true }) ?? '';
    const token = this.config?.get('TWILIO_AUTH_TOKEN', { infer: true }) ?? '';
    this.fromNumber = this.config?.get('TWILIO_PHONE_NUMBER', { infer: true }) ?? '';
    this.enabled = !!(sid && token && this.fromNumber);
    if (this.enabled) {
      this.client = twilio(sid, token);
      this.logger.log(`SMS Gateway active (from ${this.fromNumber})`);
    } else {
      this.client = null;
      this.logger.warn('SMS Gateway disabled (TWILIO_* env vars missing) — running in no-op mode');
    }
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Send an SMS and persist the audit row in `sms_logs`.
   * In no-op mode, the audit row is still written with `status = 'noop'`.
   */
  async send(
    to: string,
    body: string,
    context?: { imei?: string; provisioningId?: string; [k: string]: unknown },
  ): Promise<SendSmsResult> {
    const safeTo = to.trim();
    if (!safeTo) return { ok: false, error: 'Numero destinataire vide' };

    // No-op mode: write the audit row, return success without network call.
    if (!this.enabled || !this.client) {
      await this.prisma.smsLog.create({
        data: {
          direction: 'OUT',
          fromNumber: this.fromNumber || 'noop',
          toNumber: safeTo,
          body,
          status: 'noop',
          imei: context?.imei,
          provisioningId: context?.provisioningId,
          context: context as object,
        },
      });
      this.logger.debug(`[noop] SMS to ${safeTo}: ${body}`);
      return { ok: true };
    }

    try {
      const message = await this.client.messages.create({
        from: this.fromNumber,
        to: safeTo,
        body,
      });
      await this.prisma.smsLog.create({
        data: {
          direction: 'OUT',
          fromNumber: this.fromNumber,
          toNumber: safeTo,
          body,
          twilioSid: message.sid,
          status: message.status,
          imei: context?.imei,
          provisioningId: context?.provisioningId,
          context: context as object,
        },
      });
      return { ok: true, twilioSid: message.sid };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = (err as { code?: string | number }).code?.toString();
      await this.prisma.smsLog.create({
        data: {
          direction: 'OUT',
          fromNumber: this.fromNumber,
          toNumber: safeTo,
          body,
          status: 'failed',
          errorCode,
          errorMessage,
          imei: context?.imei,
          provisioningId: context?.provisioningId,
          context: context as object,
        },
      });
      this.logger.error(`SMS send failed to ${safeTo}: ${errorMessage}`);
      return { ok: false, error: errorMessage };
    }
  }

  /**
   * Persist an inbound SMS (from Twilio webhook). Provisioning state machine
   * subscribes via TrackerProvisioningService.handleInbound() to advance steps
   * when the device replies "ok 123456".
   */
  async recordInbound(payload: {
    fromNumber: string;
    toNumber: string;
    body: string;
    twilioSid?: string;
    imei?: string;
  }): Promise<{ id: string }> {
    const log = await this.prisma.smsLog.create({
      data: {
        direction: 'IN',
        fromNumber: payload.fromNumber,
        toNumber: payload.toNumber,
        body: payload.body,
        twilioSid: payload.twilioSid,
        status: 'received',
        imei: payload.imei,
      },
    });
    return { id: log.id };
  }

  /** Audit log query — returns last N SMS for the admin UI. */
  async listLogs(limit = 100, imei?: string) {
    return this.prisma.smsLog.findMany({
      where: imei ? { imei } : undefined,
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 500),
    });
  }
}
