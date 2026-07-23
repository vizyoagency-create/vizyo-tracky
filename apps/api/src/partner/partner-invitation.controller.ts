import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { PartnerInvitationService } from './partner-invitation.service';

/**
 * Le lien cliqué depuis l'e-mail d'invitation.
 *
 * ⚠️ ROUTE PUBLIQUE ASSUMÉE — un lien de consentement doit s'ouvrir même quand le
 * destinataire n'est pas connecté, sinon on ne saurait jamais distinguer « il n'a
 * pas cliqué » de « il a cliqué mais a renoncé devant l'écran de connexion ». Or
 * c'est précisément la différence utile : la première dit que l'e-mail n'a pas
 * porté, la seconde qu'il a porté mais que le parcours coince.
 *
 * Elle ne donne accès à RIEN : elle enregistre un clic et redirige. L'écran
 * d'arrivée est, lui, protégé par l'authentification et `integrations_manage`.
 *
 * Spec : docs/23-integration-maestroo-phase0-spec.md §13.4
 */
// ⚠️ AUCUN `@UseGuards` ICI, ET C'EST VOULU. `PartnerController` porte le même
// préfixe mais applique JwtAuthGuard au niveau de la classe ; y ajouter cette
// route l'aurait rendue authentifiée, donc inutilisable depuis une boîte mail.
@Controller('integrations/partner')
export class PartnerInvitationController {
  constructor(private readonly invitations: PartnerInvitationService) {}

  // Route publique et non authentifiée : sans limite, elle serait un moyen commode
  // d'énumérer des jetons. La redirection étant identique pour un jeton inconnu,
  // l'énumération n'apprend rien — le throttle évite juste d'en faire les frais.
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('invite/:token')
  async open(@Param('token') token: string, @Req() req: Request, @Res() res: Response) {
    const target = await this.invitations.recordOpen(
      token,
      clientIp(req),
      req.get('user-agent') ?? null,
    );
    // 302 et non 301 : un 301 serait mis en cache par le navigateur et les clics
    // suivants ne repasseraient plus par nous — on perdrait le comptage.
    return res.redirect(302, target);
  }
}

/** IP réelle derrière Traefik. Sans ça, on journaliserait l'adresse du reverse-proxy. */
function clientIp(req: Request): string | null {
  const forwarded = req.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]!.trim();
  return req.ip ?? null;
}
