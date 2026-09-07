import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  TRIP_SHARE_DUREES,
  TRIP_SHARE_DUREE_DEFAUT,
  type TripShareCreatedDto,
  type TripShareDurationDto,
  type TripShareLinkAvecTrajetDto,
  type TripShareLinkDto,
} from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { TripShareService } from './trip-share.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARTAGE DE TRAJET, CÔTÉ CRÉATEUR (AUTHENTIFIÉ)
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le pendant public est `PublicTripShareController`, sans aucun garde. Les deux sont
 * volontairement dans des fichiers distincts.
 *
 * ⚠️ `reports_export` ET NON UNE PERMISSION NEUVE. Partager un trajet, c'est le faire sortir
 * de l'application — exactement ce que cette permission gouverne déjà pour le PDF, le CSV et
 * le classeur. Créer un droit de plus aurait laissé, le temps qu'on y pense, un partage ouvert
 * à des rôles à qui l'export est refusé.
 */
@Controller('trips')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class TripShareController {
  constructor(private readonly partage: TripShareService) {}

  /**
   * Crée un lien public. Le token ne transite QU'ICI — la liste ne le renvoie jamais.
   *
   * ⚠️ LE DÉBIT EST BORNÉ ICI, en plus du plafond de trois liens vivants par trajet. Les deux
   * ne protègent pas de la même chose : le plafond empêche d'oublier des liens sur UN trajet,
   * la borne empêche d'en ouvrir cent sur cent trajets en une minute.
   */
  @Post(':id/share')
  @RequirePermissions('reports_export')
  @Throttle({ default: { ttl: 3_600_000, limit: 30 } })
  async creer(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { duration?: string },
  ): Promise<TripShareCreatedDto> {
    return this.partage.creer(req.user, id, this.dureeValide(body?.duration));
  }

  /** Les liens d'un trajet et leur usage : « ouvert 3 fois, dernière il y a 4 min ». */
  @Get(':id/shares')
  @RequirePermissions('reports_export')
  async listerPourTrajet(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<TripShareLinkDto[]> {
    return this.partage.listerPourTrajet(req.user, id);
  }

  /**
   * L'ÉCRAN DE SURVEILLANCE : tous les liens de la société.
   *
   * ⚠️ SUR `trips/shares`, avant `trips/:id/shares` dans l'ordre de déclaration ? Non — Nest
   * apparie les routes littérales avant les paramétrées quelle que soit leur position, mais
   * `:id/shares` a DEUX segments et `shares` un seul : aucune ambiguïté possible.
   */
  @Get('shares/all')
  @RequirePermissions('reports_export')
  async listerPourSociete(
    @Req() req: AuthenticatedRequest,
    @Query('fleetId') fleetId?: string,
  ): Promise<TripShareLinkAvecTrajetDto[]> {
    /**
     * ⚠️ UN SUPER-ADMIN DOIT DÉSIGNER SA SOCIÉTÉ. Sans `fleetId`, il n'a pas de société
     * courante : lui servir « tous les liens de toutes les sociétés » mélangerait les clients
     * sur un écran dont l'objet est justement de savoir QUI a ouvert QUOI.
     */
    const cible = fleetId || req.user.fleetId;
    if (!cible) return [];
    return this.partage.listerPourSociete(req.user, cible);
  }

  /** Révocation immédiate : le lien cesse de fonctionner à la requête suivante. */
  @Delete('shares/:shareId')
  @RequirePermissions('reports_export')
  async revoquer(
    @Req() req: AuthenticatedRequest,
    @Param('shareId') shareId: string,
  ): Promise<void> {
    return this.partage.revoquer(req.user, shareId);
  }

  /**
   * Une durée inconnue retombe sur le DÉFAUT (24 h), pas sur la plus longue.
   *
   * ⚠️ Un client qui envoie n'importe quoi ne doit pas obtenir sept jours par accident : le
   * repli va toujours vers ce qui expose le moins longtemps parmi ce qui reste utile.
   */
  private dureeValide(valeur: unknown): TripShareDurationDto {
    return TRIP_SHARE_DUREES.includes(valeur as TripShareDurationDto)
      ? (valeur as TripShareDurationDto)
      : TRIP_SHARE_DUREE_DEFAUT;
  }
}
