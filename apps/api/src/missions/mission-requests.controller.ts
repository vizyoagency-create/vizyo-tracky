import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { MissionRequestStatus } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DepotScopeBorneParLeService } from '../depot/depot-scope.decorator';
import { DepotScopeGuard } from '../depot/depot-scope.guard';
import {
  MissionRequestsService,
  type DemandeEntree,
  type TourEntree,
} from './mission-requests.service';

/**
 * Espace depot, lot A6 — les demandes de mission. Cf. docs/A6-DEMANDES-ET-DEVIS.md.
 *
 * ⚠️ CONTROLEUR SEPARE DE `MissionsController`, ET C'EST VOLONTAIRE.
 *
 * Celui-la est FERME AU DEPOT par construction : « un depot est le DESTINATAIRE
 * d'une mission, il n'en cree aucune ». Cette phrase reste vraie — une demande n'est
 * pas une mission. Les melanger aurait oblige a percer le garde du controleur des
 * missions route par route, et la premiere erreur d'inattention aurait ouvert la
 * creation de mission a un tiers.
 *
 * ┌─ POURQUOI `DepotScopeBorneParLeService` ──────────────────────────────────┐
 * │ `DepotScopeGuard` refuse par defaut toute route qu'un DEPOT atteint sans   │
 * │ declaration de perimetre — un default-deny volontaire, pour que l'oubli    │
 * │ d'un decorateur ne puisse pas ouvrir une route.                            │
 * │                                                                            │
 * │ Ici le perimetre ne se lit PAS dans l'URL : il n'y a pas d'identifiant de  │
 * │ mission a verifier. C'est le SERVICE qui borne, a chaque requete, sur      │
 * │ `depotUserId = user.id`. On le declare donc explicitement plutot que de    │
 * │ laisser croire a un oubli — et les tests d'isolation le verifient.         │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
@Controller('mission-requests')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, DepotScopeGuard)
@DepotScopeBorneParLeService()
export class MissionRequestsController {
  constructor(private readonly demandes: MissionRequestsService) {}

  /**
   * Deposer une demande. Le devis est calcule DANS LA FOULEE et fige dans le tour 0
   * (arbitrage D) : le depot voit un prix avant de quitter l'ecran.
   */
  @Post()
  @RequirePermissions('missions_request')
  creer(@Req() req: AuthenticatedRequest, @Body() dto: DemandeEntree) {
    return this.demandes.creer(req.user, dto);
  }

  /**
   * La liste. Un depot ne voit QUE les siennes — borne dans le service, sur
   * `depotUserId`, a chaque requete et jamais depuis un champ de session.
   */
  @Get()
  @RequirePermissions('missions_view')
  lister(
    @Req() req: AuthenticatedRequest,
    @Query('fleetId') fleetId?: string,
    @Query('status') status?: string,
  ) {
    return this.demandes.lister(req.user, fleetId || undefined, this.statutValide(status));
  }

  /** Le detail d'une demande, avec son fil de negociation complet. */
  @Get(':id')
  @RequirePermissions('missions_view')
  detail(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    // `detailPour` verifie l'acces AVANT de rendre quoi que ce soit. Lire puis
    // filtrer laisserait fuiter l'existence d'une demande par son identifiant.
    return this.demandes.detailPour(req.user, id);
  }

  /**
   * Contre-proposer : un tour de plus. Le prix ET les conditions peuvent changer
   * (arbitrage I) — adresses, creneau, distance retenue.
   *
   * Gardee par `missions_request` : c'est la meme capacite de negociation des deux
   * cotes de la table. Le service, lui, distingue les camps.
   */
  @Post(':id/counter')
  @RequirePermissions('missions_request')
  contreProposer(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: TourEntree,
  ) {
    return this.demandes.contreProposer(req.user, id, dto);
  }

  /** Accepter le dernier tour. On n'accepte jamais sa propre offre. */
  @Post(':id/accept')
  @RequirePermissions('missions_request')
  accepter(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.demandes.accepter(req.user, id);
  }

  /** Refuser, motif OBLIGATOIRE : sans lui, l'autre partie repose la meme demande. */
  @Post(':id/reject')
  @RequirePermissions('missions_request')
  refuser(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Body() dto: { reason?: string },
  ) {
    return this.demandes.refuser(req.user, id, dto?.reason ?? '');
  }

  /** Un statut inconnu est ignore, jamais transforme en erreur : c'est un filtre. */
  private statutValide(valeur?: string): MissionRequestStatus | undefined {
    if (!valeur) return undefined;
    return (Object.values(MissionRequestStatus) as string[]).includes(valeur)
      ? (valeur as MissionRequestStatus)
      : undefined;
  }
}
