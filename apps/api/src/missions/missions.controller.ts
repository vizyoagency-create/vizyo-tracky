import { BadRequestException, Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { MissionStatus } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DepotScopeGuard } from '../depot/depot-scope.guard';
import {
  MissionsService,
  type CreerMissionEntree,
  type ModifierMissionEntree,
} from './missions.service';

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

  /**
   * La liste des missions de la flotte + ses 5 compteurs. Alimente l'onglet Missions
   * de `/agenda`.
   */
  @Get()
  @RequirePermissions('missions_view')
  lister(
    @Req() req: AuthenticatedRequest,
    @Query('status') status?: string,
    @Query('depotUserId') depotUserId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('fleetId') fleetId?: string,
  ) {
    return this.missions.lister(req.user, {
      status: this.statutValide(status),
      depotUserId: depotUserId || undefined,
      from: this.dateValide(from),
      to: this.dateValide(to),
      fleetId: fleetId || undefined,
    });
  }

  /**
   * La mission en cours d'un véhicule, ou `null`. Alimente le bandeau de la fiche
   * véhicule (A2 § 9).
   *
   * ⚠️ Déclarée AVANT toute route à paramètre : Nest résout dans l'ordre, et
   * `vehicle/:vehicleId` serait sinon capté par un `:id` déclaré plus haut.
   */
  @Get('vehicle/:vehicleId/current')
  @RequirePermissions('missions_view')
  missionEnCours(
    @Req() req: AuthenticatedRequest,
    @Param('vehicleId') vehicleId: string,
    @Query('fleetId') fleetId?: string,
  ) {
    return this.missions.missionEnCours(req.user, vehicleId, fleetId || undefined);
  }

  /**
   * Le nombre de missions en cours par compte dépôt. Alimente la colonne
   * « Périmètre » de `/users`, qui porte **l'activité** et non un scope (A5 § 3).
   *
   * Gardée par `missions_view` : c'est de la donnée de mission, pas d'utilisateur.
   */
  @Get('depot-activity')
  @RequirePermissions('missions_view')
  activiteDesDepots(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.missions.activiteDesDepots(req.user, fleetId || undefined);
  }

  /** Les comptes dépôt de la flotte — alimente le sélecteur de destinataire. */
  @Get('depots')
  @RequirePermissions('missions_manage')
  depots(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.missions.listerDepots(req.user, fleetId || undefined);
  }

  /**
   * Les véhicules sur un créneau, AVEC leur motif d'occupation.
   *
   * Renvoie les occupés aussi : la modale les affiche grisés avec leur motif plutôt
   * que de les masquer. Un véhicule qui disparaît sans explication renvoie le
   * gestionnaire au formulaire cinq fois (A2 § 4, niveau 1).
   */
  @Get('vehicle-availability')
  @RequirePermissions('missions_manage')
  disponibilite(
    @Req() req: AuthenticatedRequest,
    @Query('startAt') startAt: string,
    @Query('endAt') endAt: string,
    @Query('fleetId') fleetId?: string,
  ) {
    const debut = this.dateValide(startAt);
    const fin = this.dateValide(endAt);
    if (!debut || !fin) throw new BadRequestException('Créneau invalide');
    return this.missions.disponibiliteVehicules(req.user, debut, fin, fleetId || undefined);
  }

  /**
   * Modifier une mission. Le périmètre dépend du statut (A2 § 6) : une mission
   * planifiée est entièrement modifiable, une mission en cours ne laisse toucher que
   * l'heure de fin, le conducteur et les notes, une mission terminée que les notes.
   *
   * Un champ interdit est **refusé**, jamais ignoré : l'interface ne doit pas pouvoir
   * afficher une valeur que le serveur n'a pas écrite.
   *
   * Renvoie `impactFenetre` quand l'heure de fin bouge sur une mission qui a un dépôt
   * destinataire — c'est ce qui permet à l'écran de dire « l'accès du dépôt est étendu
   * de 40 minutes » plutôt qu'un « enregistré » muet.
   */
  @Patch(':id')
  @RequirePermissions('missions_manage')
  modifier(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: ModifierMissionEntree,
    @Query('fleetId') fleetId?: string,
  ) {
    return this.missions.modifier(req.user, id, dto, fleetId || undefined);
  }

  /**
   * Annuler une mission. Motif OBLIGATOIRE : sans lui, la mention « Annulee par le
   * transporteur » que lit le depot serait muette, et il rappellerait pour demander
   * pourquoi — exactement l'appel que la fonctionnalite doit supprimer.
   */
  @Post(':id/cancel')
  @RequirePermissions('missions_manage')
  annuler(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: { reason?: string },
    @Query('fleetId') fleetId?: string,
  ) {
    return this.missions.annuler(req.user, id, dto?.reason ?? '', fleetId || undefined);
  }

  /**
   * EFFET 4 — « mes missions », pour le CONDUCTEUR. Alimente `/driver`.
   *
   * Gardee par `missions_view`, que le role DRIVER porte par defaut — bornee aux
   * SIENNES cote service (`where` sur son `driverId`). Chaque mission renvoyee porte
   * `depotWatching` : le conducteur doit savoir qu'un tiers voit sa position pendant
   * la mission. Obligation de conformite, pas une politesse (A2 § 3.4).
   */
  @Get('mine')
  @RequirePermissions('missions_view')
  mesMissions(@Req() req: AuthenticatedRequest) {
    return this.missions.missionsDuConducteur(req.user);
  }

  /** Un statut inconnu est ignore, jamais transforme en erreur : c'est un filtre. */
  private statutValide(valeur?: string): MissionStatus | undefined {
    if (!valeur) return undefined;
    return (Object.values(MissionStatus) as string[]).includes(valeur)
      ? (valeur as MissionStatus)
      : undefined;
  }

  private dateValide(valeur?: string): Date | undefined {
    if (!valeur) return undefined;
    const d = new Date(valeur);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
}
