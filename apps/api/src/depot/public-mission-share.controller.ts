import { Controller, Get, Ip, Param, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { PublicTrackingDto } from '@vizyo/tracky-shared';
import type { Response } from 'express';
import { MissionShareService } from './mission-share.service';

/**
 * Espace depot (2026-08), lot A4 — le suivi PUBLIC, sans aucune authentification.
 *
 * ┌─ LA SEULE ROUTE OUVERTE DE TOUT L'ESPACE DEPOT ───────────────────────────┐
 * │ « Public » se dit simplement par l'ABSENCE de `@UseGuards(JwtAuthGuard)` —  │
 * │ meme forme que `PublicReservationBookingController`. C'est aussi pourquoi   │
 * │ elle vit dans son propre fichier : une route ouverte melangee aux routes    │
 * │ gardees finit par recevoir un garde, ou par en priver une autre.            │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * PAS DE WEBSOCKET ICI, et c'est deliberé (A4 § 3). Un socket non authentifie est une
 * surface d'attaque disproportionnee pour un point sur une carte : le client interroge
 * toutes les 20 s, ce qui suffit largement a suivre un camion.
 *
 * Cf. design/A4-PARTAGE.md § 3.
 */
@Controller('public/track')
export class PublicMissionShareController {
  constructor(private readonly partage: MissionShareService) {}

  /**
   * Le suivi. Trois etats mènent au MEME `410` : expire, revoque, inexistant.
   *
   * ┌─ LES TROIS EN-TETES ──────────────────────────────────────────────────────┐
   * │ `X-Robots-Tag: noindex, nofollow` — INDISPENSABLE. Sans lui, un lien colle  │
   * │   dans un message public finit indexe, et le suivi devient consultable par  │
   * │   quiconque cherche le nom du transporteur.                                 │
   * │ `Cache-Control: no-store` — la reponse porte une position : elle ne doit    │
   * │   dormir ni dans un cache partage, ni dans l'historique du navigateur.      │
   * │ `Referrer-Policy: no-referrer` — sans lui, le TOKEN part dans l'en-tete     │
   * │   `Referer` de la premiere requete sortante de la page (tuiles de carte),   │
   * │   c'est-a-dire vers un tiers.                                               │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * Les en-tetes sont poses AVANT l'appel au service : une exception `410` doit les
   * porter autant qu'une reponse `200` — c'est meme la reponse la plus susceptible
   * d'etre rejouee.
   */
  @Get(':token')
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async suivre(
    @Param('token') token: string,
    @Ip() ip: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<PublicTrackingDto> {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    return this.partage.suivrePublic(token, ip);
  }
}
