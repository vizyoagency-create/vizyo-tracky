import { ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PartnerLinkStatus } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  PARTNER_SCOPES_DEFAULT_ON,
  PARTNER_SCOPE_LABELS,
  parsePartnerScopes,
  type PartnerScope,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { PartnerClientService, PartnerRemoteError } from './partner-client.service';
import { PartnerConfigService } from './partner.config';
import { PartnerInvitationService } from './partner-invitation.service';

const PARTNER = 'MAESTROO';

/**
 * Handshake côté Tracky : le FOURNISSEUR, qui tient l'interrupteur.
 *
 * `claim` ne fait que résoudre le code et préparer l'écran de consentement — il
 * n'active RIEN. `approve` est l'acte explicite du fleet-admin.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §6
 */
@Injectable()
export class PartnerPairingService {
  private readonly logger = new Logger(PartnerPairingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: PartnerClientService,
    private readonly config: PartnerConfigService,
    private readonly activity: SystemActivityService,
    private readonly invitations: PartnerInvitationService,
  ) {}

  /**
   * Résout un code d'appairage et renvoie de quoi peupler l'écran de consentement.
   * N'ÉCRIT RIEN : le client doit pouvoir regarder avant de décider.
   */
  async claim(fleetId: string, code: string) {
    await this.assertPairable(fleetId);
    const details = await this.client.readPairing(code);

    return {
      partner: PARTNER,
      organizationName: details.organizationName,
      siret: details.siret,
      expiresAt: details.expiresAt,
      // Le catalogue complet, avec les défauts. Les scopes SENSIBLES arrivent
      // décochés — c'est le client qui les allume, en connaissance de cause.
      scopes: Object.entries(PARTNER_SCOPE_LABELS).map(([key, entry]) => ({
        key,
        label: entry.label,
        description: entry.description,
        defaultOn: PARTNER_SCOPES_DEFAULT_ON.includes(key as PartnerScope),
      })),
    };
  }

  /**
   * Active le partage.
   *
   * ⚠️ ORDRE VOLONTAIRE : on prévient le partenaire, PUIS on crée le lien local.
   * Si le partenaire échoue, rien n'existe nulle part — c'est le cas courant
   * (réseau, pair indisponible) et il est propre. Le cas résiduel inverse
   * (partenaire OK, écriture locale KO) est compensé par `abortPairing`.
   *
   * L'identifiant du lien est donc généré AVANT l'appel : le partenaire a besoin
   * du `remoteLinkId` alors que la ligne n'existe pas encore de notre côté.
   */
  async approve(fleetId: string, userId: string, code: string, requestedScopes: unknown) {
    await this.assertPairable(fleetId);
    // ⚠️ AVANT TOUT LE RESTE : un code promis par e-mail à une flotte n'est
    // utilisable que par elle. Sans ce garde, un e-mail transféré suffisait à
    // brancher la flotte du destinataire sur l'organisation Maestroo d'un autre.
    await this.invitations.assertCodeUsableBy(fleetId, code);

    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { name: true } });
    if (!fleet) throw new NotFoundException('Fleet not found');

    const details = await this.client.readPairing(code);

    // Scopes normalisés fail-closed : une valeur inconnue n'accorde jamais rien.
    // Liste vide = rien n'est partagé, JAMAIS un repli sur les défauts.
    const scopes = parsePartnerScopes(requestedScopes);

    const linkId = randomUUID();
    // Secret propre à CE lien : sa compromission n'expose pas la plateforme.
    const linkSecret = randomBytes(32).toString('base64url');

    // Pré-remplissage envoyé DANS l'acquittement, pas dans un appel séparé : un
    // second appel pourrait échouer après un handshake réussi, et le client
    // découvrirait un espace vide sans qu'aucune erreur ne le lui dise. Ici,
    // c'est atomique du point de vue du partenaire.
    //
    // ⚠️ `seedVehicles` dépend des scopes consentis : liste vide si le client
    // n'a pas coché l'identité des véhicules. Le pré-remplissage ne contourne
    // pas l'interrupteur, il en dépend.
    const seedVehicles = await this.invitations.seedVehicles(fleetId, scopes);

    await this.client.completePairing(code, {
      remoteLinkId: linkId,
      fleetName: fleet.name,
      linkSecret,
      scopes,
      seedVehicles,
    });

    try {
      await this.prisma.partnerLink.create({
        data: {
          id: linkId,
          fleetId,
          partner: PARTNER,
          // Créneau d'unicité : occupé tant que le lien est vivant, libéré à la
          // révocation pour permettre un futur ré-appairage.
          liveKey: PARTNER,
          externalOrgId: details.organizationId,
          externalOrgName: details.organizationName,
          externalOrgSiret: details.siret,
          status: PartnerLinkStatus.ACTIVE,
          scopes,
          // Le secret n'est JAMAIS persisté en clair : on ne garde qu'une empreinte
          // pour vérifier les demandes de bail.
          secretHash: hashSecret(linkSecret),
          createdByUserId: userId,
          approvedByUserId: userId,
          approvedAt: new Date(),
          events: {
            create: [
              { action: 'approved', actorType: 'USER', actorId: userId, detail: details.organizationName },
              ...scopes.map((scope) => ({ action: 'scope_enabled', actorType: 'USER', actorId: userId, scope })),
            ],
          },
        },
      });
    } catch (err) {
      // Le partenaire nous a acquittés mais nous n'avons pas pu enregistrer :
      // sans compensation, il afficherait « connecté » alors que rien ne
      // fonctionnerait (aucune demande de bail n'aboutirait).
      this.logger.error(
        `Ecriture du lien ${linkId} ECHOUEE apres acquittement du partenaire — compensation`,
      );
      await this.client.abortPairing(code, linkId);
      throw err;
    }

    // Fige la preuve de consentement (qui a accepté, quoi, quand). Après la
    // création du lien : une invitation marquée « acceptée » alors que
    // l'appairage a échoué serait un faux dans un registre RGPD.
    await this.invitations.markAccepted({ fleetId, pairingCode: code, userId, scopes, linkId });

    this.activity.record({
      category: 'PARTNER',
      action: 'partner_link_approved',
      status: 'SUCCESS',
      actor: userId,
      target: details.organizationName,
      detail: `${scopes.length} categorie(s) partagee(s)`,
      fleetId,
    });
    this.logger.log(`Lien partenaire ACTIF (fleet=${fleetId}, org=${details.organizationName})`);

    return { linkId, status: PartnerLinkStatus.ACTIVE, scopes };
  }

  /** Le lien VIVANT de cette flotte, ou 404. Utilisé par la révocation. */
  async requireLink(fleetId: string) {
    const link = await this.prisma.partnerLink.findFirst({
      where: { fleetId, partner: PARTNER, liveKey: { not: null } },
    });
    if (!link) throw new NotFoundException('Aucune integration active pour cette flotte');
    return link;
  }

  /** État du lien pour l'écran « Intégrations ». Ne divulgue JAMAIS l'empreinte du secret. */
  async status(fleetId: string) {
    const link = await this.prisma.partnerLink.findFirst({
      where: { fleetId, partner: PARTNER },
      orderBy: { createdAt: 'desc' },
      include: { events: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!link) return { status: 'NONE' as const, suspendedByPlatform: false };

    return {
      status: link.status,
      suspendedByPlatform: link.suspendedByPlatform,
      suspendedReason: link.suspendedReason,
      billingStatus: link.billingStatus,
      organizationName: link.externalOrgName,
      scopes: parsePartnerScopes(link.scopes),
      approvedAt: link.approvedAt,
      lastSeenAt: link.lastSeenAt,
      revokedAt: link.revokedAt,
      events: link.events.map((e) => ({
        action: e.action,
        actorType: e.actorType,
        scope: e.scope,
        detail: e.detail,
        createdAt: e.createdAt,
      })),
    };
  }

  /**
   * Un appairage est-il permis pour cette flotte ?
   *
   * ⚠️ `suspendedByPlatform` est vérifié ICI, au niveau du handshake, et pas
   * seulement sur la réactivation. Sans ce contrôle, un client suspendu pour
   * impayé révoquerait puis recommencerait un appairage neuf en trente secondes,
   * et le levier commercial ne vaudrait rien.
   */
  private async assertPairable(fleetId: string): Promise<void> {
    if (!this.config.enabled) throw new NotFoundException();

    const suspended = await this.prisma.partnerLink.findFirst({
      where: { fleetId, partner: PARTNER, suspendedByPlatform: true },
    });
    if (suspended) {
      throw new ForbiddenException(
        'Votre acces a l\'integration a ete suspendu. Contactez Tracky.',
      );
    }

    const live = await this.prisma.partnerLink.findFirst({
      where: { fleetId, partner: PARTNER, liveKey: { not: null } },
    });
    if (live) throw new ConflictException('Cette flotte est deja connectee a Maestroo');
  }
}

/** SHA-256 hexadécimal — le secret en clair ne doit jamais atteindre la base. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export { PartnerRemoteError };
