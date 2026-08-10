import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PartnerLinkStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { parsePartnerScopes } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { PartnerClientService } from './partner-client.service';
import { PartnerConfigService } from './partner.config';
import { buildRevocationStatement } from './partner-signature';
import { PartnerTokenService } from './partner-token.service';

/** Facturation du connecteur (D8). Aucun paiement branché en lot 0. */
export const BILLING_STATUSES = ['COMP', 'ACTIVE', 'NONE'] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

/**
 * Pilotage PLATEFORME des liens partenaires — réservé au super-admin.
 *
 * ⚠️ `suspendedByPlatform` est le levier commercial : c'est l'axe que le CLIENT ne
 * peut pas lever. Il est volontairement DISTINCT de `status` — un lien peut être
 * `ACTIVE` et suspendu par la plateforme, ou révoqué par le client sans que la
 * plateforme y soit pour quelque chose.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §8.3, §9.4
 */
@Injectable()
export class PartnerAdminService {
  private readonly logger = new Logger(PartnerAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: PartnerTokenService,
    private readonly client: PartnerClientService,
    private readonly config: PartnerConfigService,
    private readonly activity: SystemActivityService,
  ) {}

  /** Tous les liens, toutes flottes. Ne divulgue jamais l'empreinte du secret. */
  async list() {
    const links = await this.prisma.partnerLink.findMany({
      orderBy: { createdAt: 'desc' },
      include: { fleet: { select: { name: true } } },
    });
    return links.map((l) => ({
      id: l.id,
      fleetId: l.fleetId,
      fleetName: l.fleet.name,
      partner: l.partner,
      organizationName: l.externalOrgName,
      siret: l.externalOrgSiret,
      status: l.status,
      suspendedByPlatform: l.suspendedByPlatform,
      suspendedReason: l.suspendedReason,
      billingStatus: l.billingStatus,
      scopes: parsePartnerScopes(l.scopes),
      approvedAt: l.approvedAt,
      lastSeenAt: l.lastSeenAt,
      revokedAt: l.revokedAt,
    }));
  }

  /**
   * LEVIER IMPAYÉ — coupe l'accès sans que le client puisse le rétablir.
   *
   * ⚠️ On ne touche PAS à `status` : le lien reste tel qu'il est, seul le drapeau
   * plateforme change. C'est ce qui permet de rétablir exactement l'état antérieur
   * quand le client régularise, sans lui faire refaire un handshake.
   */
  async platformSuspend(linkId: string, reason: string, actorId: string) {
    const link = await this.requireLink(linkId);
    if (link.suspendedByPlatform) return { suspendedByPlatform: true, changed: false };

    const at = new Date();
    const statement = buildRevocationStatement(this.config.platformSecret, {
      event: 'LINK_SUSPENDED',
      linkId,
      at: at.toISOString(),
      nonce: randomBytes(12).toString('hex'),
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.partnerLink.update({
        where: { id: linkId },
        data: { suspendedByPlatform: true, suspendedReason: reason },
      });
      // Les jetons vivants sont coupés tout de suite : sans ça le partenaire
      // continuerait de lire pendant 10 minutes.
      await tx.partnerAccessToken.updateMany({
        where: { linkId, revokedAt: null },
        data: { revokedAt: at },
      });
      await tx.partnerLinkEvent.create({
        data: { linkId, action: 'platform_suspended', actorType: 'PLATFORM', actorId, detail: reason },
      });
      await tx.partnerOutboxEvent.create({
        data: { linkId, type: 'link.suspended', payload: statement as object },
      });
    });

    this.record('partner_platform_suspended', link, actorId, reason);
    this.logger.warn(`Lien ${linkId} SUSPENDU PAR LA PLATEFORME — ${reason}`);
    return { suspendedByPlatform: true, changed: true };
  }

  /**
   * Rétablit l'accès. Le partenaire redemandera un bail dans les 10 minutes et
   * resynchronisera : rien à refaire côté client.
   */
  async platformResume(linkId: string, actorId: string) {
    const link = await this.requireLink(linkId);
    if (!link.suspendedByPlatform) return { suspendedByPlatform: false, changed: false };

    await this.prisma.$transaction(async (tx) => {
      await tx.partnerLink.update({
        where: { id: linkId },
        data: { suspendedByPlatform: false, suspendedReason: null },
      });
      await tx.partnerLinkEvent.create({
        data: { linkId, action: 'platform_resumed', actorType: 'PLATFORM', actorId },
      });
    });

    this.record('partner_platform_resumed', link, actorId, null);
    this.logger.log(`Lien ${linkId} RETABLI par la plateforme`);
    return { suspendedByPlatform: false, changed: true };
  }

  /**
   * Bascule la facturation du connecteur (D8).
   *
   * ⚠️ Axe INDÉPENDANT de la suspension : un client peut être `COMP` (offert) ET
   * suspendu pour impayé sur son abonnement Tracky principal. Aucun paiement n'est
   * branché — passer au payant est un changement d'état, pas une refonte.
   */
  async setBilling(linkId: string, status: BillingStatus, actorId: string) {
    const link = await this.requireLink(linkId);
    if (link.billingStatus === status) return { billingStatus: status, changed: false };

    await this.prisma.$transaction(async (tx) => {
      await tx.partnerLink.update({ where: { id: linkId }, data: { billingStatus: status } });
      await tx.partnerLinkEvent.create({
        data: {
          linkId,
          action: 'billing_changed',
          actorType: 'PLATFORM',
          actorId,
          detail: `${link.billingStatus} -> ${status}`,
        },
      });
    });

    this.record('partner_billing_changed', link, actorId, `${link.billingStatus} -> ${status}`);
    return { billingStatus: status, changed: true };
  }

  /**
   * DRY-RUN : ce qui disparaîtrait chez le partenaire si on coupait maintenant.
   *
   * ⚠️ N'ÉCRIT RIEN, ni ici ni chez le partenaire. Couper un client a des
   * conséquences financières pour lui : on doit pouvoir regarder avant d'appuyer.
   *
   * Si le partenaire est injoignable, on renvoie quand même la vue côté Tracky
   * plutôt que d'échouer — une panne du pair ne doit pas empêcher de préparer une
   * décision commerciale.
   */
  async revocationPreview(linkId: string) {
    const link = await this.requireLink(linkId);
    const local = {
      organizationName: link.externalOrgName,
      scopes: parsePartnerScopes(link.scopes),
      lastSeenAt: link.lastSeenAt,
      activeTokens: await this.prisma.partnerAccessToken.count({
        where: { linkId, revokedAt: null, expiresAt: { gt: new Date() } },
      }),
    };

    try {
      const remote = await this.client.purgePreview(linkId);
      return { ...local, partnerReachable: true, remote };
    } catch {
      this.logger.warn(`Aperçu de coupure : partenaire injoignable pour le lien ${linkId}`);
      return { ...local, partnerReachable: false, remote: null };
    }
  }

  private async requireLink(linkId: string) {
    const link = await this.prisma.partnerLink.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFoundException('Partner link not found');
    return link;
  }

  private record(action: string, link: { externalOrgName: string; fleetId: string }, actorId: string, detail: string | null) {
    this.activity.record({
      category: 'PARTNER',
      action,
      status: 'SUCCESS',
      actor: actorId,
      target: link.externalOrgName,
      detail,
      fleetId: link.fleetId,
    });
  }
}
