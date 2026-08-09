import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import { MissionStatus } from '@prisma/client';
import type { DepotMissionDto } from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import { DepotScope, DepotScopeBorneParLeService } from './depot-scope.decorator';
import { DepotScopeGuard } from './depot-scope.guard';
import { DepotService } from './depot.service';

/**
 * Espace depot (2026-08) — l'API que consomme `/depot`. Cf. design/A1-ROLE-DEPOT.md § 4.
 *
 * Prefixe DEDIE, et pas une reutilisation des controleurs de la flotte : leurs DTO
 * exposent des champs qu'un depot ne doit pas voir. Ici, chaque reponse est construite
 * a partir d'un `select` explicite — ce qui n'est pas selectionne ne peut pas fuir.
 *
 * Lot A1 : les trois routes qui rendent l'isolation VERIFIABLE (liste, detail,
 * position). Les cinq autres d'A1 § 4 — historique, exports, documents, incidents —
 * arrivent avec leurs ecrans au lot A3.
 *
 * ⚠️ Ce controleur est ouvert aux gestionnaires du transporteur autant qu'aux depots :
 * `missions_view` est accordee aux deux. Ce qui les separe est `DepotScopeGuard`, qui
 * ne borne QUE les comptes DEPOT — un gestionnaire voit les missions de sa flotte par
 * les routes de la flotte, un depot voit les siennes par celles-ci.
 */
@Controller('depot')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, DepotScopeGuard)
export class DepotController {
  constructor(
    private readonly depot: DepotService,
    private readonly perms: PermissionsResolverService,
  ) {}

  /**
   * Les missions du compte. Le service porte `depotUserId` dans son `where` — d'ou
   * `@DepotScopeBorneParLeService` : on DECLARE que le bornage est fait, on ne se
   * contente pas d'omettre le decorateur (ce qui vaudrait refus).
   */
  @Get('missions')
  @RequirePermissions('missions_view')
  @DepotScopeBorneParLeService()
  async listMissions(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<DepotMissionDto[]> {
    return this.depot.listMissions(
      req.user.id,
      {
        status: this.statutValide(status),
        from: this.dateValide(from),
        to: this.dateValide(to),
      },
      await this.peutVoirConducteur(req),
    );
  }

  /** Une mission. Sans borne horaire : une mission planifiee ou terminee reste lisible. */
  @Get('missions/:id')
  @RequirePermissions('missions_view')
  @DepotScope('mission', 'id')
  async getMission(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<DepotMissionDto> {
    return this.depot.getMission(req.user.id, id, await this.peutVoirConducteur(req));
  }

  /**
   * La position live. `403` hors fenetre — pas `200` avec un corps vide : un corps vide
   * laisserait deduire que la mission existe. Le service applique le second verrou
   * (statut + fenetre) en plus du garde.
   */
  @Get('missions/:id/position')
  @RequirePermissions('missions_view')
  @DepotScope('mission', 'id')
  async getPosition(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.depot.getLivePosition(req.user.id, id);
  }

  /**
   * `driver_contact_view` decide si le bloc conducteur est peuple. Resolu par requete :
   * un retrait de permission prend effet immediatement, sans attendre une reconnexion.
   */
  private peutVoirConducteur(req: AuthenticatedRequest): Promise<boolean> {
    return this.perms.canGlobally(req.user, 'driver_contact_view');
  }

  /** Un statut inconnu est ignore, jamais transforme en erreur : c'est un filtre. */
  private statutValide(valeur?: string): MissionStatus | undefined {
    if (!valeur) return undefined;
    return (Object.values(MissionStatus) as string[]).includes(valeur)
      ? (valeur as MissionStatus)
      : undefined;
  }

  /**
   * Une date invalide est ignoree. ⚠️ Ces bornes sont un FILTRE D'AFFICHAGE : elles ne
   * decident d'aucun acces. Le controle de la fenetre se fait cote serveur, a l'heure
   * serveur, dans `DepotScopeService` — jamais depuis une date envoyee par le client.
   */
  private dateValide(valeur?: string): Date | undefined {
    if (!valeur) return undefined;
    const d = new Date(valeur);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
}
