import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TrackerCommandStatus, UserRole } from '@prisma/client';
import type { TrackerCommand } from '@prisma/client';
import {
  findTemplate,
  COBAN_COMMAND_CATALOG,
  DORMANT_STOP_ACTING_MS,
  formatSilenceLabel,
  isVehicleDormant,
} from '@vizyo/tracky-shared';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { resolveTenantScope } from '../common/tenant-scope';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { SmsGatewayService } from '../sms/sms-gateway.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { AckWaiterService } from './ack-waiter.service';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

/**
 * Sous-commandes émises par la surveillance antivol (arm/disarm). Elles ont DÉJÀ
 * leur propre ligne catégorie SURVEILLANCE (avec la bonne attribution planning vs
 * utilisateur + anti-flood) → on ne double PAS avec une ligne TRACKER_CMD, sinon le
 * scheduler EVERY_MINUTE d'un tracker offline inonderait le journal (2 lignes/min).
 * TRACKER_CMD reste réservé aux vraies commandes autonomes (fix interval, reboot…).
 */
const SURVEILLANCE_TEMPLATES = new Set(['sensitivity', 'shock_on', 'shock_off']);

@Injectable()
export class TrackerCommandsService {
  private readonly logger = new Logger(TrackerCommandsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: SocketRegistryService,
    private readonly ackWaiter: AckWaiterService,
    private readonly wireLogger: CobanWireLogger,
    private readonly gateway: RealtimeGateway,
    private readonly systemActivity: SystemActivityService,
    // Le canal SMS n'est pas un repli exotique : c'est le SEUL que ces boitiers ecoutent pour
    // 19 gabarits du catalogue, dont les trois du capteur de choc. Cf. le commentaire de
    // `dispatch()` et la mesure qui l'appuie.
    private readonly sms: SmsGatewayService,
  ) {}

  async request(
    trackerId: string,
    templateId: string,
    params: Record<string, unknown>,
    scheduledAt: Date | null,
    requestedBy: RequestedBy,
  ): Promise<TrackerCommand> {
    if (templateId === 'engine_stop' || templateId === 'engine_resume') {
      throw new BadRequestException(
        'Les commandes moteur sont exclusives à /engine-control. Utilisez le bouton dédié.',
      );
    }

    const template = findTemplate(templateId);
    if (!template) {
      throw new BadRequestException(`Template inconnu: ${templateId}`);
    }

    if (template.requiresSuperAdmin && requestedBy.role !== UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Cette commande nécessite le rôle SUPER_ADMIN');
    }

    const tracker = await this.prisma.tracker.findUnique({
      where: { id: trackerId },
      include: { vehicle: true },
    });
    if (!tracker) throw new NotFoundException('Tracker introuvable');
    if (!tracker.vehicle) throw new BadRequestException('Tracker non associé à un véhicule');

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (tracker.vehicle.fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Accès refusé à cette flotte');
      }
    }

    // Validate params
    for (const spec of template.params) {
      if (spec.required && (params[spec.name] === undefined || params[spec.name] === '')) {
        throw new BadRequestException(`Paramètre requis manquant: ${spec.name}`);
      }
      if (spec.validate && params[spec.name] !== undefined) {
        const err = spec.validate(params[spec.name]);
        if (err) throw new BadRequestException(`${spec.name}: ${err}`);
      }
    }

    // ─── PORTE « BOÎTIER MUET » (seuil AGIR = 72 h) ────────────────────────────
    // Dernier rempart avant l'écriture : quel que soit l'appelant (bouton admin,
    // armement antivol, script), on n'écrit PAS une commande immédiate destinée à un
    // boîtier qui ne parle plus depuis 3 jours. Sans cette porte, le chemin nominal
    // était : create(PENDING) → dispatch → registry.send() échoue → update(FAILED) →
    // 503. Soit 1 ligne morte + 2 écritures + 1 entrée de journal PAR TENTATIVE,
    // répétées à l'infini par les appelants automatiques (cf. le scheduler antivol).
    //
    // On refuse AVANT le `create` : sortie sèche, aucune ligne persistée. Le message
    // porte la durée exacte du silence — l'opérateur comprend qu'il s'agit d'une
    // intervention physique (alimentation / SIM / boîtier déposé), pas d'un retry.
    //
    // `scheduledAt` est volontairement ÉPARGNÉ : programmer une commande pour plus tard
    // reste légitime sur un boîtier muet aujourd'hui (il peut être réparé d'ici là).
    // ⚠️ Le dépilage passe par `dispatch()` DIRECTEMENT (cf. TrackerCommandsSchedulerService),
    // donc sans cette porte : c'est assumé. Une commande planifiée n'est tentée QU'UNE
    // FOIS (l'échec la fige en FAILED, elle ne ressort plus du `where SCHEDULED`) — un
    // coup isolé, pas la boucle infinie que cette porte combat. `dispatch()` ne reçoit
    // d'ailleurs que l'IMEI : y lire `lastSeenAt` coûterait une requête de plus par envoi.
    // Aucun historique n'est masqué : les commandes passées restent consultables.
    if (
      !scheduledAt &&
      isVehicleDormant(
        { trackerId: tracker.id, lastSeenAt: tracker.lastSeenAt },
        Date.now(),
        DORMANT_STOP_ACTING_MS,
      )
    ) {
      throw new ServiceUnavailableException(
        `Boîtier muet depuis ${formatSilenceLabel(tracker.lastSeenAt)} — commande non envoyée. ` +
          'Vérifier alimentation, carte SIM ou présence du boîtier ; les commandes reprendront ' +
          'automatiquement dès la première trame reçue.',
      );
    }

    const payload = template.buildPayload(tracker.imei, params);

    const command = await this.prisma.trackerCommand.create({
      data: {
        trackerId,
        templateId,
        category: template.category,
        params: params as any,
        payload,
        status: scheduledAt ? TrackerCommandStatus.SCHEDULED : TrackerCommandStatus.PENDING,
        scheduledAt,
        requestedBy: requestedBy.userId,
      },
    });

    this.logger.log(
      { commandId: command.id, imei: tracker.imei, templateId, payload },
      'Command created',
    );

    if (!scheduledAt) {
      await this.dispatch(command, tracker.imei, tracker.vehicle.fleetId);
    }

    return command;
  }

  /**
   * Envoie une commande au tracker via TCP.
   *
   * Securite : `imei` et `fleetId` sont fournis par le caller, qui est
   * responsable d'avoir valide le tenant en amont (recuperer le tracker via
   * une route qui applique le filtre tenant, puis passer ses champs). On
   * evite ainsi un lookup tracker.id non scope qui pourrait reveler des
   * donnees cross-fleet via un commandId enumere.
   *
   * `fleetId` accepte `null` pour les trackers orphelins (sans vehicle attache,
   * ex: provisioning) — dans ce cas le broadcast WS est skip.
   */
  async dispatch(command: TrackerCommand, imei: string, fleetId: string | null): Promise<void> {
    const resolvedImei = imei;
    const resolvedFleetId = fleetId ?? '';

    // ══ LE CANAL EST UNE PROPRIÉTÉ DE LA COMMANDE, PAS UNE CONSTANTE ═══════════════
    //
    // ⚠️ CONSTAT DU 2026-08-20, mesuré et non supposé. Cette méthode envoyait TOUT par
    // `registry.send()`, c'est-à-dire en TCP, sans jamais lire `template.availableVia` —
    // alors que 19 gabarits du catalogue le déclarent `['sms']`, dont les trois du capteur
    // de choc, avec un commentaire qui annonçait exactement ce qu'on observe.
    //
    // Ce que la mesure a montré, dans les deux sens :
    //
    //   625 155 trames TCP entrantes en 4 jours, 39 boîtiers  ->  ZÉRO accusé de réception.
    //   Des SMS entrants « fix ok », « admin ok! », « Resume engine Succeed ».
    //
    // « fix ok » est EXACTEMENT le motif attendu par le guetteur, et sur lequel il expirait
    // depuis 4 769 commandes. Ces boîtiers répondent — mais par SMS.
    //
    // Conséquence concrète : le capteur de choc n'a JAMAIS pu être armé (17 tentatives, toutes
    // expirées), donc aucune alerte ACCIDENT n'a jamais pu exister. La correspondance était
    // correcte depuis le début ; elle n'avait simplement rien à traduire.
    const template = findTemplate(command.templateId);
    if (template && !template.availableVia.includes('tcp')) {
      await this.dispatchParSms(command, template, resolvedImei, fleetId);
      return;
    }

    // #20 — passe par registry.send() (verifie destroyed + writable + try/catch +
    // nettoie l'entree morte) au lieu d'ecrire directement sur la socket : une
    // socket demi-morte ne doit pas etre marquee SENT en laissant fuiter l'entree.
    const sentOk = this.registry.send(resolvedImei, command.payload);
    if (!sentOk) {
      await this.prisma.trackerCommand.update({
        where: { id: command.id },
        data: { status: TrackerCommandStatus.FAILED, lastError: 'Tracker offline' },
      });
      this.emitUpdate(command.id, resolvedFleetId);
      // Journal Système — couvre le scheduler 30s et les commandes manuelles.
      // L'échec (tracker offline) est le cas clé : une commande planifiée qui ne
      // part jamais serait sinon invisible. Les sous-commandes surveillance sont
      // exclues (déjà tracées en SURVEILLANCE, cf. SURVEILLANCE_TEMPLATES).
      if (!SURVEILLANCE_TEMPLATES.has(command.templateId)) {
        this.systemActivity.record({
          category: 'TRACKER_CMD',
          action: 'tracker_command_sent',
          status: 'FAILURE',
          actor: command.scheduledAt ? 'planning' : 'utilisateur',
          target: resolvedImei,
          detail: `${command.templateId} — tracker hors ligne`,
          fleetId: fleetId,
          triggeredByUserId: command.requestedBy,
          meta: { error: 'Tracker offline', commandId: command.id },
        });
      }
      throw new ServiceUnavailableException('Tracker hors ligne, commande non envoyée');
    }

    // #36 — capture sentAt localement (l'objet `command` en memoire n'est PAS mis
    // a jour par le prisma.update) pour calculer une vraie latence d'ACK plus bas.
    const sentAt = new Date();
    await this.prisma.trackerCommand.update({
      where: { id: command.id },
      data: { status: TrackerCommandStatus.SENT, sentAt },
    });

    this.wireLogger.out(resolvedImei, command.payload, {
      commandId: command.id,
      source: 'tracker-cmd',
    });

    this.emitUpdate(command.id, resolvedFleetId);

    if (!SURVEILLANCE_TEMPLATES.has(command.templateId)) {
      this.systemActivity.record({
        category: 'TRACKER_CMD',
        action: 'tracker_command_sent',
        status: 'SUCCESS',
        actor: command.scheduledAt ? 'planning' : 'utilisateur',
        target: resolvedImei,
        detail: command.templateId,
        fleetId: fleetId,
        triggeredByUserId: command.requestedBy,
        meta: { commandId: command.id },
      });
    }

    // Background ACK wait
    if (template && template.expectedAckPattern) {
      this.ackWaiter
        .waitForAck(resolvedImei, template.expectedAckPattern, template.ackTimeoutMs, command.id)
        .then(async (rawAck) => {
          const latencyMs = Date.now() - sentAt.getTime();
          this.wireLogger.ackMatch(resolvedImei, rawAck, command.id, latencyMs);
          await this.prisma.trackerCommand.update({
            where: { id: command.id },
            data: {
              status: TrackerCommandStatus.ACKNOWLEDGED,
              ackedAt: new Date(),
              ackResponse: rawAck,
            },
          });
          this.emitUpdate(command.id, resolvedFleetId);
        })
        .catch(async (err) => {
          this.wireLogger.ackTimeout(
            resolvedImei,
            command.id,
            template.expectedAckPattern.source,
            template.ackTimeoutMs,
          );
          await this.prisma.trackerCommand.update({
            where: { id: command.id },
            data: {
              status: TrackerCommandStatus.FAILED,
              lastError: `ACK timeout: ${(err as Error).message}`,
            },
          });
          this.emitUpdate(command.id, resolvedFleetId);
        });
    }
  }

  /**
   * Envoi d'une commande que le boîtier n'accepte QUE par SMS.
   *
   * ── Trois différences avec le TCP, et aucune n'est cosmétique ────────────────────────
   *
   * 1. **On n'attend PAS d'accusé ici.** Mesuré en production : `resume123456` envoyé le
   *    19/08 à 04 h 39, réponse « Resume engine Succeed » du boîtier à 08 h 28 — presque
   *    QUATRE HEURES. Un guetteur de 15 secondes ne ferait que fabriquer un faux échec sur
   *    une commande qui a parfaitement abouti. La commande reste donc `SENT` : c'est la
   *    vérité (« partie, réponse pas encore revenue »), et le webhook SMS entrant la passera
   *    en `ACKNOWLEDGED` quand la réponse arrivera.
   *
   * 2. **`SENT` ne veut pas dire « livré », et c'est assumé.** La passerelle rend `queued`
   *    et ne réconcilie jamais le statut final : les 102 SMS sortants du mois sont tous
   *    `queued`, alors qu'au moins un est prouvé livré (le boîtier a répondu). Un `queued`
   *    éternel est un défaut d'OBSERVABILITÉ, pas de livraison — ne pas le confondre.
   *
   * 3. **Le boîtier n'a pas besoin d'être en ligne.** C'est même l'intérêt : un boîtier muet
   *    en TCP reste joignable par SMS. La garde « tracker hors ligne » du chemin TCP n'a donc
   *    pas lieu d'être ici.
   */
  private async dispatchParSms(
    command: TrackerCommand,
    template: { id: string; expectedAckPattern?: RegExp },
    imei: string,
    fleetId: string | null,
  ): Promise<void> {
    const resolvedFleetId = fleetId ?? '';
    const echec = async (motif: string): Promise<never> => {
      await this.prisma.trackerCommand.update({
        where: { id: command.id },
        data: { status: TrackerCommandStatus.FAILED, channel: 'SMS', lastError: motif },
      });
      this.emitUpdate(command.id, resolvedFleetId);
      if (!SURVEILLANCE_TEMPLATES.has(command.templateId)) {
        this.systemActivity.record({
          category: 'TRACKER_CMD', action: 'tracker_command_sent', status: 'FAILURE',
          actor: command.scheduledAt ? 'planning' : 'utilisateur', target: imei,
          detail: `${command.templateId} — ${motif}`, fleetId,
          triggeredByUserId: command.requestedBy,
          meta: { error: motif, commandId: command.id, canal: 'SMS' },
        });
      }
      throw new ServiceUnavailableException(motif);
    };

    if (!this.sms.isEnabled()) {
      await echec('passerelle SMS non configurée — commande non envoyée');
    }
    const tracker = await this.prisma.tracker.findFirst({
      where: { imei },
      select: { simPhoneNumber: true },
    });
    // Le motif est explicite : « pas de numéro » et « numéro refusé » sont deux problèmes
    // distincts, et les confondre a déjà fait chercher un numéro qui ne manquait pas
    // (cf. le repli du coupe-circuit, constat du 25/07).
    if (!tracker?.simPhoneNumber) {
      await echec('aucun numéro SIM enregistré pour ce boîtier');
    }
    const envoi = await this.sms.send(tracker!.simPhoneNumber!, command.payload, {
      imei,
      commandId: command.id,
      template: 'tracker_command_sms',
      source: 'tracker-cmd-sms',
    });
    if (!envoi.ok) {
      await echec(envoi.error ?? 'envoi SMS refusé par la passerelle');
    }

    await this.prisma.trackerCommand.update({
      where: { id: command.id },
      data: { status: TrackerCommandStatus.SENT, channel: 'SMS', sentAt: new Date() },
    });
    this.wireLogger.out(imei, command.payload, { commandId: command.id, source: 'tracker-cmd-sms' });
    this.emitUpdate(command.id, resolvedFleetId);

    if (!SURVEILLANCE_TEMPLATES.has(command.templateId)) {
      this.systemActivity.record({
        category: 'TRACKER_CMD', action: 'tracker_command_sent', status: 'SUCCESS',
        actor: command.scheduledAt ? 'planning' : 'utilisateur', target: imei,
        detail: `${command.templateId} (SMS)`, fleetId,
        triggeredByUserId: command.requestedBy,
        meta: { commandId: command.id, canal: 'SMS' },
      });
    }
  }

  async cancel(commandId: string, requestedBy: RequestedBy): Promise<TrackerCommand> {
    const command = await this.prisma.trackerCommand.findUnique({
      where: { id: commandId },
      include: { tracker: { include: { vehicle: true } } },
    });

    if (!command) throw new NotFoundException('Commande introuvable');

    if (
      command.status !== TrackerCommandStatus.PENDING &&
      command.status !== TrackerCommandStatus.SCHEDULED
    ) {
      throw new BadRequestException('Seules les commandes PENDING ou SCHEDULED peuvent être annulées');
    }

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      const fleetId = (command as any).tracker?.vehicle?.fleetId;
      if (fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Accès refusé');
      }
    }

    return this.prisma.trackerCommand.update({
      where: { id: commandId },
      data: { status: TrackerCommandStatus.CANCELLED },
    });
  }

  async list(
    requestedBy: RequestedBy,
    filters?: {
      trackerId?: string;
      status?: TrackerCommandStatus;
      category?: string;
      limit?: number;
    },
  ): Promise<TrackerCommand[]> {
    const limit = Math.min(filters?.limit ?? 50, 200);
    const where: Record<string, unknown> = {};

    // V1.16 (audit D9) — fail-closed : non-super sans fleetId => aucun resultat.
    const scope = resolveTenantScope(requestedBy);
    if (scope.mode === 'DENY') return [];
    if (scope.mode === 'FLEET') {
      where.tracker = { vehicle: { fleetId: scope.fleetId } };
    }

    if (filters?.trackerId) where.trackerId = filters.trackerId;
    if (filters?.status) where.status = filters.status;
    if (filters?.category) where.category = filters.category;

    const commands = await this.prisma.trackerCommand.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { requestedByUser: { select: { email: true, firstName: true, lastName: true, isOwner: true } } },
    });
    // Owner plateforme — masqué comme demandeur (→ « Système ») sans cacher la commande.
    for (const c of commands) this.maskOwnerRequester(c);
    return commands;
  }

  async getCommand(id: string, requestedBy: RequestedBy): Promise<TrackerCommand> {
    const command = await this.prisma.trackerCommand.findUnique({
      where: { id },
      include: {
        tracker: { include: { vehicle: true } },
        requestedByUser: { select: { email: true, firstName: true, lastName: true, isOwner: true } },
      },
    });

    if (!command) throw new NotFoundException('Commande introuvable');

    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      const fleetId = (command as any).tracker?.vehicle?.fleetId;
      if (fleetId !== requestedBy.fleetId) {
        throw new ForbiddenException('Accès refusé');
      }
    }

    this.maskOwnerRequester(command);
    return command;
  }

  /**
   * Owner plateforme — neutralise l'identité du demandeur si c'est un owner
   * (affiché « Système »), et retire le flag `isOwner` de la réponse. Masquage
   * INCONDITIONNEL (vue opérationnelle) : la commande reste visible, seul l'auteur
   * owner est anonymisé.
   */
  private maskOwnerRequester(command: unknown): void {
    const u = (command as { requestedByUser?: Record<string, unknown> | null } | null)?.requestedByUser;
    if (!u) return;
    if (u['isOwner']) {
      u['firstName'] = 'Système';
      u['lastName'] = null;
      u['email'] = null;
    }
    delete u['isOwner'];
  }

  getCatalog(role: UserRole) {
    return COBAN_COMMAND_CATALOG.filter((t) => {
      if (t.requiresSuperAdmin && role !== UserRole.SUPER_ADMIN) return false;
      return true;
    }).map((t) => ({
      id: t.id,
      category: t.category,
      label: t.label,
      description: t.description,
      dangerous: t.dangerous,
      requiresConfirmation: t.requiresConfirmation,
      requiresSuperAdmin: t.requiresSuperAdmin,
      params: t.params.map((p) => ({
        name: p.name,
        label: p.label,
        type: p.type,
        required: p.required,
        min: p.min,
        max: p.max,
        options: p.options,
      })),
      availableVia: t.availableVia,
      ackTimeoutMs: t.ackTimeoutMs,
    }));
  }

  private emitUpdate(commandId: string, fleetId: string): void {
    if (!fleetId) return;
    this.gateway.server
      ?.to(`fleet:${fleetId}`)
      .to('fleet:*')
      .emit('tracker-command:updated', { commandId });
  }
}
