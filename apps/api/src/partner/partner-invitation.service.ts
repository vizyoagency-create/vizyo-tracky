import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'node:crypto';
import { parsePartnerScopes } from '@vizyo/tracky-shared';
import type { Env } from '../config/env.validation';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { PartnerClientService, type PartnerSeedVehicle } from './partner-client.service';
import { PartnerConfigService } from './partner.config';

const PARTNER = 'MAESTROO';

/**
 * Durée de vie d'une invitation. Au-delà, le lien ne redirige plus.
 *
 * Un lien de consentement qui traîne trois semaines dans une boîte mail ne
 * documente plus une décision éclairée : le client ne se souvient ni de la
 * demande, ni de son contexte. 72 h correspond à la fenêtre de grâce déjà
 * utilisée ailleurs dans l'intégration (D7) — un client sollicité un vendredi
 * peut répondre le lundi.
 */
export const INVITATION_TTL_HOURS = 72;

/**
 * Invitation à consentir : l'e-mail qui emmène le fleet-admin sur l'écran de
 * consentement, et la trace de ce qu'il en a fait.
 *
 * ⚠️ POURQUOI CE SERVICE EXISTE — sans lui, consentir demandait au client
 * d'aller chercher un code dans Maestroo puis de le coller dans Tracky. Personne
 * ne fait ça. Un consentement qu'on n'obtient jamais ne protège personne.
 *
 * ⚠️ LE JETON N'AUTORISE RIEN. Il identifie une invitation. Le destinataire doit
 * toujours se connecter et porter `integrations_manage`. Ne jamais le
 * transformer en jeton d'accès : un e-mail transféré deviendrait une faille.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §13.4
 */
@Injectable()
export class PartnerInvitationService {
  private readonly logger = new Logger(PartnerInvitationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService<Env, true>,
    private readonly partnerConfig: PartnerConfigService,
    private readonly activity: SystemActivityService,
    private readonly client: PartnerClientService,
  ) {}

  /** Envoie l'invitation. L'e-mail part APRÈS l'écriture : un e-mail sans trace ne se retrouve pas. */
  async send(params: {
    fleetId: string;
    pairingCode: string;
    email: string;
    sentByUserId: string;
  }) {
    if (!this.partnerConfig.enabled) throw new NotFoundException();

    const code = normalizeCode(params.pairingCode);
    if (!code) throw new BadRequestException('Code d\'appairage requis');
    const to = params.email.trim().toLowerCase();
    if (!to.includes('@')) throw new BadRequestException('Adresse e-mail invalide');

    const fleet = await this.prisma.fleet.findUnique({
      where: { id: params.fleetId },
      select: { id: true, name: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable');

    // Une flotte déjà connectée n'a rien à consentir : inviter quand même
    // enverrait le client vers un écran qui refuse.
    const live = await this.prisma.partnerLink.findFirst({
      where: { fleetId: fleet.id, partner: PARTNER, liveKey: { not: null } },
      select: { id: true },
    });
    if (live) throw new BadRequestException('Cette flotte est déjà connectee a Maestroo');

    // ⚠️ Un code déjà promis à UNE AUTRE flotte ne peut pas être ré-invité
    // ailleurs : ce serait offrir à un second client d'appairer sa flotte sur
    // l'organisation Maestroo du premier.
    const claimedElsewhere = await this.prisma.partnerInvitation.findFirst({
      where: { partner: PARTNER, pairingCode: code, fleetId: { not: fleet.id } },
      select: { id: true },
    });
    if (claimedElsewhere) {
      throw new ForbiddenException('Ce code a déjà été envoyé a une autre flotte');
    }

    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + INVITATION_TTL_HOURS * 3600_000);

    const invitation = await this.prisma.partnerInvitation.create({
      data: {
        fleetId: fleet.id,
        partner: PARTNER,
        pairingCode: code,
        token,
        email: to,
        sentByUserId: params.sentByUserId,
        expiresAt,
      },
    });

    const built = this.email.buildPartnerConsentInvitationEmail({
      fleetName: fleet.name,
      partnerName: 'Maestroo',
      consentUrl: this.consentUrl(token),
      expiresAt,
    });
    const sent = await this.email.send({
      to,
      subject: built.subject,
      html: built.html,
      text: built.text,
      template: 'partner_consent_invitation',
      fleetId: fleet.id,
      context: { invitationId: invitation.id },
    });

    this.activity.record({
      category: 'PARTNER',
      action: 'partner_invitation_sent',
      status: sent.ok ? 'SUCCESS' : 'FAILURE',
      actor: params.sentByUserId,
      target: to,
      detail: fleet.name,
      fleetId: fleet.id,
    });

    return { id: invitation.id, email: to, expiresAt, emailSent: sent.ok };
  }

  /**
   * Le client a cliqué. Enregistre le clic et renvoie où l'emmener.
   *
   * ⚠️ On mesure le CLIC, pas l'affichage de l'e-mail. Un pixel de suivi serait
   * bloqué par la moitié des clients mail et prouverait, au mieux, qu'une image
   * a été chargée — pas qu'une personne a décidé d'agir.
   *
   * ⚠️ Cette route ne peut RIEN refuser d'intéressant : elle ne donne accès à
   * rien. Un jeton inconnu renvoie vers l'écran nu, sans rien dire de plus —
   * inutile d'indiquer à un curieux si un jeton existe.
   */
  async recordOpen(token: string, ip: string | null, userAgent: string | null): Promise<string> {
    const appBase = this.config.get('APP_BASE_URL', { infer: true });
    const invitation = await this.prisma.partnerInvitation.findUnique({ where: { token } });
    if (!invitation) return `${appBase}/integrations`;

    const now = new Date();
    if (invitation.expiresAt < now) {
      // Le clic reste tracé (il dit « le client a réagi, trop tard »), mais on ne
      // propose pas un code périmé : l'écran l'annoncerait en erreur.
      await this.touch(invitation.id, invitation.openedAt, now, ip, userAgent);
      return `${appBase}/integrations?invite=expired`;
    }

    await this.touch(invitation.id, invitation.openedAt, now, ip, userAgent);
    const params = new URLSearchParams({ code: invitation.pairingCode, inv: token });
    return `${appBase}/integrations?${params.toString()}`;
  }

  /**
   * GARDE ANTI-TRANSFERT — appelée avant tout appairage.
   *
   * ⚠️ C'est le bug d'ambiguïté d'organisation vu depuis l'autre bout : un e-mail
   * transféré (volontairement ou non) mettait n'importe quel fleet-admin en
   * position d'appairer SA flotte sur l'organisation Maestroo du destinataire
   * légitime. Un code promis à une flotte n'est utilisable que par elle.
   *
   * Un code SANS invitation reste libre : c'est le parcours manuel, où celui qui
   * a généré le code est celui qui le saisit.
   */
  async assertCodeUsableBy(fleetId: string, pairingCode: string): Promise<void> {
    const code = normalizeCode(pairingCode);
    const promised = await this.prisma.partnerInvitation.findFirst({
      where: { partner: PARTNER, pairingCode: code },
      select: { fleetId: true },
    });
    if (promised && promised.fleetId !== fleetId) {
      this.logger.warn(
        `Code d'appairage promis a la flotte ${promised.fleetId} tente depuis ${fleetId} — REFUSE`,
      );
      throw new ForbiddenException(
        'Ce code a été émis pour une autre flotte. Demandez votre propre lien de consentement.',
      );
    }
  }

  /** Fige ce qui a été consenti ce jour-là. L'état vivant reste dans PartnerLink. */
  async markAccepted(params: {
    fleetId: string;
    pairingCode: string;
    userId: string;
    scopes: string[];
    linkId: string;
  }): Promise<void> {
    const code = normalizeCode(params.pairingCode);
    const invitation = await this.prisma.partnerInvitation.findFirst({
      where: { partner: PARTNER, pairingCode: code, fleetId: params.fleetId, acceptedAt: null },
      orderBy: { sentAt: 'desc' },
      select: { id: true },
    });
    if (!invitation) return; // Parcours manuel : rien à rattacher.

    await this.prisma.partnerInvitation.update({
      where: { id: invitation.id },
      data: {
        acceptedAt: new Date(),
        acceptedByUserId: params.userId,
        acceptedScopes: params.scopes,
        linkId: params.linkId,
      },
    });
  }

  /**
   * PARCOURS COMPLET pour un client qui n'a PAS encore de Maestroo : on fait
   * créer son espace, puis on lui envoie l'invitation à consentir.
   *
   * ⚠️ C'EST LE CAS COMMERCIAL LE PLUS FRÉQUENT, et il n'était pas couvert. Le
   * handshake d'origine supposait un client déjà chez Maestroo, qui y générait
   * un code. Un client Tracky sans Maestroo n'avait tout simplement rien à
   * appairer : le parcours s'arrêtait avant de commencer.
   *
   * ⚠️ L'ORDRE COMPTE. On crée l'espace AVANT d'écrire quoi que ce soit chez
   * nous : si le partenaire échoue, rien n'existe nulle part, et le super-admin
   * peut simplement recommencer. L'inverse laisserait une invitation pointant
   * vers un espace inexistant.
   */
  async provisionAndInvite(params: { fleetId: string; email: string; sentByUserId: string }) {
    if (!this.partnerConfig.enabled) throw new NotFoundException();

    const to = params.email.trim().toLowerCase();
    if (!to.includes('@')) throw new BadRequestException('Adresse e-mail invalide');

    const fleet = await this.prisma.fleet.findUnique({
      where: { id: params.fleetId },
      select: { id: true, name: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable');

    const live = await this.prisma.partnerLink.findFirst({
      where: { fleetId: fleet.id, partner: PARTNER, liveKey: { not: null } },
      select: { id: true },
    });
    if (live) throw new BadRequestException('Cette flotte est déjà connectee a Maestroo');

    // Le destinataire proposé sert aussi d'adresse de l'espace : c'est là que
    // partira, plus tard, le lien d'activation du compte.
    const contact = await this.prisma.user.findFirst({
      where: { fleetId: fleet.id, email: to },
      select: { firstName: true, lastName: true, phone: true },
    });

    const space = await this.client.provisionSpace({
      fleetId: fleet.id,
      fleetName: fleet.name,
      contactEmail: to,
      contactFirstName: contact?.firstName ?? null,
      contactLastName: contact?.lastName ?? null,
      contactPhone: contact?.phone ?? null,
    });

    const invitation = await this.send({
      fleetId: fleet.id,
      pairingCode: space.pairingCode,
      email: to,
      sentByUserId: params.sentByUserId,
    });

    this.activity.record({
      category: 'PARTNER',
      action: 'partner_space_provisioned',
      status: 'SUCCESS',
      actor: params.sentByUserId,
      target: space.organizationName,
      detail: space.created ? 'Espace cree' : 'Espace deja existant, nouveau code',
      fleetId: fleet.id,
    });

    return { ...invitation, organizationName: space.organizationName, spaceCreated: space.created };
  }

  /**
   * Identité des véhicules, pour pré-remplir l'espace du partenaire au moment du
   * consentement.
   *
   * ⚠️ Renvoie une liste VIDE si `VEHICLE_IDENTITY` n'a pas été consenti. C'est
   * la garantie qui rend le pré-remplissage acceptable : il ne contourne pas
   * l'interrupteur, il en dépend.
   */
  async seedVehicles(fleetId: string, scopes: string[]): Promise<PartnerSeedVehicle[]> {
    if (!scopes.includes('VEHICLE_IDENTITY')) return [];

    // Le compteur est un fait d'USAGE, pas de l'identité : il a son propre
    // interrupteur. On ne le LIT même pas s'il n'est pas consenti…
    const withMileage = scopes.includes('MILEAGE_TRIPS');
    // La consommation CALIBRÉE (méthode du plein, C5) est une MESURE : elle
    // relève du scope FUEL. La déclarative reste une spec du véhicule (identité).
    const withFuel = scopes.includes('FUEL');
    const vehicles = await this.prisma.vehicle.findMany({
      where: { fleetId },
      select: {
        // La clé de jointure STABLE côté partenaire (C2) : la plaque est
        // éditable, l'id ne l'est pas.
        id: true,
        plate: true,
        brand: true,
        model: true,
        year: true,
        type: true,
        energy: true,
        seats: true,
        fuelConsumptionL100km: true,
        calibratedConsumptionL100km: withFuel,
        lastOdometerKm: withMileage,
      },
    });
    return vehicles.map((v) => ({
      trackyVehicleId: v.id,
      plate: v.plate,
      brand: v.brand,
      model: v.model,
      year: v.year,
      type: v.type,
      energy: v.energy,
      seats: v.seats,
      consumptionL100km: v.fuelConsumptionL100km,
      // …et on re-teste ICI plutôt que de déduire la permission de la présence
      // de la clé. Un jour quelqu'un ajoutera `lastOdometerKm: true` au select
      // « pour simplifier » : la garantie doit survivre à ça.
      odometerKm: withMileage ? ((v as { lastOdometerKm?: number | null }).lastOdometerKm ?? null) : null,
      calibratedConsumptionL100km: withFuel
        ? ((v as { calibratedConsumptionL100km?: number | null }).calibratedConsumptionL100km ?? null)
        : null,
    }));
  }

  /**
   * Flottes invitables + destinataires proposés.
   *
   * ⚠️ Une flotte DÉJÀ connectée est exclue : l'inviter enverrait le client vers
   * un écran qui refuse, et lui ferait croire qu'on lui redemande son accord.
   */
  async invitableFleets() {
    const [fleets, live] = await Promise.all([
      this.prisma.fleet.findMany({
        orderBy: { name: 'asc' },
        select: {
          id: true,
          name: true,
          users: {
            where: { role: { in: ['FLEET_ADMIN', 'SUPER_ADMIN'] }, isActive: true },
            select: { email: true, firstName: true, lastName: true },
            orderBy: { email: 'asc' },
          },
        },
      }),
      this.prisma.partnerLink.findMany({
        where: { partner: PARTNER, liveKey: { not: null } },
        select: { fleetId: true },
      }),
    ]);
    const connected = new Set(live.map((l) => l.fleetId));
    return fleets
      .filter((f) => !connected.has(f.id))
      .map((f) => ({
        id: f.id,
        name: f.name,
        admins: f.users.map((u) => ({
          email: u.email,
          name: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email,
        })),
      }));
  }

  /** Journal des sollicitations — onglet Sécu & RGPD. */
  async list(limit = 100) {
    const rows = await this.prisma.partnerInvitation.findMany({
      orderBy: { sentAt: 'desc' },
      take: limit,
      include: { fleet: { select: { name: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      fleetName: r.fleet.name,
      partner: r.partner,
      email: r.email,
      sentAt: r.sentAt,
      expiresAt: r.expiresAt,
      openedAt: r.openedAt,
      openCount: r.openCount,
      openIp: r.openIp,
      acceptedAt: r.acceptedAt,
      acceptedScopes: parsePartnerScopes(r.acceptedScopes),
      state: invitationState(r),
    }));
  }

  private consentUrl(token: string): string {
    // Le lien passe par l'API pour que le clic soit enregistré côté serveur, PUIS
    // redirige vers l'application. Un lien direct vers le SPA ne dirait jamais
    // si le client a cliqué mais renoncé au moment de se connecter — or c'est
    // exactement ce qu'on veut pouvoir distinguer.
    //
    // ⚠️ `/api` est le préfixe global de l'API, servie sur le MÊME hôte que le
    // front (Traefik route `/api/*`). Si les deux venaient à être séparés, c'est
    // ici qu'il faudrait une variable dédiée.
    const appBase = this.config.get('APP_BASE_URL', { infer: true });
    return `${appBase}/api/integrations/partner/invite/${token}`;
  }

  private async touch(
    id: string,
    previousOpenedAt: Date | null,
    now: Date,
    ip: string | null,
    userAgent: string | null,
  ): Promise<void> {
    await this.prisma.partnerInvitation.update({
      where: { id },
      data: {
        // `openedAt` = PREMIER clic, jamais écrasé : c'est lui qui répond à
        // « quand le client a-t-il réagi ? ». Les suivants alimentent le compteur.
        openedAt: previousOpenedAt ?? now,
        lastOpenedAt: now,
        openCount: { increment: 1 },
        openIp: ip?.slice(0, 60) ?? undefined,
        openUserAgent: userAgent?.slice(0, 300) ?? undefined,
      },
    });
  }
}

/** États affichés dans le journal — dérivés, jamais stockés (ils changent avec l'heure). */
export function invitationState(r: {
  acceptedAt: Date | null;
  openedAt: Date | null;
  expiresAt: Date;
}, now: Date = new Date()): 'ACCEPTED' | 'OPENED' | 'EXPIRED' | 'SENT' {
  if (r.acceptedAt) return 'ACCEPTED';
  if (r.expiresAt < now) return 'EXPIRED';
  if (r.openedAt) return 'OPENED';
  return 'SENT';
}

/** Les codes sont affichés en majuscules ; un copier-coller peut ramener des espaces. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
