import { Body, Controller, Delete, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type {
  MissionShareCreatedDto,
  MissionShareLinkDto,
  ShareDurationDto,
} from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DepotScope, DepotScopeBorneParLeService } from './depot-scope.decorator';
import { DepotScopeGuard } from './depot-scope.guard';
import { MissionShareService } from './mission-share.service';

/**
 * Espace depot (2026-08), lot A4 — le partage, cote CREATEUR (authentifie).
 *
 * Le pendant public est `PublicMissionShareController`, sans aucun garde. Les deux
 * sont volontairement dans des fichiers distincts : melanger une route gardee et une
 * route ouverte dans un meme controleur, c'est se preparer a oublier un `@UseGuards`.
 *
 * ┌─ DEUX LIMITES QUI NE SONT PAS DE L'ANTI-ABUS THEORIQUE ───────────────────┐
 * │ 3 liens actifs par mission, 20 creations par heure et par compte.           │
 * │                                                                            │
 * │ Sans elles, un depot genere un lien par client et transforme le suivi en    │
 * │ flux public — ce que le transporteur a precisement refuse quand il a ouvert │
 * │ l'acces (A4 § 3).                                                          │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Cf. design/A4-PARTAGE.md § 3.
 */
@Controller('depot')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, DepotScopeGuard)
export class MissionShareController {
  constructor(private readonly partage: MissionShareService) {}

  /**
   * Cree un lien public. Le token ne transite QU'ICI — la liste ne le renvoie pas.
   *
   * ┌─ LA LIMITE DE 20/H EST APPLIQUEE DANS LE SERVICE, PAS ICI ────────────────┐
   * │ `@Throttle` compte par ADRESSE IP (`req.ip`, cf. le commentaire de main.ts │
   * │ sur `trust proxy`). Or la spec demande « 20 creations par heure et par     │
   * │ COMPTE » (A4 § 3) — ce n'est pas la meme chose : deux depots derriere le   │
   * │ meme routeur d'entreprise partageraient un seul compteur, et le premier    │
   * │ qui partage beaucoup bloquerait le second.                                 │
   * │                                                                            │
   * │ La limite par compte vit donc dans `MissionShareService`, qui compte les   │
   * │ liens crees par CE compte dans l'heure. Le plafond global de la plateforme │
   * │ (100 req/min par IP) reste actif : il protege l'infrastructure, pas la     │
   * │ regle metier.                                                              │
   * └────────────────────────────────────────────────────────────────────────────┘
   */
  @Post('missions/:id/share')
  @RequirePermissions('mission_share')
  @DepotScope('mission', 'id')
  async creer(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() body: { duration?: string },
  ): Promise<MissionShareCreatedDto> {
    return this.partage.creer(req.user, id, this.dureeValide(body?.duration));
  }

  /** Les liens d'une mission et leur usage : « ouvert 3 fois, derniere il y a 4 min ». */
  @Get('missions/:id/shares')
  @RequirePermissions('mission_share')
  @DepotScope('mission', 'id')
  async lister(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<MissionShareLinkDto[]> {
    return this.partage.lister(req.user, id);
  }

  /**
   * Revocation immediate.
   *
   * `@DepotScopeBorneParLeService` : le parametre est un identifiant de LIEN, pas de
   * mission — le garde ne saurait pas le resoudre. Le service verifie donc lui-meme le
   * rattachement, et on le DECLARE ici plutot que d'omettre le decorateur (ce qui
   * vaudrait refus, cf. le default-deny d'A1).
   */
  @Delete('shares/:id')
  @RequirePermissions('mission_share')
  @DepotScopeBorneParLeService()
  async revoquer(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<void> {
    return this.partage.revoquer(req.user, id);
  }

  /** Une duree inconnue retombe sur la plus COURTE : par defaut, on protege. */
  private dureeValide(valeur: unknown): ShareDurationDto {
    const connues: ShareDurationDto[] = ['MIN_15', 'HOUR_1', 'UNTIL_MISSION_END'];
    return connues.includes(valeur as ShareDurationDto) ? (valeur as ShareDurationDto) : 'MIN_15';
  }
}
