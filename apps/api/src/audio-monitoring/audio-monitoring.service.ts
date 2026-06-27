import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
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
import { PrismaService } from '../prisma/prisma.service';

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
 * de clip (garde-fou #8 sans objet). Le rôle du serveur = GATE + AUDIT + (mock-)ARM
 * + renvoyer le numéro SIM à appeler.
 *
 * Le device est MOCKÉ : on ne dispatche JAMAIS vers un boîtier réel ici (la commande
 * d'armement Coban exacte est inconnue, cf. ANALYSE §2 → TODO explicite).
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
  ) {}

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

    // ARMEMENT MOCKÉ — on ne dispatche JAMAIS vers un boîtier réel ici.
    // TODO Scénario A: armer le mode monitor Coban (commande exacte à confirmer via
    // source Baanool, cf docs/sprint-4/ANALYSE.md §2) — ici dispatch mocké. Une fois
    // la commande connue : encoder + socket-registry.send + fallback SMS (le monitor
    // Coban s'arme par SMS), puis attendre la confirmation. JAMAIS vers prod tant que
    // le flag #2 n'est pas posé.
    const sent = await this.prisma.audioMonitoringCommand.update({
      where: { id: command.id },
      data: { status: AudioCommandStatus.SENT, sentAt: new Date() },
    });

    this.logger.log(
      { commandId: command.id, trackerId: tracker.id, fleetId, requestedBy: requestedBy.userId },
      'Audio listen armed (MOCKED dispatch — Scénario A appel live)',
    );

    // simPhoneNumber : le n° SIM du boîtier que l'admin doit APPELER pour entendre la
    // cabine (Scénario A). null possible (SIM non provisionnée) → l'UI le signale.
    return { command: sent, simPhoneNumber: tracker.simPhoneNumber };
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
    _actor: RequestedBy,
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
            context: { feature: 'audio-monitoring-activation', fleetId },
          }),
        ),
      );
      return new Date(); // horodatage RÉEL d'envoi (succès uniquement → audit #6 honnête)
    } catch (err) {
      this.logger.error(
        { fleetId, error: (err as Error).message },
        'Audio activation emails failed (activation conservée — best effort, stamp laissé null)',
      );
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
