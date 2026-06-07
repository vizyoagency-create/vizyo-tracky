import { Inject, Injectable, Logger, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import twilio from 'twilio';
import type { Twilio } from 'twilio';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
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

/**
 * Event emis a chaque SMS ENTRANT persiste (webhook vizyo-texto -> recordInbound).
 * La state machine de provisioning (TrackerProvisioningService) s'y abonne pour
 * faire avancer la sequence des qu'un boitier repond (ACK).
 */
export const SMS_INBOUND_EVENT = 'sms.inbound';
export interface SmsInboundEvent {
  smsLogId: string;
  fromNumber: string;
  toNumber: string;
  body: string;
  receivedAt: string;
}

@Injectable()
export class SmsGatewayService implements OnModuleInit {
  private readonly logger = new Logger(SmsGatewayService.name);

  // Provider actif : vizyo-texto (passerelle SMS maison) > twilio (legacy/fallback) > noop.
  private readonly provider: 'vizyo-texto' | 'twilio' | 'noop';

  // vizyo-texto (V1.14 — remplace Twilio). Cf. VIZYO_TEXTO_* dans env.validation.
  private readonly textoUrl: string;
  private readonly textoApiKey: string;

  // Twilio (legacy, conserve en fallback le temps de la transition).
  private readonly client: Twilio | null;
  private readonly fromNumber: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
    private readonly eventEmitter: EventEmitter2,
    @Optional() @Inject(ConfigService) private readonly config?: ConfigService<Env, true>,
  ) {
    this.textoUrl = (this.config?.get('VIZYO_TEXTO_URL', { infer: true }) ?? '').replace(/\/+$/, '');
    this.textoApiKey = this.config?.get('VIZYO_TEXTO_API_KEY', { infer: true }) ?? '';

    const sid = this.config?.get('TWILIO_ACCOUNT_SID', { infer: true }) ?? '';
    const token = this.config?.get('TWILIO_AUTH_TOKEN', { infer: true }) ?? '';
    this.fromNumber = this.config?.get('TWILIO_PHONE_NUMBER', { infer: true }) ?? '';

    if (this.textoUrl && this.textoApiKey) {
      this.provider = 'vizyo-texto';
      this.client = null;
      this.logger.log(`SMS Gateway active via vizyo-texto (${this.textoUrl})`);
    } else if (sid && token && this.fromNumber) {
      this.provider = 'twilio';
      this.client = twilio(sid, token);
      this.logger.log(`SMS Gateway active via Twilio (from ${this.fromNumber})`);
    } else {
      this.provider = 'noop';
      this.client = null;
      this.logger.warn('SMS Gateway disabled (ni VIZYO_TEXTO_* ni TWILIO_* configures) — mode no-op');
    }
  }

  // A8 — Alerte persistante si SMS en mode noop en production.
  async onModuleInit(): Promise<void> {
    if (this.provider === 'noop' && process.env['NODE_ENV'] === 'production') {
      this.errorLogger.record(
        'SMS Gateway en mode noop — ni VIZYO_TEXTO ni TWILIO configures',
        'sms-gateway',
        { NODE_ENV: process.env['NODE_ENV'] },
        'CRITICAL',
      ).catch((e) => this.logger.error('ErrorLog persist failed', e));
    }
  }

  isEnabled(): boolean {
    return this.provider !== 'noop';
  }

  /** Provider SMS actif (pour l'affichage du statut admin). */
  currentProvider(): 'vizyo-texto' | 'twilio' | 'noop' {
    return this.provider;
  }

  /**
   * V1.13 — Health check Twilio reel (auth ping + audit recents echecs).
   *
   * Cas couverts :
   *   - enabled = false : env vars manquants → mode noop (dev)
   *   - enabled = true + reachable = true : auth OK, gateway fonctionnelle
   *   - enabled = true + reachable = false : env vars set mais credentials
   *     invalides/expires/revoques (cas typique apres rotation Twilio)
   *
   * Avant : status() retournait juste enabled=bool (presence env vars) → UI
   * affichait "Twilio actif" alors qu'en realite les envois faisaient HTTP 401
   * silencieusement. L'admin devait fouiller les SMS logs pour decouvrir
   * `errorCode: 20003 "Authenticate"`. Maintenant on ping reellement.
   *
   * Le ping est non-bloquant : si Twilio est down/timeout, on retourne
   * unreachable avec l'erreur — pas d'exception propagee.
   */
  async healthCheck(): Promise<{
    enabled: boolean;
    reachable: boolean;
    error?: string;
    errorCode?: string;
    fromNumber?: string;
    recentFailures24h?: number;
    lastFailure?: { at: string; toNumber: string | null; errorCode?: string; errorMessage?: string } | null;
  }> {
    // Compte les SMS OUT en echec dans les 24h (utile meme en mode noop).
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [recentFailures24h, lastFailureRow] = await Promise.all([
      this.prisma.smsLog.count({
        where: { direction: 'OUT', status: 'failed', createdAt: { gte: since } },
      }),
      this.prisma.smsLog.findFirst({
        where: { direction: 'OUT', status: 'failed' },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true, toNumber: true, errorCode: true, errorMessage: true },
      }),
    ]);

    const lastFailure = lastFailureRow
      ? {
          at: lastFailureRow.createdAt.toISOString(),
          toNumber: lastFailureRow.toNumber,
          errorCode: lastFailureRow.errorCode ?? undefined,
          errorMessage: lastFailureRow.errorMessage ?? undefined,
        }
      : null;

    // vizyo-texto : ping le /health du relay (cout = 1 GET, pas de SMS).
    if (this.provider === 'vizyo-texto') {
      try {
        const res = await fetch(`${this.textoUrl}/health`, { signal: AbortSignal.timeout(5_000) });
        return {
          enabled: true,
          reachable: res.ok,
          error: res.ok ? undefined : `HTTP ${res.status}`,
          fromNumber: this.textoUrl,
          recentFailures24h,
          lastFailure,
        };
      } catch (err) {
        return {
          enabled: true,
          reachable: false,
          error: err instanceof Error ? err.message : String(err),
          fromNumber: this.textoUrl,
          recentFailures24h,
          lastFailure,
        };
      }
    }

    if (this.provider === 'noop' || !this.client) {
      return {
        enabled: false,
        reachable: false,
        fromNumber: this.fromNumber || undefined,
        recentFailures24h,
        lastFailure,
      };
    }

    const sid = this.config?.get('TWILIO_ACCOUNT_SID', { infer: true });
    try {
      // Ping Twilio en fetchant le compte. Cout = 1 req API simple, pas de SMS envoye.
      await this.client.api.accounts(sid as string).fetch();
      return {
        enabled: true,
        reachable: true,
        fromNumber: this.fromNumber,
        recentFailures24h,
        lastFailure,
      };
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      const errorCode = (err as { code?: string | number }).code?.toString();
      return {
        enabled: true,
        reachable: false,
        error: errorMessage,
        errorCode,
        fromNumber: this.fromNumber,
        recentFailures24h,
        lastFailure,
      };
    }
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

    // vizyo-texto en priorite (V1.14 — remplace l'appel Twilio).
    if (this.provider === 'vizyo-texto') {
      return this.sendViaVizyoTexto(safeTo, body, context);
    }

    // No-op mode: write the audit row, return success without network call.
    if (this.provider === 'noop' || !this.client) {
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
   * V1.14 — Envoi via la passerelle vizyo-texto (POST /v1/texto/send).
   *
   * Garde l'interface SendSmsResult identique (twilioSid = providerId capcom6)
   * et ecrit la MEME ligne d'audit smsLog que le chemin Twilio, pour que le reste
   * du code (UI admin, state machine provisioning) ne voie aucune difference.
   */
  private async sendViaVizyoTexto(
    to: string,
    body: string,
    context?: { imei?: string; provisioningId?: string; [k: string]: unknown },
  ): Promise<SendSmsResult> {
    try {
      // B1 — timeout 10s pour ne pas rester pendu si le relay hang.
      const res = await fetch(`${this.textoUrl}/v1/texto/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.textoApiKey}`,
        },
        body: JSON.stringify({ to, body, context }),
        signal: AbortSignal.timeout(10_000),
      });

      // A3 — si le JSON est malformé, on log dans ErrorLog (le body vide est traité par B4).
      let jsonParseOk = true;
      const data = (await res.json().catch((jsonErr: unknown) => {
        jsonParseOk = false;
        this.errorLogger.record(
          `vizyo-texto response JSON malformé: ${jsonErr instanceof Error ? jsonErr.message : String(jsonErr)}`,
          'sms-gateway',
          { url: `${this.textoUrl}/v1/texto/send`, httpStatus: res.status, toNumber: to, imei: context?.imei },
        ).catch((e) => this.logger.error('ErrorLog persist failed', e));
        return {};
      })) as {
        id?: string;
        status?: string;
        providerId?: string;
        error?: string;
        message?: string;
      };

      // A2 — HTTP non-2xx : log dans ErrorLog.
      if (!res.ok) {
        const errorMessage = data.message ?? data.error ?? `HTTP ${res.status}`;
        await this.prisma.smsLog.create({
          data: {
            direction: 'OUT',
            fromNumber: 'vizyo-texto',
            toNumber: to,
            body,
            status: 'failed',
            errorMessage,
            imei: context?.imei,
            provisioningId: context?.provisioningId,
            context: context as object,
          },
        });
        this.logger.error(`SMS (vizyo-texto) echec vers ${to}: ${errorMessage}`);
        this.errorLogger.record(
          errorMessage,
          'sms-gateway',
          { imei: context?.imei, toNumber: to, httpStatus: res.status, provider: 'vizyo-texto' },
        ).catch((e) => this.logger.error('ErrorLog persist failed', e));
        return { ok: false, error: errorMessage };
      }

      // B4 — 200 mais body vide/malformé → traiter comme échec.
      if (!jsonParseOk || Object.keys(data).length === 0) {
        const errorMessage = 'Response body vide ou malformé';
        await this.prisma.smsLog.create({
          data: {
            direction: 'OUT',
            fromNumber: 'vizyo-texto',
            toNumber: to,
            body,
            status: 'failed',
            errorMessage,
            imei: context?.imei,
            provisioningId: context?.provisioningId,
            context: context as object,
          },
        });
        this.logger.error(`SMS (vizyo-texto) echec vers ${to}: ${errorMessage}`);
        this.errorLogger.record(
          errorMessage,
          'sms-gateway',
          { imei: context?.imei, toNumber: to, httpStatus: res.status, provider: 'vizyo-texto' },
        ).catch((e) => this.logger.error('ErrorLog persist failed', e));
        return { ok: false, error: errorMessage };
      }

      const providerId = data.providerId ?? data.id;
      const status = data.status ?? 'queued';
      await this.prisma.smsLog.create({
        data: {
          direction: 'OUT',
          fromNumber: 'vizyo-texto',
          toNumber: to,
          body,
          twilioSid: providerId,
          status,
          imei: context?.imei,
          provisioningId: context?.provisioningId,
          context: context as object,
        },
      });
      return { ok: status !== 'failed', twilioSid: providerId };
    } catch (err) {
      // A1 — erreur réseau / timeout → log dans ErrorLog.
      const errorMessage = err instanceof Error ? err.message : String(err);
      await this.prisma.smsLog.create({
        data: {
          direction: 'OUT',
          fromNumber: 'vizyo-texto',
          toNumber: to,
          body,
          status: 'failed',
          errorMessage,
          imei: context?.imei,
          provisioningId: context?.provisioningId,
          context: context as object,
        },
      });
      this.logger.error(`SMS (vizyo-texto) erreur vers ${to}: ${errorMessage}`);
      this.errorLogger.record(
        err instanceof Error ? err : new Error(errorMessage),
        'sms-gateway',
        { imei: context?.imei, toNumber: to, provider: 'vizyo-texto' },
      ).catch((e) => this.logger.error('ErrorLog persist failed', e));
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
    // Notifie la state machine de provisioning (attente d'ACK) + tout autre listener.
    this.eventEmitter.emit(SMS_INBOUND_EVENT, {
      smsLogId: log.id,
      fromNumber: payload.fromNumber,
      toNumber: payload.toNumber,
      body: payload.body,
      receivedAt: new Date().toISOString(),
    } satisfies SmsInboundEvent);
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

  /**
   * V1.13 — Test du flow fallback SMS depuis l'UI admin (SUPER_ADMIN).
   *
   * Bypass les 3 conditions de `TrackerFixModeService.tryFallbackSms`
   * (simPhoneNumber, offline > 5min, SMS enabled) pour permettre a un admin de
   * valider la gateway SMS sans avoir a simuler un tracker offline. Envoie un
   * payload `fix030s***n123456` de test (commande Coban benigne).
   *
   * Le SMS est envoye au `recipientPhone` fourni par l'admin, PAS au
   * `simPhoneNumber` du tracker — c'est un test, on ne veut pas polluer une
   * vraie SIM en prod.
   *
   * Le SmsLog est cree avec un context explicite `source: 'admin-test-fallback'`
   * pour distinguer des vrais fallbacks dans l'audit Logs.
   *
   * Retourne le resultat brut de send() + le payload pour traceabilite UI.
   */
  async testFallbackForTracker(input: {
    trackerId: string;
    recipientPhone: string;
    requestedByUserId: string;
  }): Promise<{
    ok: boolean;
    smsResult: SendSmsResult;
    payload: string;
    trackerImei: string;
  }> {
    const tracker = await this.prisma.tracker.findUnique({
      where: { id: input.trackerId },
      select: { id: true, imei: true },
    });
    if (!tracker) {
      throw new Error(`Tracker ${input.trackerId} introuvable`);
    }
    const safePhone = input.recipientPhone.trim();
    if (!safePhone.startsWith('+') || safePhone.length < 8) {
      throw new Error(
        'Numero destinataire invalide (format E.164 attendu, ex: +33612345678)',
      );
    }
    const payload = `fix030s***n123456`; // benigne 30s
    const smsResult = await this.send(safePhone, payload, {
      imei: tracker.imei,
      source: 'admin-test-fallback',
      requestedByUserId: input.requestedByUserId,
    });
    return {
      ok: smsResult.ok,
      smsResult,
      payload,
      trackerImei: tracker.imei,
    };
  }
}
