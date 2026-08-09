import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DepotScopeGuard } from '../depot/depot-scope.guard';
import { MissionsService, type CreerMissionEntree } from './missions.service';

/**
 * Espace depot (2026-08) — creation et gestion des missions, cote TRANSPORTEUR.
 *
 * ⚠️ FERME AU ROLE DEPOT. Un depot est le DESTINATAIRE d'une mission, il n'en cree
 * aucune : `missions_manage` lui est fermee (A1 § 2), et `DepotScopeGuard` refuse par
 * defaut. Il consulte les siennes par `/depot/missions`, dont le DTO est restreint.
 *
 * Lot A2 : la creation, avec ses quatre effets de bord et sa detection de conflit.
 * La liste, la modification et l'annulation suivent dans le meme lot.
 */
@Controller('missions')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, DepotScopeGuard)
export class MissionsController {
  constructor(private readonly missions: MissionsService) {}

  /**
   * Creer une mission.
   *
   * Renvoie la reference generee ET les avertissements non bloquants — ex. « ce
   * vehicule n'a pas encore de boitier : le depot ne verra pas sa position ». Ce cas
   * merite un avertissement plutot qu'un refus : on planifie parfois une mission avant
   * l'installation (A2 § 4).
   *
   * En cas de chevauchement : `409` avec le detail de la mission bloquante, pour que
   * l'interface puisse proposer une sortie plutot qu'annoncer un echec.
   */
  @Post()
  @RequirePermissions('missions_manage')
  creer(@Req() req: AuthenticatedRequest, @Body() dto: CreerMissionEntree) {
    return this.missions.creer(req.user, dto);
  }
}
