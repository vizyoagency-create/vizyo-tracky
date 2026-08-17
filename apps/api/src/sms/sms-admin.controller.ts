import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AllowlistService } from './allowlist.service';
import { SmsGatewayService } from './sms-gateway.service';
import { SmsHeartbeatService } from './sms-heartbeat.service';
import { TrackerProvisioningService } from './tracker-provisioning.service';

/**
 * V1.5 (Sprint I) — Admin SMS endpoints.
 *
 * Toutes les routes sont reservees SUPER_ADMIN (decision §0.3 de la roadmap 13).
 * Les FLEET_ADMIN n'ont pas besoin d'acces SMS direct.
 */
@Controller('admin/sms')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class SmsAdminController {
  constructor(
    private readonly sms: SmsGatewayService,
    private readonly provisioning: TrackerProvisioningService,
    private readonly allowlist: AllowlistService,
    private readonly heartbeat: SmsHeartbeatService,
  ) {}

  @Get('status')
  async status() {
    // V1.13 — Reel health check (auth Twilio + audit 24h) au lieu du simple
    // check env vars. Backward compat : on garde `enabled` et on ajoute :
    //   - reachable : auth Twilio reussit (true) ou echoue (false)
    //   - mode : 'twilio' (enabled+reachable) | 'twilio-broken' (enabled+!reachable) | 'noop' (!enabled)
    //   - error/errorCode : raison echec auth (ex: '20003' = "Authenticate")
    //   - recentFailures24h + lastFailure : visibilite sur les SMS qui ont rate
    // L'UI doit privilegier `reachable` sur `enabled` pour le verdict visuel.
    const hc = await this.sms.healthCheck();
    const provider = this.sms.currentProvider();
    // mode reflete le provider reel : 'vizyo-texto' | 'twilio' | 'noop'
    // (+ suffixe '-broken' si configure mais injoignable).
    let mode: string;
    if (provider === 'noop' || !hc.enabled) mode = 'noop';
    else if (hc.reachable) mode = provider;
    else mode = `${provider}-broken`;
    return {
      enabled: hc.enabled,
      reachable: hc.reachable,
      mode,
      error: hc.error,
      errorCode: hc.errorCode,
      fromNumber: hc.fromNumber,
      recentFailures24h: hc.recentFailures24h,
      lastFailure: hc.lastFailure,
    };
  }

  @Post('send')
  async sendArbitrary(@Body() body: { to: string; message: string }) {
    if (!body?.to || !body?.message) {
      throw new BadRequestException('to et message sont requis');
    }
    return this.sms.send(body.to, body.message, { template: 'admin_manual' });
  }

  /**
   * V1.13 — POST /api/admin/sms/test-fallback
   *
   * Permet a un SUPER_ADMIN de tester le flow fallback SMS sans simuler
   * un tracker offline. Bypass les 3 conditions de TrackerFixModeService.
   *
   * Body : { trackerId: uuid, recipientPhone: '+E.164' }
   *
   * Returns : { ok, payload, trackerImei, smsResult: { ok, twilioSid?, error? } }
   *
   * Le SMS envoye contient `fix030s***n123456` (commande benigne 30s).
   * Cree un SmsLog avec context `source: 'admin-test-fallback'`.
   */
  @Post('test-fallback')
  async testFallback(
    @Req() req: AuthenticatedRequest,
    @Body() body: { trackerId?: string; recipientPhone?: string },
  ) {
    if (!body?.trackerId || !body?.recipientPhone) {
      throw new BadRequestException('trackerId et recipientPhone sont requis');
    }
    try {
      return await this.sms.testFallbackForTracker({
        trackerId: body.trackerId,
        recipientPhone: body.recipientPhone,
        requestedByUserId: req.user.id,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new BadRequestException(msg);
    }
  }

  /**
   * V1.15 — POST /api/admin/sms/heartbeat/run-now
   *
   * Declenche manuellement l'ENVOI de la "preuve de vie" SMS (sinon cron hebdo lundi 09h00).
   * Utile pour valider la chaine SMS post-deploiement sans attendre. Envoie un
   * SMS de test a chaque numero de SMS_HEARTBEAT_RECIPIENTS via la gateway active.
   *
   * Returns : { provider, recipients, sent, failed, skipped, smsLogIds[], results[] }
   * `skipped=true` => aucun destinataire configure (no-op safe).
   *
   * ⚠️ **`sent` ne prouve PAS que le SMS est arrive** (TRK-026) : il compte les messages
   * ACCEPTES par la passerelle, dans la meme seconde. Pour un verdict de remise, appeler
   * ensuite `POST heartbeat/verify` — quelques minutes plus tard.
   */
  @Post('heartbeat/run-now')
  async runHeartbeat() {
    return this.heartbeat.runHeartbeat();
  }

  /**
   * TRK-026 — POST /api/admin/sms/heartbeat/verify
   *
   * Relit les heartbeats recents et prononce le verdict de REMISE. N'envoie rien :
   * idempotent, rejouable. Pendant manuel du cron de lundi 09h20.
   *
   * Returns : { verdict, checked, delivered, failed, indeterminate, oldestAgeMin }
   * `verdict = 'INDETERMINE'` est la reponse HONNETE tant que la passerelle n'expose
   * aucun accuse de remise : ni un succes, ni une panne.
   */
  @Post('heartbeat/verify')
  async verifyHeartbeat() {
    return this.heartbeat.verifyHeartbeat();
  }

  @Get('logs')
  async logs(@Query('limit') limitRaw?: string, @Query('imei') imei?: string) {
    const limit = Math.max(1, Math.min(parseInt(limitRaw ?? '100', 10) || 100, 500));
    const items = await this.sms.listLogs(limit, imei);
    return { items };
  }

  @Post('provision')
  async startProvisioning(
    @Req() req: AuthenticatedRequest,
    @Body()
    body: {
      imei: string;
      phoneNumber: string;
      apn: string;
      apnUser?: string;
      apnPasswd?: string;
      serverIp: string;
      serverPort: number;
      adminNumber?: string;
      lowBatteryPhone?: string;
      accOn?: boolean;
      fixIntervalS?: number;
      ackTimeoutS?: number;
    },
  ) {
    return this.provisioning.start(body, req.user.id);
  }

  @Get('provision')
  async listProvisioning(@Req() req: AuthenticatedRequest, @Query('limit') limitRaw?: string) {
    const limit = Math.max(1, Math.min(parseInt(limitRaw ?? '50', 10) || 50, 200));
    // Passe le requestedBy en defense en profondeur — actuellement le @Roles
    // au niveau classe restreint deja a SUPER_ADMIN, mais on ne veut pas que
    // le service repose uniquement sur le guard.
    return { items: await this.provisioning.list(limit, { role: req.user.role, fleetId: req.user.fleetId }) };
  }

  @Get('provision/:id')
  async getProvisioning(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.provisioning.findOne(id, { role: req.user.role, fleetId: req.user.fleetId });
  }

  @Post('provision/:id/cancel')
  async cancelProvisioning(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    await this.provisioning.cancel(id, { role: req.user.role, fleetId: req.user.fleetId });
    return { ok: true };
  }

  // ─── Allowlist vizyo-texto (V1.14) ────────────────────────────────────────
  // Proxy vers l'API /v1/allowlist du relay + reconciliation avec les trackers.

  @Get('allowlist')
  listAllowlist() {
    return this.allowlist.list();
  }

  @Post('allowlist')
  addAllowlist(@Body() body: { phone?: string; label?: string }) {
    if (!body?.phone) throw new BadRequestException('phone requis');
    return this.allowlist.add(body.phone, body.label);
  }

  @Delete('allowlist/:phone')
  removeAllowlist(@Param('phone') phone: string) {
    return this.allowlist.remove(phone);
  }

  /** Pousse les simPhoneNumber des trackers vers l'allowlist. */
  @Post('allowlist/sync')
  syncAllowlist() {
    return this.allowlist.syncFromTrackers();
  }

  /** Reconciliation : trackers non synces + numeros orphelins. */
  @Get('allowlist/status')
  allowlistStatus() {
    return this.allowlist.status();
  }
}
