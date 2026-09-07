import { Controller, Get, Ip, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { PartageTrajetPublicDto } from '@vizyo/tracky-shared';
import type { Response } from 'express';
import { TripShareService } from './trip-share.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE TRAJET PARTAGÉ, SANS AUCUNE AUTHENTIFICATION
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ┌─ « PUBLIC » SE DIT PAR L'ABSENCE DE `@UseGuards` ──────────────────────────────────────┐
 * │ Et c'est aussi pourquoi cette route vit dans son PROPRE fichier, comme                 │
 * │ `PublicMissionShareController` : une route ouverte mélangée aux routes gardées finit    │
 * │ par recevoir un garde — ou par en priver une autre le jour d'un refactor.               │
 * └────────────────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ LE DÉBIT EST BORNÉ PLUS SEC QUE LE SUIVI DE LIVRAISON (10/min contre 30). Un suivi se
 * rafraîchit toutes les vingt secondes pendant une livraison ; un trajet terminé se lit UNE
 * fois. Au-delà, ce n'est plus une consultation, c'est une énumération de tokens — et sur une
 * route sans authentification, le débit est la seule chose qui la rende coûteuse.
 */
@Controller('public/trip')
export class PublicTripShareController {
  constructor(private readonly partage: TripShareService) {}

  /**
   * Le trajet partagé. Quatre états mènent au MÊME `410` : expiré, révoqué, inexistant, ou
   * véhicule passé en mode vie privée depuis le partage.
   *
   * ┌─ LES TROIS EN-TÊTES, REPRIS MOT POUR MOT DU LOT A4 ────────────────────────────────────┐
   * │ `X-Robots-Tag: noindex, nofollow` — INDISPENSABLE. Sans lui, un lien collé dans un     │
   * │   message public finit indexé, et le trajet devient consultable par quiconque cherche.  │
   * │ `Cache-Control: no-store` — la réponse porte un tracé GPS : elle ne doit dormir ni dans │
   * │   un cache partagé, ni dans l'historique du navigateur d'un poste partagé.              │
   * │ `Referrer-Policy: no-referrer` — sans lui, le TOKEN part dans l'en-tête `Referer` de la │
   * │   première requête sortante de la page (les tuiles de carte), c'est-à-dire vers un      │
   * │   tiers. C'est la fuite la plus discrète de tout le lot.                                │
   * └────────────────────────────────────────────────────────────────────────────────────────┘
   *
   * Les en-têtes sont posés AVANT l'appel au service : une exception `410` doit les porter
   * autant qu'une réponse `200` — c'est même la réponse la plus susceptible d'être rejouée.
   */
  @Get(':token')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async consulter(
    @Param('token') token: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PartageTrajetPublicDto> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return this.partage.consulterPublic(token, ip);
  }
}
