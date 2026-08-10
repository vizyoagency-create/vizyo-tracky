import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { MissionStatus } from '@prisma/client';
import type {
  DepotDocumentsDto,
  DepotExportFormat,
  DepotExportPreviewDto,
  DepotHistoryDto,
  DepotIncidentDto,
  DepotIncidentInputDto,
  DepotIncidentReason,
  DepotLiveDto,
  DepotMissionDto,
  DepotTripDto,
} from '@vizyo/tracky-shared';
import type { Response } from 'express';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import { DepotDocumentsService } from './depot-documents.service';
import { DepotExportService } from './depot-export.service';
import { DepotHistoryService } from './depot-history.service';
import { DepotIncidentService } from './depot-incident.service';
import { DepotLiveService } from './depot-live.service';
import { DepotScope, DepotScopeBorneParLeService } from './depot-scope.decorator';
import { DepotScopeGuard } from './depot-scope.guard';
import { DepotTripService } from './depot-trip.service';
import { DepotService } from './depot.service';

/**
 * Espace depot (2026-08) — l'API que consomme `/depot`. Cf. design/A1-ROLE-DEPOT.md § 4.
 *
 * Prefixe DEDIE, et pas une reutilisation des controleurs de la flotte : leurs DTO
 * exposent des champs qu'un depot ne doit pas voir. Ici, chaque reponse est construite
 * a partir d'un `select` explicite — ce qui n'est pas selectionne ne peut pas fuir.
 *
 * Lot A1 : les trois routes qui rendent l'isolation VERIFIABLE (liste, detail,
 * position). Lot A3 : les cinq autres d'A1 § 4 — trajet, historique, exports,
 * documents, incidents — plus `GET /depot/live`, la lecture unique de l'ecran carte,
 * et `POST /depot/missions/:id/call`, le seul chemin vers un numero complet.
 *
 * ⚠️ Ce controleur est ouvert aux gestionnaires du transporteur autant qu'aux depots :
 * `missions_view` est accordee aux deux. Ce qui les separe est `DepotScopeGuard`, qui
 * ne borne QUE les comptes DEPOT — un gestionnaire voit les missions de sa flotte par
 * les routes de la flotte, un depot voit les siennes par celles-ci.
 *
 * ⚠️ TOUTE route ajoutee ici DOIT porter `@DepotScope(...)` ou
 * `@DepotScopeBorneParLeService()`. Sans decorateur, le garde refuse (default-deny) —
 * un oubli ferme la route, il ne l'ouvre pas.
 */
@Controller('depot')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard, DepotScopeGuard)
export class DepotController {
  constructor(
    private readonly depot: DepotService,
    private readonly live: DepotLiveService,
    private readonly historique: DepotHistoryService,
    private readonly trajets: DepotTripService,
    private readonly documents: DepotDocumentsService,
    private readonly exports: DepotExportService,
    private readonly incidents: DepotIncidentService,
    private readonly perms: PermissionsResolverService,
  ) {}

  // ═══ Lot A1 — les trois routes qui rendent l'isolation verifiable ══════════

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

  // ═══ Lot A3 — les ecrans ═══════════════════════════════════════════════════

  /**
   * La lecture unique de l'ecran carte : missions du jour, positions des missions au
   * suivi actif, indisponibilites datees, et l'encart qui nomme ce qui est absent.
   *
   * Cf. `DepotLiveService` pour la raison de ne PAS enchainer N appels a
   * `/missions/:id/position` : ils produiraient des 403 legitimes en continu, et
   * rendraient illisibles les refus REELS dans les journaux.
   */
  @Get('live')
  @RequirePermissions('missions_view')
  @DepotScopeBorneParLeService()
  async getLive(@Req() req: AuthenticatedRequest): Promise<DepotLiveDto> {
    return this.live.live(req.user.id, await this.peutVoirConducteur(req));
  }

  /** L'historique et ses 4 KPI, CALCULES COTE SERVEUR (A3 § 8). */
  @Get('history')
  @RequirePermissions('trips_view')
  @DepotScopeBorneParLeService()
  async getHistory(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('plate') plate?: string,
    @Query('destination') destination?: string,
  ): Promise<DepotHistoryDto> {
    return this.historique.history(
      req.user.id,
      {
        from: this.dateValide(from),
        to: this.dateValide(to),
        plate: this.texteFiltre(plate),
        destination: this.texteFiltre(destination),
      },
      await this.peutVoirConducteur(req),
    );
  }

  /** Le trajet d'une mission terminee : 4 tuiles, trace, et le deroule horodate. */
  @Get('trips/:id')
  @RequirePermissions('trips_view')
  @DepotScope('trip', 'id')
  async getTrip(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<DepotTripDto> {
    return this.trajets.trip(req.user.id, id);
  }

  /**
   * Le trajet vu depuis la MISSION — le chemin de « Voir le trajet » sur la carte live.
   *
   * `Trip.missionId` n'est rattache qu'a la cloture : exiger un identifiant de trajet
   * aurait rendu la modale inaccessible pendant la mission, c'est-a-dire au moment ou
   * elle sert le plus. Cf. `DepotTripService.tripDeMission`.
   */
  @Get('missions/:id/trip')
  @RequirePermissions('trips_view')
  @DepotScope('mission', 'id')
  async getTripDeMission(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<DepotTripDto> {
    return this.trajets.tripDeMission(req.user.id, id);
  }

  /** Bons de livraison et rapports. Etat vide sans erreur si le transporteur n'en
   *  produit pas (A3 § 8) : aucune mission terminee = aucun document, c'est normal. */
  @Get('documents')
  @RequirePermissions('trips_view')
  @DepotScopeBorneParLeService()
  async getDocuments(@Req() req: AuthenticatedRequest): Promise<DepotDocumentsDto> {
    return this.documents.documents(req.user.id);
  }

  /** L'interrupteur « rapport automatique ». Ecrit sur SON compte, jamais sur la flotte. */
  @Patch('documents/settings')
  @RequirePermissions('trips_view')
  @DepotScopeBorneParLeService()
  async setDocumentSettings(
    @Req() req: AuthenticatedRequest,
    @Body() body: { weeklyReportEnabled?: unknown },
  ): Promise<{ weeklyReportEnabled: boolean }> {
    return this.documents.definirRapportActif(req.user.id, body?.weeklyReportEnabled !== false);
  }

  /** Le telechargement d'un bon de livraison. L'identifiant est resolu vers une
   *  mission du depot : un identifiant fabrique ne resout rien. */
  @Get('documents/:id/download')
  @RequirePermissions('trips_view')
  @DepotScopeBorneParLeService()
  async downloadDocument(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const mission = await this.documents.missionDuBon(req.user.id, id);
    const fichier = await this.exports.bonDeLivraison(req.user.id, mission.id);
    this.servirFichier(res, fichier);
  }

  /** Le nombre de trajets concernes et le poids estime, AVANT de generer (A3 § 5). */
  @Post('exports/preview')
  @RequirePermissions('trips_view')
  @DepotScopeBorneParLeService()
  async previewExport(
    @Req() req: AuthenticatedRequest,
    @Body() body: { from?: string; to?: string; format?: string },
  ): Promise<DepotExportPreviewDto> {
    const { from, to, format } = this.bornesExport(body);
    return this.exports.apercu(req.user.id, from, to, format);
  }

  /** L'export d'une periode, BORNE aux missions du depot. */
  @Post('exports')
  @RequirePermissions('trips_view')
  @DepotScopeBorneParLeService()
  async createExport(
    @Req() req: AuthenticatedRequest,
    @Body() body: { from?: string; to?: string; format?: string },
    @Res() res: Response,
  ): Promise<void> {
    const { from, to, format } = this.bornesExport(body);
    const fichier = await this.exports.generer(req.user.id, from, to, format);
    this.servirFichier(res, fichier);
  }

  /**
   * Le signalement d'incident — l'une des deux seules ecritures d'un depot.
   *
   * `@DepotScope('mission', 'missionId')` : le garde lit le parametre dans le CORPS
   * (params → body → query). Le service revalide malgre tout le rattachement.
   */
  @Post('incidents')
  @RequirePermissions('missions_view')
  @DepotScope('mission', 'missionId')
  async createIncident(
    @Req() req: AuthenticatedRequest,
    @Body() body: DepotIncidentInputDto,
  ): Promise<DepotIncidentDto> {
    return this.incidents.signaler(req.user.id, {
      missionId: String(body?.missionId ?? ''),
      reason: this.motifValide(body?.reason),
      message: typeof body?.message === 'string' ? body.message : undefined,
    });
  }

  /**
   * Le numero complet du conducteur, pour declencher un appel.
   *
   * ┌─ LE SEUL CHEMIN VERS UN NUMERO COMPLET ───────────────────────────────────┐
   * │ `DepotMissionDto.phone` est masque COTE SERVEUR : « 06 12 •• •• 47 ». Le    │
   * │ numero entier ne transite que par ici, et chaque passage est JOURNALISE.    │
   * │                                                                            │
   * │ Un masquage sans cet endpoint serait un habillage : le bouton « appeler »   │
   * │ aurait besoin du numero, il finirait dans le DTO, et l'onglet reseau le     │
   * │ rendrait a tout le monde. Un endpoint sans le masquage serait inutile.      │
   * │ Les deux ne valent qu'ensemble.                                            │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * `POST` et non `GET` : ce n'est pas une lecture idempotente, c'est un acte qu'on
   * trace. Un `GET` finirait preleve par un cache ou rejoue par un prefetch.
   */
  @Post('missions/:id/call')
  @RequirePermissions('driver_contact_view')
  @DepotScope('mission', 'id')
  async callDriver(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
  ): Promise<{ phone: string }> {
    return this.depot.revelerNumeroConducteur(req.user.id, id);
  }

  // ═══ Utilitaires ═══════════════════════════════════════════════════════════

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

  /** Un motif inconnu retombe sur « Autre » : un signalement ne se perd pas sur une
   *  faute de frappe, il arrive avec le motif le moins engageant. */
  private motifValide(valeur: unknown): DepotIncidentReason {
    const motifs: DepotIncidentReason[] = ['DELAY', 'GOODS', 'DEPOT_ACCESS', 'OTHER'];
    return motifs.includes(valeur as DepotIncidentReason) ? (valeur as DepotIncidentReason) : 'OTHER';
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

  /** Un filtre texte vide vaut « pas de filtre ». Il RESTREINT, il n'ouvre jamais. */
  private texteFiltre(valeur?: string): string | undefined {
    const v = (valeur ?? '').trim();
    return v.length > 0 ? v : undefined;
  }

  /** Repli sur les 7 derniers jours : une periode absente ne doit pas produire un
   *  export vide qu'on interprete comme « aucune mission ». */
  private bornesExport(body: { from?: string; to?: string; format?: string }): {
    from: Date;
    to: Date;
    format: DepotExportFormat;
  } {
    const to = this.dateValide(body?.to) ?? new Date();
    const parDefaut = new Date(to);
    parDefaut.setDate(parDefaut.getDate() - 7);
    return {
      from: this.dateValide(body?.from) ?? parDefaut,
      to,
      format: body?.format === 'CSV' ? 'CSV' : 'PDF',
    };
  }

  private servirFichier(res: Response, fichier: { filename: string; contentType: string; body: Buffer }): void {
    res.setHeader('Content-Type', fichier.contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${fichier.filename}"`);
    res.setHeader('Content-Length', fichier.body.length);
    res.end(fichier.body);
  }
}
