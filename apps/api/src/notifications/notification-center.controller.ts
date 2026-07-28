import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type {
  NotificationDeliveryPageDto,
  NotificationHealthDto,
  NotificationSummaryDto,
} from '@vizyo/tracky-shared';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { NotificationCenterService } from './notification-center.service';

/**
 * CENTRE DE NOTIFICATIONS — surface HTTP (SUPER_ADMIN uniquement), en LECTURE SEULE.
 *
 *   GET /api/admin/notifications/deliveries  — journal filtrable des envois ET des non-envois
 *   GET /api/admin/notifications/summary     — vue d'ensemble + taux de retenue par motif
 *   GET /api/admin/notifications/health      — état de la chaîne (VAPID, périmètre, appareils)
 *
 * ── Pourquoi SUPER_ADMIN et rien d'autre ─────────────────────────────────────────────
 * Le journal contient le TEXTE réellement poussé (plaque, message d'alerte) de TOUTES les
 * flottes, plus l'e-mail des destinataires. C'est un point de fuite inter-flotte évident si
 * on l'ouvre d'un cran. Même garde que les autres vues super-admin : JwtAuthGuard +
 * RolesGuard + @Roles, appliqués au contrôleur entier — jamais méthode par méthode, parce
 * qu'un endpoint ajouté plus tard hériterait alors d'aucune protection.
 *
 * ── Pourquoi aucune écriture ─────────────────────────────────────────────────────────
 * Pas de purge, pas de rejeu, pas d'acquittement en masse. Cet écran sert à COMPRENDRE ;
 * le jour où il pourra aussi agir, une mauvaise manipulation dans un tableau de plusieurs
 * milliers de lignes deviendra un incident de production.
 *
 * ── Owner plateforme ─────────────────────────────────────────────────────────────────
 * `req.user` est transmis au service, qui masque le compte owner aux autres super-admins
 * (listes, tops et compteurs). Le masquage n'est PAS fait ici : un filtre côté contrôleur
 * serait oublié à la première méthode ajoutée.
 */
@Controller('admin/notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class NotificationCenterController {
  constructor(private readonly center: NotificationCenterService) {}

  /**
   * Journal paginé et filtrable.
   *
   * Filtres : période (`from`/`to` ISO), `status`, `channel`, `alertType`, `severity`,
   * `userId`, `fleetId`, `reason`, `search` (titre / corps / e-mail du destinataire).
   * Pagination : `page` (1-based) et `pageSize`. Les bornes (taille de page, profondeur,
   * amplitude de la période) sont imposées par le service, pas négociées par le client :
   * à 330 POWER_CUT par jour, une requête sans borne ramènerait des dizaines de milliers
   * de lignes avec leur corps de message.
   */
  @Get('deliveries')
  deliveries(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
    @Query('alertType') alertType?: string,
    @Query('severity') severity?: string,
    @Query('userId') userId?: string,
    @Query('fleetId') fleetId?: string,
    @Query('reason') reason?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): Promise<NotificationDeliveryPageDto> {
    return this.center.deliveries(
      {
        from,
        to,
        status,
        channel,
        alertType,
        severity,
        userId,
        fleetId,
        reason,
        search,
        page: this.num(page),
        pageSize: this.num(pageSize),
      },
      req.user,
    );
  }

  /**
   * Vue d'ensemble sur la période : totaux par statut / type / canal / sévérité, top
   * destinataires, taux de retenue et répartition par motif.
   *
   * Les filtres acceptés sont volontairement restreints à ceux qui gardent la synthèse
   * lisible (période, canal, flotte, destinataire) : filtrer par statut avant de lire un
   * taux calculé SUR les statuts ne veut rien dire.
   */
  @Get('summary')
  summary(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('channel') channel?: string,
    @Query('fleetId') fleetId?: string,
    @Query('userId') userId?: string,
  ): Promise<NotificationSummaryDto> {
    return this.center.summary({ from, to, channel, fleetId, userId }, req.user);
  }

  /**
   * État de la chaîne : VAPID configuré, périmètre de déploiement en cours, appareils
   * abonnés par rôle, date du dernier push accepté, et les utilisateurs éligibles SANS
   * appareil — le trou qui fait qu'une personne se croit notifiée sans l'être.
   */
  @Get('health')
  health(@Req() req: AuthenticatedRequest): Promise<NotificationHealthDto> {
    return this.center.health(req.user);
  }

  /** Entier de query string. Une valeur illisible est ignorée : le service applique son défaut. */
  private num(value?: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) ? n : undefined;
  }
}
