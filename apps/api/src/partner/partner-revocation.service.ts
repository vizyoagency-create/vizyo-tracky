import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PartnerLinkStatus } from '@prisma/client';
import { randomBytes } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { PartnerConfigService } from './partner.config';
import { PARTNER_SCOPES, parsePartnerScopes, type PartnerScope } from '@vizyo/tracky-shared';
import { buildRevocationStatement, buildScopeStatement, type RevocationEvent } from './partner-signature';
import { PartnerTokenService } from './partner-token.service';

export type RevocationActor = 'USER' | 'PLATFORM' | 'SYSTEM';

/**
 * Révocation d'un lien partenaire — le kill-switch.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §9
 */
@Injectable()
export class PartnerRevocationService {
  private readonly logger = new Logger(PartnerRevocationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tokens: PartnerTokenService,
    private readonly config: PartnerConfigService,
    private readonly activity: SystemActivityService,
  ) {}

  /**
   * Coupe DÉFINITIVEMENT un lien.
   *
   * ⚠️ ATOMIQUE. Le changement de statut, la libération du créneau d'unicité, la
   * révocation des jetons, l'audit et la mise en file du webhook se font dans UNE
   * transaction. Si l'une échoue, aucune ne s'applique : on ne veut pas d'un lien
   * « à moitié révoqué » dont les jetons resteraient vivants.
   *
   * L'émission du webhook, elle, se fait APRÈS commit : un webhook parti pour une
   * transaction qui rollback annoncerait une révocation qui n'a pas eu lieu.
   */
  async revoke(linkId: string, reason: string, actor: RevocationActor, actorId?: string) {
    const link = await this.prisma.partnerLink.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFoundException('Partner link not found');

    // Idempotent : re-révoquer n'est pas une erreur (le webhook a pu se perdre et
    // le client réessayer). On ne rejoue simplement pas l'effet.
    if (link.status === PartnerLinkStatus.REVOKED) {
      return { status: PartnerLinkStatus.REVOKED, alreadyRevoked: true, tokensRevoked: 0 };
    }

    const revokedAt = new Date();
    const statement = this.buildStatement('LINK_REVOKED', linkId, revokedAt);

    const tokensRevoked = await this.prisma.$transaction(async (tx) => {
      await tx.partnerLink.update({
        where: { id: linkId },
        data: {
          status: PartnerLinkStatus.REVOKED,
          // Libère le créneau d'unicité : c'est ce qui permet au client de se
          // reconnecter plus tard, sans jamais perdre l'historique.
          liveKey: null,
          revokedAt,
          revokedReason: reason,
          // Plus aucun scope : même si une lecture passait entre les mailles,
          // elle ne trouverait aucune catégorie autorisée.
          scopes: [],
        },
      });
      const { count } = await tx.partnerAccessToken.updateMany({
        where: { linkId, revokedAt: null },
        data: { revokedAt },
      });
      await tx.partnerLinkEvent.create({
        data: { linkId, action: 'revoked', actorType: actor, actorId: actorId ?? null, detail: reason },
      });
      await tx.partnerOutboxEvent.create({
        data: { linkId, type: 'link.revoked', payload: statement as object },
      });
      return count;
    });

    this.activity.record({
      category: 'PARTNER',
      action: 'partner_link_revoked',
      status: 'SUCCESS',
      actor: actorId ?? actor,
      target: link.externalOrgName,
      detail: reason,
      fleetId: link.fleetId,
    });
    this.logger.warn(
      `Lien partenaire REVOQUE (fleet=${link.fleetId}, org=${link.externalOrgName}) — ${tokensRevoked} jeton(s) coupe(s)`,
    );

    return { status: PartnerLinkStatus.REVOKED, alreadyRevoked: false, tokensRevoked, statement };
  }

  /**
   * Allume ou éteint UNE catégorie — l'interrupteur vivant de la décision D3.
   *
   * ⚠️ Éteindre déclenche la MÊME machinerie qu'une révocation, limitée à ce scope :
   * énoncé signé, audit, webhook. Le partenaire purge cette catégorie et elle seule,
   * sans que le reste du lien soit affecté.
   *
   * Allumer n'émet PAS de webhook : le partenaire découvrira le nouveau scope au
   * prochain renouvellement de bail (≤ 10 min) et devra alors resynchroniser la
   * catégorie DE ZÉRO — reprendre un `lastSyncAt` périmé ressusciterait des données
   * obsolètes.
   */
  async setScope(linkId: string, scope: PartnerScope, enabled: boolean, actorId: string) {
    const link = await this.prisma.partnerLink.findUnique({ where: { id: linkId } });
    if (!link) throw new NotFoundException('Partner link not found');

    const current = parsePartnerScopes(link.scopes);
    const already = current.includes(scope);
    // Idempotent : rallumer un scope déjà allumé (ou éteindre un scope déjà éteint)
    // ne doit ni ré-émettre de webhook ni polluer le journal.
    if (already === enabled) return { scopes: current, changed: false };

    const next = enabled
      ? PARTNER_SCOPES.filter((s) => current.includes(s) || s === scope)
      : current.filter((s) => s !== scope);
    const at = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.partnerLink.update({ where: { id: linkId }, data: { scopes: next } });
      await tx.partnerLinkEvent.create({
        data: {
          linkId,
          action: enabled ? 'scope_enabled' : 'scope_disabled',
          actorType: 'USER',
          actorId,
          scope,
        },
      });
      if (!enabled) {
        const statement = buildScopeStatement(this.config.platformSecret, {
          linkId,
          scope,
          at: at.toISOString(),
          nonce: randomBytes(12).toString('hex'),
        });
        await tx.partnerOutboxEvent.create({
          data: { linkId, type: 'scope.revoked', payload: statement as object },
        });
      }
    });

    this.activity.record({
      category: 'PARTNER',
      action: enabled ? 'partner_scope_enabled' : 'partner_scope_disabled',
      status: 'SUCCESS',
      actor: actorId,
      target: link.externalOrgName,
      detail: scope,
      fleetId: link.fleetId,
    });
    this.logger.log(`Scope ${scope} ${enabled ? 'ACTIVE' : 'COUPE'} (lien=${linkId})`);

    return { scopes: next, changed: true };
  }

  /**
   * Énoncé signé joint à toute réponse de refus (403) et à tout webhook.
   *
   * ⚠️ Sans signature, un 403 de proxy ou un 404 de Traefik déclencherait une purge
   * chez le partenaire. C'est la garantie qui empêche une PANNE de se faire passer
   * pour une DÉCISION.
   */
  buildStatement(event: RevocationEvent, linkId: string, at: Date) {
    return buildRevocationStatement(this.config.platformSecret, {
      event,
      linkId,
      at: at.toISOString(),
      // Nonce : deux énoncés du même événement ne sont jamais identiques, ce qui
      // rend le rejeu détectable côté receveur.
      nonce: randomBytes(12).toString('hex'),
    });
  }
}
