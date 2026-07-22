import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { PartnerLinkStatus } from '@prisma/client';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { parsePartnerScopes, type PartnerScope } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { PartnerConfigService } from './partner.config';

export interface PartnerTokenContext {
  linkId: string;
  fleetId: string;
  scopes: PartnerScope[];
}

/**
 * Le bail : jetons d'accès OPAQUES, courts, révocables instantanément.
 *
 * ⚠️ DEUX CORRECTIONS de la spec, décidées en implémentant (§5, §7) :
 *
 * 1. **La demande de jeton n'est PAS signée en HMAC.** La spec disait « le secret de
 *    lien signe les demandes de bail » ET « secretHash — stocké HASHÉ, jamais en clair ».
 *    Les deux sont incompatibles : on ne peut pas vérifier un HMAC avec une empreinte.
 *    On garde le stockage à SENS UNIQUE (la propriété la plus forte : un dump de la base
 *    ne donne aucun secret utilisable) et le secret est présenté comme une CRÉDENCE, sur
 *    TLS, comparée en temps constant à son empreinte. C'est le fonctionnement de toute
 *    clé d'API. Il ne circule que sur cet endpoint ; tout le reste utilise le jeton court.
 *
 * 2. **Pas de cache Redis pour la validation.** La spec prévoyait Redis en chemin chaud.
 *    Or un cache introduit une FENÊTRE pendant laquelle un jeton révoqué reste valide —
 *    exactement ce que le lot 0 cherche à supprimer. Le trafic partenaire est ici
 *    minuscule (un jeton toutes les 10 min). On lit donc la base, sans fenêtre. Redis
 *    redeviendra pertinent en phase 3 (sondage de la carte live) — avec un TTL de cache
 *    borné par le délai de révocation acceptable.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §7
 */
@Injectable()
export class PartnerTokenService {
  private readonly logger = new Logger(PartnerTokenService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: PartnerConfigService,
  ) {}

  /**
   * Échange la crédence de lien contre un jeton d'accès court.
   *
   * Renvoie AUSSI les scopes autoritaires : c'est le 2ᵉ chemin de la révocation
   * partielle. Le partenaire compare à son état local et purge ce qui a disparu,
   * même si le webhook s'est perdu.
   */
  async issue(linkId: string, presentedSecret: string) {
    const link = await this.prisma.partnerLink.findUnique({ where: { id: linkId } });

    // Même erreur pour « lien inconnu » et « mauvais secret » : distinguer les deux
    // permettrait d'énumérer les identifiants de liens existants.
    if (!link || !hashEquals(presentedSecret, link.secretHash)) {
      throw new UnauthorizedException('Invalid partner credentials');
    }
    this.assertUsable(link);

    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + this.config.tokenTtlSeconds * 1000);

    await this.prisma.partnerAccessToken.create({
      data: { linkId, tokenHash: sha256(token), expiresAt },
    });
    await this.prisma.partnerLink.update({
      where: { id: linkId },
      data: { lastSeenAt: new Date() },
    });

    return {
      accessToken: token,
      expiresIn: this.config.tokenTtlSeconds,
      scopes: parsePartnerScopes(link.scopes),
      linkStatus: link.status,
    };
  }

  /**
   * Résout un jeton d'accès. Vérifie le JETON **et** l'état du lien à chaque appel :
   * révoquer le lien suffit à couper l'accès, même si la purge des jetons échouait.
   * Deux barrières indépendantes pour une seule garantie.
   */
  async resolve(token: string): Promise<PartnerTokenContext> {
    const row = await this.prisma.partnerAccessToken.findUnique({
      where: { tokenHash: sha256(token) },
      include: { link: true },
    });
    if (!row || row.revokedAt || row.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('Invalid or expired partner token');
    }
    this.assertUsable(row.link);

    return {
      linkId: row.linkId,
      fleetId: row.link.fleetId,
      scopes: parsePartnerScopes(row.link.scopes),
    };
  }

  /**
   * Révoque TOUS les jetons vivants d'un lien. Appelé par la révocation (incr. 0.7).
   * Idempotent : révoquer deux fois n'est pas une erreur.
   */
  async revokeAllForLink(linkId: string): Promise<number> {
    const { count } = await this.prisma.partnerAccessToken.updateMany({
      where: { linkId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count > 0) this.logger.log(`${count} jeton(s) partenaire revoque(s) (lien=${linkId})`);
    return count;
  }

  /**
   * Un lien coupé ne délivre rien et ne valide rien.
   *
   * ⚠️ `suspendedByPlatform` est vérifié SÉPARÉMENT de `status` : les deux axes sont
   * indépendants (un lien peut être ACTIVE et suspendu par la plateforme).
   */
  private assertUsable(link: { status: PartnerLinkStatus; suspendedByPlatform: boolean }): void {
    if (link.suspendedByPlatform) {
      throw new UnauthorizedException('Partner link suspended by platform');
    }
    if (link.status !== PartnerLinkStatus.ACTIVE) {
      throw new UnauthorizedException(`Partner link ${link.status.toLowerCase()}`);
    }
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Comparaison en temps constant d'un secret présenté avec son empreinte stockée. */
function hashEquals(presented: string, storedHash: string): boolean {
  if (!presented || !storedHash) return false;
  const a = Buffer.from(sha256(presented), 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}
