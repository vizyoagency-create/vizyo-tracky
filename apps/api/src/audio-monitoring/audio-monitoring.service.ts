import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AudioCommandStatus,
  Prisma,
  UserRole,
  type AudioMonitoringCommand,
} from '@prisma/client';
import type {
  AudioCommandAuditDto,
  FleetAudioConfigDto,
  FleetAudioEligibilityDto,
} from '@vizyo/tracky-shared';
import { resolveTenantScope } from '../common/tenant-scope';
import type { Env } from '../config/env.validation';
import { EmailService } from '../email/email.service';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

/** requestedBy est une colonne String (UUID), pas une FK : on garde le même cast-guard
 *  que l'audit moteur avant de requêter prisma.user (sinon une valeur non-UUID casserait
 *  le cast uuid de Prisma). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** User n'a PAS de colonne `name` : on reconstruit le nom complet (comme user-activity). */
function fullName(u: { firstName?: string | null; lastName?: string | null }): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ') || 'Utilisateur';
}

/**
 * Sprint 4 — Service d'écoute audio à distance (micro embarqué). LÉGALEMENT CRITIQUE.
 *
 * Scénario A confirmé (cf. docs/sprint-4/ANALYSE.md §0) : l'« écoute » = le boîtier
 * OUVRE SON MICRO et le fleet-admin APPELLE la SIM pour entendre la cabine en direct.
 * Conséquence : AUCUN clip n'est uploadé au serveur, AUCUN stockage, AUCUNE rétention
 * de clip (garde-fou #8 sans objet). Le rôle du serveur = GATE + AUDIT + ARM (SMS réel)
 * + renvoyer le numéro SIM à appeler.
 *
 * ARMEMENT RÉEL (Coban GPS103 / Baanool = rebrand Coban) : l'écoute s'arme par SMS
 * `monitor<password>` envoyé à la SIM du boîtier → le boîtier passe en mode « monitor »
 * (micro ouvert) ; on rappelle ensuite la SIM pour entendre. Le désarmement renvoie
 * `tracker<password>` → retour mode « track ». ATTENTION (légalement + opérationnellement
 * sensible) : le mode monitor COUPE le report de position GPS, donc un véhicule laissé
 * armé « disparaît » de la carte → désarmement OBLIGATOIRE + filet auto-disarm (cron).
 *
 * Les garde-fous d'environnement (#2 flag prod, #3 super-admin bloqué en prod) sont
 * portés EN AMONT par AudioMonitoringGuard. La permission per-véhicule (#1 perm) est
 * portée par PermissionsGuard. Ce service porte : motif (#4), scope tenant fail-closed,
 * activation flotte (#1 config), audit avant dispatch (#7), attestation (#5), mail (#6).
 */
@Injectable()
export class AudioMonitoringService {
  private readonly logger = new Logger(AudioMonitoringService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
    private readonly errorLogger: ErrorLogger,
    // Sprint 4 — ARM/DISARM réel via la même passerelle SMS que le coupe-circuit
    // (EngineControlService) : `monitor<pwd>` / `tracker<pwd>` vers la SIM du boîtier.
    private readonly sms: SmsGatewayService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  /** Mot de passe boîtier Coban/Baanool (ARM `monitor<pwd>` / DISARM `tracker<pwd>`). */
  private devicePassword(): string {
    return this.config.get('AUDIO_DEVICE_PASSWORD', { infer: true });
  }

  /**
   * Déclenche une écoute (Scénario A : arme le micro pour un appel live).
   * Retourne la commande (audit) + le numéro SIM à appeler côté UI.
   */
  async requestListen(
    trackerId: string,
    reason: string,
    requestedBy: RequestedBy,
  ): Promise<{ command: AudioMonitoringCommand; simPhoneNumber: string | null }> {
    // (#4) Motif obligatoire — défense en profondeur au-delà du DTO @IsNotEmpty.
    const trimmedReason = (reason ?? '').trim();
    if (!trimmedReason) {
      throw new BadRequestException('Motif obligatoire pour déclencher une écoute.');
    }

    // Scope tenant (fail-closed) — filtre intégré au where : un non-SUPER_ADMIN ne
    // peut pas écouter le tracker d'une autre flotte en énumérant les trackerId.
    // Même pattern que EngineControlService.requestCommand (IDOR fix Sprint 6).
    const trackerWhere: Prisma.TrackerWhereInput = { id: trackerId };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Tracker introuvable');
      trackerWhere.vehicle = { fleetId: requestedBy.fleetId };
    }
    const tracker = await this.prisma.tracker.findFirst({
      where: trackerWhere,
      include: { vehicle: { include: { fleet: true } } },
    });
    if (!tracker) {
      throw new NotFoundException('Tracker introuvable');
    }
    if (!tracker.vehicle) {
      throw new BadRequestException('Tracker non associé à un véhicule');
    }

    const fleetId = tracker.vehicle.fleetId;

    // (#1) Activation flotte — gating à DEUX étages : l'écoute exige que la flotte soit
    // ÉLIGIBLE (N1 superAdminEnabled, posé par le prestataire) ET que le « Mode assistance »
    // soit consenti (N2 assistanceEnabled, posé par le fleet-admin). fail-closed : config
    // absente OU l'un des deux étages manquant ⇒ refus.
    const audioConfig = await this.prisma.fleetAudioConfig.findUnique({ where: { fleetId } });
    if (!audioConfig || !audioConfig.superAdminEnabled || !audioConfig.assistanceEnabled) {
      throw new ForbiddenException(
        'Écoute non disponible pour cette flotte (éligibilité ou mode assistance manquant).',
      );
    }

    // (#7) AUDIT AVANT DISPATCH — la ligne d'audit est créée AVANT toute tentative
    // d'armement, en PENDING : on garde une trace même si l'armement échoue ensuite.
    const requestedInEnv = this.config.get('NODE_ENV', { infer: true });
    const command = await this.prisma.audioMonitoringCommand.create({
      data: {
        trackerId: tracker.id,
        vehicleId: tracker.vehicle.id,
        fleetId,
        status: AudioCommandStatus.PENDING,
        reason: trimmedReason,
        requestedBy: requestedBy.userId,
        requestedByRole: requestedBy.role,
        requestedInEnv,
        source: 'MANUAL',
      },
    });

    // ARMEMENT RÉEL — envoie `monitor<password>` à la SIM du boîtier (mode monitor Coban,
    // micro ouvert). MÊME passerelle que le coupe-circuit (EngineControlService) qui envoie
    // `stop123456`/`resume123456` — convention de mot de passe identique. ⚠️ ce SMS RÉEL part
    // vers un BOÎTIER RÉEL : tout le gating amont reste la seule barrière (guard #2/#3, rôle,
    // permission per-véhicule, gating flotte 2 étages).
    //
    // Toute défaillance du chemin d'armement (SMS désactivé, SIM absente, refus passerelle,
    // erreur système) marque la commande FAILED + lastError + alimente le centre d'alertes
    // (source 'audio-monitoring', niveau CRITICAL). Les refus de validation attendus
    // (404/403/400 ci-dessus) sont levés AVANT ce bloc → jamais loggés comme alertes.
    const alertCtx = {
      trackerId,
      commandId: command.id,
      vehicleId: tracker.vehicle.id,
      fleetId,
      userId: requestedBy.userId,
      reason: trimmedReason,
    };

    // Pré-requis du chemin SMS : passerelle active ET SIM connue. Sinon on NE peut PAS
    // armer le micro → FAILED + alerte + 503 (le mock historique est supprimé).
    if (!this.sms.isEnabled() || !tracker.simPhoneNumber) {
      const lastError = !this.sms.isEnabled()
        ? 'Passerelle SMS désactivée — armement micro impossible'
        : 'SIM non provisionnée — aucun numéro pour armer le micro';
      await this.prisma.audioMonitoringCommand
        .update({ where: { id: command.id }, data: { status: AudioCommandStatus.FAILED, lastError } })
        .catch(() => {});
      await this.errorLogger
        .record(lastError, 'audio-monitoring', alertCtx, 'CRITICAL')
        .catch(() => {});
      throw new ServiceUnavailableException('Passerelle SMS indisponible ou SIM absente');
    }

    let sent: AudioMonitoringCommand;
    try {
      const pwd = this.devicePassword();
      const r = await this.sms.send(tracker.simPhoneNumber, 'monitor' + pwd, {
        imei: tracker.imei,
        commandId: command.id,
        template: 'audio_arm', source: 'audio-monitor',
      });
      if (!r.ok) {
        const lastError = `Échec armement micro (SMS monitor) : ${r.error ?? 'refus passerelle'}`;
        await this.prisma.audioMonitoringCommand
          .update({ where: { id: command.id }, data: { status: AudioCommandStatus.FAILED, lastError } })
          .catch(() => {});
        await this.errorLogger.record(lastError, 'audio-monitoring', alertCtx, 'CRITICAL').catch(() => {});
        throw new ServiceUnavailableException("Échec de l'armement du micro (passerelle SMS)");
      }
      // ARMÉ : SENT + sentAt. disarmedAt reste null → ligne « armée » ciblée par le DISARM
      // manuel (/stop) et le filet auto-disarm (cron).
      sent = await this.prisma.audioMonitoringCommand.update({
        where: { id: command.id },
        data: { status: AudioCommandStatus.SENT, sentAt: new Date() },
      });
    } catch (err) {
      // Un ServiceUnavailableException ci-dessus a déjà été tracé (FAILED + alerte) → on le
      // relance tel quel. Tout AUTRE throw (DB indisponible, etc.) est une panne système :
      // best-effort FAILED + alerte CRITICAL puis re-throw.
      if (err instanceof ServiceUnavailableException) throw err;
      const lastError = err instanceof Error ? err.message : String(err);
      await this.prisma.audioMonitoringCommand
        .update({ where: { id: command.id }, data: { status: AudioCommandStatus.FAILED, lastError } })
        .catch(() => {});
      await this.errorLogger
        .record(err instanceof Error ? err : new Error(lastError), 'audio-monitoring', alertCtx, 'CRITICAL')
        .catch(() => {});
      throw err;
    }

    this.logger.log(
      { commandId: command.id, trackerId: tracker.id, fleetId, requestedBy: requestedBy.userId },
      'Audio listen armed (SMS monitor envoyé — Scénario A appel live)',
    );

    // simPhoneNumber : le n° SIM du boîtier que l'admin doit APPELER pour entendre la
    // cabine (Scénario A). Toujours non-null ici (le chemin null a été rejeté plus haut).
    return { command: sent, simPhoneNumber: tracker.simPhoneNumber };
  }

  /**
   * Sprint 4 — DISARM : renvoie le boîtier en mode « track » (SMS `tracker<password>`) et
   * pose `disarmedAt` sur l'écoute armée la plus récente du tracker. CRITIQUE : le mode
   * monitor coupe le report GPS, donc désarmer remet le véhicule « visible » sur la carte.
   *
   * Tenant : un non-SUPER_ADMIN ne peut désarmer qu'un tracker de SA flotte (where filtré,
   * comme requestListen). Échec d'envoi → alerte (centre d'alertes) MAIS on n'empêche pas
   * d'enregistrer la tentative — l'opérateur doit savoir que le désarmement a échoué.
   */
  async stopListen(
    trackerId: string,
    actor: RequestedBy,
  ): Promise<{ ok: boolean; simPhoneNumber: string | null }> {
    const trackerWhere: Prisma.TrackerWhereInput = { id: trackerId };
    if (actor.role !== UserRole.SUPER_ADMIN) {
      if (!actor.fleetId) throw new NotFoundException('Tracker introuvable');
      trackerWhere.vehicle = { fleetId: actor.fleetId };
    }
    const tracker = await this.prisma.tracker.findFirst({
      where: trackerWhere,
      select: { id: true, imei: true, simPhoneNumber: true, vehicle: { select: { id: true, fleetId: true } } },
    });
    if (!tracker) {
      throw new NotFoundException('Tracker introuvable');
    }

    const alertCtx = {
      trackerId,
      vehicleId: tracker.vehicle?.id,
      fleetId: tracker.vehicle?.fleetId,
      userId: actor.userId,
    };

    if (!this.sms.isEnabled() || !tracker.simPhoneNumber) {
      const lastError = !this.sms.isEnabled()
        ? 'Passerelle SMS désactivée — désarmement micro impossible'
        : 'SIM non provisionnée — aucun numéro pour désarmer le micro';
      await this.errorLogger.record(lastError, 'audio-monitoring', alertCtx, 'CRITICAL').catch(() => {});
      throw new ServiceUnavailableException('Passerelle SMS indisponible ou SIM absente');
    }

    let ok = false;
    try {
      const pwd = this.devicePassword();
      const r = await this.sms.send(tracker.simPhoneNumber, 'tracker' + pwd, {
        imei: tracker.imei,
        template: 'audio_disarm', source: 'audio-disarm',
      });
      ok = r.ok;
      if (!r.ok) {
        await this.errorLogger
          .record(
            `Échec désarmement micro (SMS tracker) : ${r.error ?? 'refus passerelle'}`,
            'audio-monitoring',
            alertCtx,
            'CRITICAL',
          )
          .catch(() => {});
      }
    } catch (err) {
      await this.errorLogger
        .record(err instanceof Error ? err : new Error(String(err)), 'audio-monitoring', alertCtx, 'CRITICAL')
        .catch(() => {});
      throw err;
    }

    // Pose disarmedAt sur l'écoute armée la plus récente (SENT + disarmedAt null) de ce
    // tracker. updateMany borné au plus récent via une sous-requête d'id (Prisma n'autorise
    // pas orderBy+limit sur updateMany) ; si aucune ligne armée, no-op (désarmement quand
    // même envoyé — utile pour « forcer » un boîtier qu'on croit encore en monitor).
    const armed = await this.prisma.audioMonitoringCommand.findFirst({
      where: { trackerId: tracker.id, status: AudioCommandStatus.SENT, disarmedAt: null },
      orderBy: { sentAt: 'desc' },
      select: { id: true },
    });
    if (armed) {
      await this.prisma.audioMonitoringCommand.update({
        where: { id: armed.id },
        data: { disarmedAt: new Date() },
      });
    }

    this.logger.log(
      { trackerId: tracker.id, ok, disarmedCommandId: armed?.id ?? null },
      'Audio listen disarmed (SMS tracker envoyé — retour mode track)',
    );

    return { ok, simPhoneNumber: tracker.simPhoneNumber };
  }

  /**
   * État d'activation de l'écoute audio POUR UNE FLOTTE — lecture (écran d'activation).
   * Tenant-checké comme `setFleetAssistanceMode` : un FLEET_ADMIN ne lit QUE sa propre
   * flotte (sauf SUPER_ADMIN). fail-closed : config absente ⇒ les deux étages false + nulls.
   */
  async getFleetAudioConfig(fleetId: string, actor: RequestedBy): Promise<FleetAudioConfigDto> {
    // Tenant — un FLEET_ADMIN ne peut consulter que SA flotte.
    if (actor.role !== UserRole.SUPER_ADMIN && actor.fleetId !== fleetId) {
      throw new ForbiddenException('Vous ne pouvez consulter que votre propre flotte.');
    }

    const config = await this.prisma.fleetAudioConfig.findUnique({ where: { fleetId } });
    if (!config) {
      // fail-closed : aucune config ⇒ ni éligible ni consenti, aucune attestation/mail.
      return {
        superAdminEnabled: false,
        assistanceEnabled: false,
        attestedAt: null,
        attestationVersion: null,
        activationEmailSentAt: null,
      };
    }

    return {
      superAdminEnabled: config.superAdminEnabled,
      assistanceEnabled: config.assistanceEnabled,
      attestedAt: config.attestedAt ? config.attestedAt.toISOString() : null,
      attestationVersion: config.attestationVersion,
      activationEmailSentAt: config.activationEmailSentAt
        ? config.activationEmailSentAt.toISOString()
        : null,
    };
  }

  /**
   * N1 — ÉLIGIBILITÉ de la flotte (super-admin/prestataire). Décide si la flotte est
   * AUTORISÉE à voir/activer le « Mode assistance ». OFF par défaut.
   * - `eligible=true`  : la flotte devient éligible (le fleet-admin pourra consentir N2).
   * - `eligible=false` : cascade « tout OFF » — on remet AUSSI le consentement N2
   *   assistanceEnabled à false (retirer l'éligibilité coupe toute écoute possible).
   * Tenant : N1 est une décision PRESTATAIRE (le controller restreint déjà à SUPER_ADMIN).
   */
  async setFleetEligibility(
    fleetId: string,
    eligible: boolean,
    actor: RequestedBy,
  ): Promise<FleetAudioConfigDto> {
    // eligible=false ⇒ cascade : on force AUSSI assistanceEnabled=false (tout OFF).
    const config = await this.prisma.fleetAudioConfig.upsert({
      where: { fleetId },
      create: {
        fleetId,
        superAdminEnabled: eligible,
        assistanceEnabled: false,
      },
      update: {
        superAdminEnabled: eligible,
        ...(eligible ? {} : { assistanceEnabled: false }),
      },
    });

    // Feature LÉGALEMENT CRITIQUE : on trace QUI a rendu la flotte éligible à
    // l'écoute micro (ou l'a coupée) — l'upsert ne garde que l'état courant.
    this.systemActivity.record({
      category: 'AUDIO',
      action: 'fleet_eligibility_set',
      status: 'SUCCESS',
      actor: 'utilisateur',
      detail: eligible ? 'Flotte rendue ÉLIGIBLE à l\'écoute audio (N1)' : 'Éligibilité RETIRÉE (cascade : consentement N2 coupé)',
      fleetId,
      triggeredByUserId: actor.userId,
      meta: { eligible },
    });

    return {
      superAdminEnabled: config.superAdminEnabled,
      assistanceEnabled: config.assistanceEnabled,
      attestedAt: config.attestedAt ? config.attestedAt.toISOString() : null,
      attestationVersion: config.attestationVersion,
      activationEmailSentAt: config.activationEmailSentAt
        ? config.activationEmailSentAt.toISOString()
        : null,
    };
  }

  /**
   * N2 — CONSENTEMENT « Mode assistance » de la flotte (fleet-admin) (garde-fous #1+#5+#6).
   * - Tenant : un FLEET_ADMIN ne configure QUE sa propre flotte (sauf SUPER_ADMIN).
   * - ÉLIGIBILITÉ (N1) requise : si la flotte n'est pas superAdminEnabled ⇒ Forbidden
   *   (le prestataire doit d'abord l'autoriser).
   * - Activer (assistanceEnabled=true) EXIGE l'attestation (#5) → sinon BadRequest.
   * - À l'activation : mail OBLIGATIONS à tous les users actifs de la flotte (#6),
   *   SAUF si l'acteur est SUPER_ADMIN (bascule technique de test → pas de notif).
   */
  async setFleetAssistanceMode(
    fleetId: string,
    dto: { assistanceEnabled: boolean; attestation?: boolean; attestationVersion?: string },
    actor: RequestedBy,
  ): Promise<FleetAudioConfigDto> {
    // Tenant — un FLEET_ADMIN ne peut configurer que SA flotte.
    if (actor.role !== UserRole.SUPER_ADMIN && actor.fleetId !== fleetId) {
      throw new ForbiddenException('Vous ne pouvez configurer que votre propre flotte.');
    }

    // (N1) Éligibilité requise — la flotte doit avoir été autorisée par le prestataire.
    // fail-closed : config absente ⇒ non éligible ⇒ refus.
    const existing = await this.prisma.fleetAudioConfig.findUnique({ where: { fleetId } });
    if (!existing?.superAdminEnabled) {
      throw new ForbiddenException("Flotte non éligible — le prestataire doit l'autoriser.");
    }

    // (#5) Activer sans attestation est refusé.
    if (dto.assistanceEnabled === true && dto.attestation !== true) {
      throw new BadRequestException("Attestation requise pour activer l'écoute audio.");
    }

    const now = new Date();
    const willEnable = dto.assistanceEnabled === true;

    // Trace du consentement N2 (activation ET désactivation — le disable ne
    // laissait aucune trace alors que l'enable écrit attestedByUserId).
    this.systemActivity.record({
      category: 'AUDIO',
      action: 'assistance_mode_set',
      status: 'SUCCESS',
      actor: 'utilisateur',
      detail: willEnable
        ? `Mode assistance ACTIVÉ (consentement N2, attestation ${dto.attestationVersion ?? 'v?'})`
        : 'Mode assistance DÉSACTIVÉ',
      fleetId,
      triggeredByUserId: actor.userId,
      meta: { assistanceEnabled: willEnable, attestationVersion: dto.attestationVersion ?? null },
    });

    // Upsert de la config. On ne pose l'attestation que si on (ré)active.
    const config = await this.prisma.fleetAudioConfig.upsert({
      where: { fleetId },
      create: {
        fleetId,
        superAdminEnabled: true, // éligibilité déjà vérifiée ci-dessus
        assistanceEnabled: willEnable,
        attestedByUserId: willEnable ? actor.userId : null,
        attestedAt: willEnable ? now : null,
        attestationVersion: willEnable ? (dto.attestationVersion ?? null) : null,
      },
      update: {
        assistanceEnabled: willEnable,
        ...(willEnable
          ? {
              attestedByUserId: actor.userId,
              attestedAt: now,
              attestationVersion: dto.attestationVersion ?? null,
            }
          : {}),
      },
    });

    let activationEmailSentAt = config.activationEmailSentAt;

    // (#6) À l'activation : mail OBLIGATIONS à tous les users actifs de la flotte.
    // Sprint 4 — phase de test interne : on N'ENVOIE PAS le mail quand l'acteur est
    // SUPER_ADMIN. Une activation super-admin/prestataire est une bascule technique
    // de test et ne doit PAS notifier la flotte ; le mail OBLIGATIONS (#6) est réservé
    // à un véritable onboarding fleet-admin/client. Dans ce cas activationEmailSentAt
    // reste null (on ne prétend pas avoir notifié la flotte).
    if (willEnable && actor.role !== UserRole.SUPER_ADMIN) {
      activationEmailSentAt = await this.sendActivationEmails(fleetId, actor.userId);
      await this.prisma.fleetAudioConfig.update({
        where: { fleetId },
        data: { activationEmailSentAt },
      });
    }

    return {
      superAdminEnabled: config.superAdminEnabled,
      assistanceEnabled: config.assistanceEnabled,
      attestedAt: config.attestedAt ? config.attestedAt.toISOString() : null,
      attestationVersion: config.attestationVersion,
      activationEmailSentAt: activationEmailSentAt ? activationEmailSentAt.toISOString() : null,
    };
  }

  /**
   * Sprint 4 — Envoi À LA DEMANDE du mail d'INFORMATION « Mode assistance » à un
   * utilisateur (typiquement un fleet-admin, ex: onboarding client). Présente la fonction
   * AVANT activation. SUPER_ADMIN only (le controller restreint déjà via @Roles).
   *
   * Charge l'utilisateur (+ nom de sa flotte), construit le template buildAudioInfoEmail
   * et l'envoie. EmailService est no-op sans clé RESEND → l'envoi « réussit » silencieusement
   * en local/test (aucun vrai mail). Un ÉCHEC d'envoi (clé présente mais provider KO) est
   * VISIBLE au centre d'alertes (source 'audio-monitoring', niveau ERROR).
   */
  async sendAudioInfoMail(
    userId: string,
    actor: RequestedBy,
  ): Promise<{ ok: boolean; sentTo: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        fleet: { select: { name: true } },
      },
    });
    if (!user) {
      throw new NotFoundException('Utilisateur introuvable');
    }

    const template = this.email.buildAudioInfoEmail({
      recipientName: fullName(user),
      fleetName: user.fleet?.name ?? 'votre flotte',
    });

    const result = await this.email.send({
      to: user.email,
      subject: template.subject,
      html: template.html,
      text: template.text,
      template: 'audio_info',
      context: { feature: 'audio-info', userId: user.id, requestedByUserId: actor.userId },
    });

    // Échec d'envoi (provider KO) → trace au centre d'alertes (ERROR). On NE casse PAS la
    // requête : best-effort comme le mail OBLIGATIONS (#6) — l'opérateur voit l'échec.
    if (!result.ok) {
      await this.errorLogger
        .record(
          `Échec envoi mail info « Mode assistance » : ${result.error ?? 'erreur inconnue'}`,
          'audio-monitoring',
          { userId: user.id, actorUserId: actor.userId, reason: 'audio-info-mail-failed' },
          'ERROR',
        )
        .catch(() => {});
    }

    this.logger.log(
      { userId: user.id, sentTo: user.email, by: actor.userId, ok: result.ok },
      'Audio info mail dispatched (Mode assistance — info à la demande)',
    );

    return { ok: true, sentTo: user.email };
  }

  /**
   * Vue super-admin « éligibilité audio » : TOUTES les flottes avec leur état sur les
   * deux étages (left-join fleets ⟕ FleetAudioConfig ; config absente ⇒ both false).
   * Triée par nom de flotte. Réservée au SUPER_ADMIN (controller @Roles).
   */
  async getFleetsWithAudio(_actor: RequestedBy): Promise<FleetAudioEligibilityDto[]> {
    const fleets = await this.prisma.fleet.findMany({
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        audioConfig: { select: { superAdminEnabled: true, assistanceEnabled: true } },
      },
    });

    return fleets.map((f) => ({
      fleetId: f.id,
      fleetName: f.name,
      superAdminEnabled: f.audioConfig?.superAdminEnabled ?? false,
      assistanceEnabled: f.audioConfig?.assistanceEnabled ?? false,
    }));
  }

  /** (#6) Envoie le mail OBLIGATIONS à tous les users actifs de la flotte. Retourne
   *  l'horodatage d'envoi (best-effort : un échec mail ne casse pas l'activation). */
  private async sendActivationEmails(fleetId: string, actorUserId: string): Promise<Date | null> {
    try {
      const [fleet, users, actor] = await Promise.all([
        this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { name: true } }),
        this.prisma.user.findMany({
          where: { fleetId, isActive: true },
          select: { email: true },
        }),
        this.prisma.user.findUnique({
          where: { id: actorUserId },
          select: { firstName: true, lastName: true },
        }),
      ]);

      const template = this.email.buildAudioActivationEmail({
        fleetName: fleet?.name ?? 'votre flotte',
        activatedBy: actor ? fullName(actor) : 'un administrateur',
      });

      await Promise.all(
        users.map((u) =>
          this.email.send({
            to: u.email,
            subject: template.subject,
            html: template.html,
            text: template.text,
            template: 'audio_activation',
            context: { feature: 'audio-monitoring-activation', fleetId, requestedByUserId: actorUserId },
          }),
        ),
      );
      return new Date(); // horodatage RÉEL d'envoi (succès uniquement → audit #6 honnête)
    } catch (err) {
      this.logger.error(
        { fleetId, error: (err as Error).message },
        'Audio activation emails failed (activation conservée — best effort, stamp laissé null)',
      );
      // (#6) Un échec d'envoi du mail OBLIGATIONS est légalement sensible : il doit être
      // VISIBLE au centre d'alertes (niveau ERROR), même si l'activation est conservée.
      await this.errorLogger
        .record(
          err instanceof Error ? err : new Error(String(err)),
          'audio-monitoring',
          { fleetId, userId: actorUserId, reason: 'activation-email-failed' },
          'ERROR',
        )
        .catch(() => {});
      return null; // échec : on NE prétend PAS avoir notifié la flotte (#6 honnête)
    }
  }

  /**
   * Audit des commandes d'écoute (qui/quand/véhicule/motif) — vue admin paginée.
   * Tenant-scopé (fail-closed) : SUPER_ADMIN voit tout ; FLEET_ADMIN sa flotte ;
   * DENY (non-super sans flotte) ⇒ vide. requestedBy résolu comme l'audit moteur.
   */
  async getAudit(
    filters: { limit?: number; before?: string; status?: string },
    requester: RequestedBy,
  ): Promise<AudioCommandAuditDto[]> {
    const take = Math.min(Math.max(filters.limit ?? 50, 1), 200);

    const where: Prisma.AudioMonitoringCommandWhereInput = {};

    // fail-closed via resolveTenantScope.
    const scope = resolveTenantScope(requester);
    if (scope.mode === 'DENY') return [];
    if (scope.mode === 'FLEET') where.fleetId = scope.fleetId;

    if (
      filters.status === 'PENDING' ||
      filters.status === 'SENT' ||
      filters.status === 'ACKNOWLEDGED' ||
      filters.status === 'FAILED' ||
      filters.status === 'REJECTED'
    ) {
      where.status = filters.status;
    }
    if (filters.before) {
      const d = new Date(filters.before);
      if (!Number.isNaN(d.getTime())) where.createdAt = { lt: d };
    }

    const commands = await this.prisma.audioMonitoringCommand.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        tracker: { select: { imei: true, vehicle: { select: { plate: true } } } },
      },
    });

    // Résolution du demandeur : seules les valeurs UUID-like sont requêtables.
    const validIds = [
      ...new Set(commands.map((c) => c.requestedBy).filter((id) => UUID_RE.test(id))),
    ];
    const users = validIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: validIds } },
          select: { id: true, firstName: true, lastName: true, role: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    return commands.map((c) => {
      const u = userById.get(c.requestedBy);
      return {
        id: c.id,
        action: 'LISTEN' as const,
        status: c.status as AudioCommandAuditDto['status'],
        vehiclePlate: c.tracker.vehicle?.plate ?? null,
        trackerImei: c.tracker.imei,
        requestedByName: u ? fullName(u) : 'Système',
        requestedByRole: u?.role ?? c.requestedByRole ?? null,
        requestedInEnv: c.requestedInEnv,
        reason: c.reason,
        source: c.source,
        lastError: c.lastError,
        createdAt: c.createdAt.toISOString(),
        sentAt: c.sentAt ? c.sentAt.toISOString() : null,
      };
    });
  }
}
