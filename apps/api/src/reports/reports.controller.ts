import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { Response } from 'express';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import { CONDUCTEUR_AUCUN, resolveDriverScope, type PorteeConducteur } from '../common/driver-scope';
import { parisDayKey, parisDayStart } from '../common/utils/datetime';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { GenerateExcelDto } from './dto/generate-excel.dto';
import { GeneratePdfDto } from './dto/generate-pdf.dto';
import { SetReportScheduleDto } from './dto/set-report-schedule.dto';
import { ReportCsvService } from './report-csv.service';
import { ReportScheduleService } from './report-schedule.service';
import { ReportExcelService } from './report-excel.service';
import { ReportPdfService } from './report-pdf.service';
import { ReportsStatsService } from './reports-stats.service';
import { enTeteTelechargement } from '../common/utils/telechargement';
import { SpeedReportService } from './speed-report.service';

/**
 * V1.5 (Sprint L) — Endpoints de rapports.
 *
 *  - GET /api/reports/stats?fleetId=&from=&to=    : KPIs JSON
 *  - GET /api/reports/pdf?fleetId=&from=&to=      : binaire PDF
 *  - GET /api/reports/csv?type=positions|trips|alerts|commands&fleetId=&from=&to=
 *
 * Tenant check : un FLEET_ADMIN/MANAGER ne peut acceder qu'a sa flotte.
 * Un SUPER_ADMIN peut specifier n'importe quel fleetId.
 */
@Controller('reports')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class ReportsController {
  constructor(
    private readonly stats: ReportsStatsService,
    private readonly pdf: ReportPdfService,
    private readonly csv: ReportCsvService,
    private readonly excel: ReportExcelService,
    private readonly speedReport: SpeedReportService,
    private readonly schedule: ReportScheduleService,
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
    private readonly systemActivity: SystemActivityService,
  ) {}

  /**
   * Journal Système — un export = une exfiltration de données (positions GPS
   * complètes) déclenchable par un simple VIEWER : chaque téléchargement est
   * tracé avec son périmètre. Fire-and-forget, ne casse jamais le download.
   */
  private recordExport(
    req: AuthenticatedRequest,
    action: string,
    filename: string,
    fleetId: string | null,
    meta?: Record<string, unknown>,
  ): void {
    const u = req.user;
    this.systemActivity.record({
      category: 'EXPORT',
      action,
      status: 'SUCCESS',
      actor: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'utilisateur',
      target: filename,
      fleetId: fleetId ?? u.fleetId ?? null,
      triggeredByUserId: u.id,
      meta,
    });
  }

  /**
   * Un export qui ÉCHOUE ne laissait AUCUNE trace : le client voyait un bandeau rouge, et
   * l'espace admin ne voyait rien du tout. Une société incapable de sortir ses rapports
   * depuis trois jours était donc invisible — seuls les téléchargements RÉUSSIS étaient
   * journalisés. Même journal, statut FAILURE, avec la raison.
   *
   * Ne change rien au comportement HTTP : l'erreur est relancée telle quelle.
   */
  private async traceEchec<T>(
    req: AuthenticatedRequest,
    action: string,
    fleetId: string | null,
    meta: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (err) {
      const raison = err instanceof Error ? err.message : String(err);
      const u = req.user;
      this.systemActivity.record({
        category: 'EXPORT',
        action,
        status: 'FAILURE',
        actor: [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || 'utilisateur',
        target: raison.slice(0, 200),
        fleetId: fleetId ?? u.fleetId ?? null,
        triggeredByUserId: u.id,
        meta: { ...meta, erreur: raison },
      });
      throw err;
    }
  }

  /**
   * 🔒 Sprint 5 — borne de perimetre transmise a chaque service de rapport :
   * 'ALL' pour les admins, sinon la liste des vehicules accessibles de l'user.
   * Memoise par requete (cf. VehicleAccessService).
   */
  private accessibleVehicleIds(req: AuthenticatedRequest): Promise<string[] | 'ALL'> {
    return this.vehicleAccess.getAccessibleVehicleIds(req.user);
  }

  /**
   * Dates du nom de fichier, en jours civils de Paris et fin INCLUSE : la borne `to` de
   * l'API est le lendemain minuit, et « rapport-2026-08-03_2026-09-03 » faisait croire
   * que le 3 septembre était dedans.
   */
  private fileDates(from: Date, to: Date): string {
    return `${parisDayKey(from)}_${parisDayKey(new Date(to.getTime() - 1))}`;
  }

  /**
   * ══ LE FILTRE CONDUCTEUR DES EXPORTS, ET SON LIBELLÉ ══════════════════════════════════
   *
   * ── LE DÉFAUT QUE CETTE MÉTHODE FERME ──────────────────────────────────────────────────
   *
   * L'écran Rapports se filtre sur une personne depuis F13 : le tableau, le résumé
   * journalier, les graphiques et la synthèse suivent. Les EXPORTS, eux, ne suivaient rien.
   * Un gestionnaire filtré sur un conducteur qui cliquait « CSV trajets » recevait TOUS les
   * trajets de la société ; son PDF et son Excel décrivaient une autre population que son
   * écran. C'est le défaut le plus cher de ce produit — un fichier qui contredit l'écran qui
   * l'a produit —, et il se paie deux fois : le fichier voyage, et il n'a pas de démenti.
   *
   * ── UNE SEULE RÈGLE, ET UN LIBELLÉ ─────────────────────────────────────────────────────
   *
   * La VALIDATION est celle de tout le monde (`resolveDriverScope`, `common/driver-scope`) :
   * un UUID, ou `none` pour les trajets sans conducteur, et rien d'autre. Aucune seconde
   * écriture ici — le jour où la règle bouge, elle bouge pour la liste, la synthèse ET les
   * documents.
   *
   * Le LIBELLÉ, lui, est propre aux documents : un PDF ou un classeur doit DIRE de qui il
   * parle. Il est résolu ICI, une fois, pour les deux — deux lectures séparées finiraient
   * par nommer la même personne de deux façons.
   *
   * ⚠️ Le nom est cherché DANS LA SOCIÉTÉ DU RAPPORT. Un identifiant venu d'ailleurs ne
   * rend aucun trajet (les `where` portent déjà `fleetId`) : plutôt que de laisser le
   * document muet sur un périmètre vide, on l'annonce comme introuvable. Un fichier à zéro
   * ligne sans explication se lit comme « ce conducteur n'a pas roulé », ce qui est faux.
   *
   * @returns `nom` = la désignation NUE (« Sohaib Hamanni », « Sans conducteur »), que
   *   l'Excel enchâsse dans ses propres phrases ; `titre` = la ligne prête à imprimer du
   *   PDF. Deux formes parce que deux documents, une seule lecture en base.
   */
  private async filtreConducteur(
    fleetId: string | null,
    driverId: string | undefined,
  ): Promise<{ scope: PorteeConducteur; nom: string | null; titre: string | null }> {
    const scope = resolveDriverScope(driverId);
    if (scope === undefined) return { scope, nom: null, titre: null };
    if (scope === null) {
      return { scope, nom: 'Sans conducteur', titre: `Trajets sans conducteur (filtre « ${CONDUCTEUR_AUCUN} »)` };
    }
    const d = fleetId
      ? await this.prisma.driver.findFirst({
          where: { id: scope, fleetId },
          select: { firstName: true, lastName: true },
        })
      : null;
    const nom = d ? `${d.firstName} ${d.lastName}`.trim() : '';
    if (nom) return { scope, nom, titre: `Conducteur : ${nom}` };
    const inconnu = `conducteur introuvable dans cette société (identifiant ${scope.slice(0, 8)}…)`;
    return { scope, nom: inconnu, titre: `Conducteur : ${inconnu}` };
  }

  /**
   * ⚠️ LES `@Query()` DE CETTE ROUTE S'ÉCRIVENT `?: string`, JAMAIS `string | undefined`.
   *
   * Ce n'est pas une coquetterie de style, c'est ce qui fait la différence entre un 400 et
   * un 500. `emitDecoratorMetadata` émet `design:paramtypes` : `?: string` donne le métatype
   * `String`, `string | undefined` donne `Object` (sous `strictNullChecks`, TypeScript
   * n'élide plus `undefined` de l'union et retombe sur `Object`). Or le `ValidationPipe`
   * global de `main.ts` ne convertit QUE pour `String` (`transformPrimitive` :
   * `if (metatype === String …) return String(value)`).
   *
   * Conséquence mesurée sur `?driverId=a&driverId=b` — une URL recopiée, un client qui
   * ré-ajoute le filtre, un `HttpParams.append` au lieu de `set` : express rend `['a','b']`.
   * En `String`, le pipe coerce en `"a,b"`, l'expression partagée le refuse et la route rend
   * le MÊME 400 nommant le champ que les sept autres portes qui portent ce filtre. En
   * `Object`, le tableau arrive intact jusqu'à `(driverId ?? '').trim()` : `TypeError`, 500
   * « Internal server error » servi au client, et une CRITICAL au centre d'alerte pour une
   * requête simplement malformée. Même histoire pour `vehicleIds`, dont le `.split(',')`
   * juste en dessous casse de la même façon.
   *
   * Le métatype est figé par un test (`exports-filtre-conducteur.spec.ts`, « la coercition
   * du ValidationPipe ») : réécrire ces paramètres en union le fait tomber.
   */
  @Get('stats')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_view')
  async statsJson(
    @Req() req: AuthenticatedRequest,
    @Query('fleetId') fleetIdQ?: string,
    // `from` et `to` restent OBLIGATOIRES pour l'appelant — mais optionnels ici, sans quoi
    // TypeScript refuse un paramètre requis après un optionnel (TS1016). Leur absence est
    // refusée par `parseRange`, qui rend le même 400 « from et to (ISO date) requis »
    // qu'avant : le pipe laisse déjà `undefined` intact, `?? ''` ne change donc rien.
    @Query('from') fromRaw?: string,
    @Query('to') toRaw?: string,
    @Query('vehicleIds') vehicleIdsQ?: string,
    @Query('topN') topNQ?: string,
    @Query('driverId') driverIdQ?: string,
  ) {
    const { from, to, fleetId } = await this.parseRange(req, fleetIdQ, fromRaw ?? '', toRaw ?? '');
    const accessibleVehicleIds = await this.accessibleVehicleIds(req);
    /**
     * ── DEUX PARAMÈTRES QUE LE SERVICE ACCEPTAIT DÉJÀ, ET QUE LA ROUTE TAISAIT ─────────
     *
     * `compute` sait restreindre à des véhicules et régler la profondeur du classement
     * depuis toujours ; seule cette route ne le laissait pas dire. L'écran Rapports, qui
     * filtre par véhicule et par groupe, ne pouvait donc pas demander SON périmètre — et
     * c'est la raison pour laquelle il additionnait lui-même les trajets de la page chargée,
     * en affichant un récapitulatif faux dès l'ouverture.
     *
     * ⚠️ Le périmètre demandé ne desserre RIEN : `compute` l'intersecte avec les véhicules
     * réellement accessibles à l'appelant. Demander un véhicule d'une autre société ne le
     * rend pas visible, il disparaît simplement du résultat.
     */
    const vehicleIds = (vehicleIdsQ ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => v.length > 0);
    /**
     * ── LE FILTRE CONDUCTEUR SUIT LA SYNTHÈSE AUSSI (F13) ─────────────────────────────
     *
     * Sans lui, la page Rapports filtrée sur une personne montrerait un tableau de SES
     * trajets sous une synthèse décrivant toute la société — deux réponses à deux questions
     * différentes, présentées comme une seule. Deux formes acceptées : un UUID, ou `none`
     * pour les trajets sans conducteur ; `compute` valide et refuse le reste.
     *
     * ⚠️ Les ALERTES, elles, restent hors de ce filtre : elles appartiennent à un véhicule et
     * n'ont pas de conducteur (cf. `alertWhere` dans `reports-stats.service`). L'écran le dit.
     */
    return this.stats.compute(fleetId, from, to, { role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds }, {
      vehicleIds: vehicleIds.length > 0 ? vehicleIds : undefined,
      topN: topNQ ? Number(topNQ) : undefined,
      driverId: driverIdQ,
    });
  }

  /**
   * ⚠️ `driverId` EST ACCEPTÉ ICI AUSSI (F13). Cette route « rapide » est le raccourci sans
   * modale : rien ne justifie qu'elle rende un autre périmètre que la variante configurable
   * juste en dessous — un même écran, deux chemins, deux documents différents.
   */
  @Get('pdf')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_export')
  async pdfDownload(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('fleetId') fleetIdQ: string | undefined,
    @Query('from') fromRaw: string,
    @Query('to') toRaw: string,
    @Query('driverId') driverIdQ?: string,
  ): Promise<void> {
    await this.traceEchec(req, 'export_pdf', fleetIdQ ?? null, { from: fromRaw, to: toRaw, driverId: driverIdQ ?? undefined }, async () => {
      const { from, to, fleetId } = await this.parseRange(req, fleetIdQ, fromRaw, toRaw);
      const accessibleVehicleIds = await this.accessibleVehicleIds(req);
      // ⚠️ Résolu AVANT le calcul : une valeur invalide doit refuser l'export, pas produire
      // un document de toute la flotte que le client lirait comme le sien.
      const conducteur = await this.filtreConducteur(fleetId, driverIdQ);
      const report = await this.stats.compute(
        fleetId, from, to,
        { role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds },
        { driverId: driverIdQ },
      );
      const buffer = await this.pdf.generate(report, { driverLabel: conducteur.titre ?? undefined });
      const filename = `tracky-rapport-${this.fileDates(from, to)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', enTeteTelechargement(filename));
      res.send(buffer);
      this.recordExport(req, 'export_pdf', filename, fleetId, { from: fromRaw, to: toRaw, driverId: driverIdQ ?? undefined });
    });
  }

  /**
   * Variante configurable du PDF — permet de filtrer par vehicleIds et de
   * choisir les sections embarquees. Le GET historique reste expose pour
   * compat. Les rapports sont generes a la volee (pas de cache) — l'utilisateur
   * sent immediatement le scope qu'il a configure.
   */
  @Post('pdf')
  @HttpCode(200)
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_export')
  async pdfDownloadConfigured(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Body() body: GeneratePdfDto,
  ): Promise<void> {
    await this.traceEchec(req, 'export_pdf', body.fleetId ?? null, { from: body.from, to: body.to, vehicleIds: body.vehicleIds?.length || undefined, driverId: body.driverId ?? undefined }, () =>
      this.genererPdfConfigure(req, res, body));
  }

  /** Corps du POST /pdf — extrait pour que l'échec comme la réussite soient journalisés. */
  private async genererPdfConfigure(
    req: AuthenticatedRequest,
    res: Response,
    body: GeneratePdfDto,
  ): Promise<void> {
    const { from, to, fleetId } = await this.parseRange(req, body.fleetId, body.from, body.to, body.vehicleIds);

    const vehicleIds = (body.vehicleIds ?? []).filter((id) => !!id);

    // Un rapport sur UN véhicule s'appelait « Rapport de flotte » et n'affichait pas la
    // plaque ; jusqu'à cinq véhicules, les plaques sont listées ; au-delà, un compte.
    let scopeLabel: string | undefined;
    let title: string | undefined;
    let fileScope = '';
    if (vehicleIds.length > 0) {
      const plates = await this.prisma.vehicle.findMany({
        where: { id: { in: vehicleIds } },
        select: { plate: true, brand: true, model: true },
        orderBy: { plate: 'asc' },
      });
      if (plates.length === 1) {
        const v = plates[0]!;
        title = 'Rapport véhicule';
        scopeLabel = [v.plate, [v.brand, v.model].filter(Boolean).join(' ')].filter(Boolean).join(' — ');
        fileScope = `${v.plate.replace(/[^A-Za-z0-9-]+/g, '-')}-`;
      } else if (plates.length <= 5) {
        scopeLabel = `${plates.length} véhicules : ${plates.map((v) => v.plate).join(', ')}`;
      } else {
        scopeLabel = `${plates.length} véhicules sélectionnés`;
      }
    }

    const accessibleVehicleIds = await this.accessibleVehicleIds(req);
    /**
     * ── LE PÉRIMÈTRE CONDUCTEUR DU DOCUMENT (F13) ───────────────────────────────────────
     *
     * Le périmètre VÉHICULE était déjà annoncé (`scopeLabel`, sous le nom de la société) ;
     * le conducteur ne l'était pas du tout, et il ne descendait même pas dans le calcul. Un
     * PDF filtré sur une personne portait donc les chiffres de tout le parc, sous un titre
     * qui ne démentait rien.
     */
    const conducteur = await this.filtreConducteur(fleetId, body.driverId);
    const report = await this.stats.compute(
      fleetId,
      from,
      to,
      { role: req.user.role, fleetId: req.user.fleetId, accessibleVehicleIds },
      { vehicleIds, maxRecentTrips: body.maxTrips, topN: body.topN, driverId: body.driverId },
    );

    const buffer = await this.pdf.generate(report, {
      sections: body.sections,
      maxTrips: body.maxTrips,
      topN: body.topN,
      scopeLabel,
      title,
      driverLabel: conducteur.titre ?? undefined,
    });

    const filename = `tracky-rapport-${fileScope}${this.fileDates(from, to)}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', enTeteTelechargement(filename));
    res.send(buffer);
    this.recordExport(req, 'export_pdf', filename, fleetId, {
      from: body.from, to: body.to, vehicleIds: vehicleIds.length || undefined,
      driverId: body.driverId ?? undefined,
    });
  }

  /**
   * ══ LE FILTRE CONDUCTEUR NE VAUT QUE POUR LES TRAJETS, ET LA ROUTE LE DIT ══════════════
   *
   * Un TRAJET porte son conducteur (`Trip.driverId`) : le CSV « trajets » suit donc le filtre
   * de l'écran, exactement comme il suit déjà son périmètre véhicule.
   *
   * ⚠️ LES TROIS AUTRES TYPES N'ONT PAS DE CONDUCTEUR, ET C'EST DÉFINITIF :
   *
   *   - une POSITION est un point d'un boîtier ;
   *   - une ALERTE appartient à un véhicule (la rattacher à quelqu'un demanderait de deviner
   *     qui conduisait à son horodatage — une accusation, pas une donnée) ;
   *   - une COMMANDE moteur est envoyée à un boîtier par un utilisateur, pas par un conducteur.
   *
   * Trois conduites étaient possibles. Les servir en ignorant le filtre — ce que faisait le
   * code — rend une AUTRE population sous un nom de fichier qu'on croit filtré : c'est le
   * défaut qu'on répare, on ne va pas le laisser ici. Les servir en les vidant serait pire
   * encore (« cette personne n'a déclenché aucune alerte » est faux). Reste le REFUS EXPLICITE,
   * avec la raison en clair : le client apprend pourquoi, et sait quoi faire.
   *
   * L'écran, lui, n'attend pas ce refus pour le dire : sous un filtre conducteur, le bouton
   * « CSV alertes » est désactivé et la mention d'export porte la même phrase (cf.
   * `reports.component`). Ce 400 est la ceinture — un autre client, une URL recopiée.
   */
  @Get('csv')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_export')
  async csvDownload(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Query('type') type: string,
    @Query('fleetId') fleetIdQ: string | undefined,
    @Query('from') fromRaw: string,
    @Query('to') toRaw: string,
    @Query('vehicleIds') vehicleIdsRaw?: string,
    @Query('driverId') driverIdQ?: string,
  ): Promise<void> {
    await this.traceEchec(req, `export_csv_${type}`, fleetIdQ ?? null, { from: fromRaw, to: toRaw, driverId: driverIdQ ?? undefined }, async () => {
      const { from, to, fleetId } = await this.parseRange(req, fleetIdQ, fromRaw, toRaw);
      // Périmètre de l'ÉCRAN (véhicule ou groupe sélectionné), borné aux accès de l'appelant :
      // un CSV « trajets » demandé depuis un rapport filtré sur un véhicule exportait toute la
      // flotte. `resolveReportVehicleScope` rejette (403) toute demande hors périmètre.
      const wanted = (vehicleIdsRaw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      const ids = resolveReportVehicleScope(await this.accessibleVehicleIds(req), wanted);
      // Même règle que partout — un UUID ou `none`, rien d'autre (cf. `common/driver-scope`).
      // Résolue AVANT le `switch` : une valeur invalide refuse l'export quel que soit le type.
      const driverScope = resolveDriverScope(driverIdQ);
      /**
       * Le refus, écrit UNE fois et posé sur les trois types concernés.
       *
       * ⚠️ `sujet` est un littéral du `switch`, jamais la valeur brute de la requête : rien
       * de ce que l'appelant écrit ne revient dans le message.
       */
      const refuserSansConducteur = (sujet: string): void => {
        if (driverScope === undefined) return;
        throw new BadRequestException(
          `L'export « ${sujet} » ne peut pas suivre un filtre conducteur : une position, une alerte `
          + 'et une commande appartiennent à un véhicule ou à un boîtier, jamais à une personne. '
          + "Seul l'export « trajets » porte un conducteur. Retirez le filtre conducteur pour obtenir ce fichier.",
        );
      };
      let result;
      switch (type) {
        case 'positions': refuserSansConducteur('positions'); result = await this.csv.positions(fleetId, from, to, ids); break;
        // ⚠️ Le NOM que rend le service porte le filtre (`-sans-conducteur`, `-conducteur-<8>`) :
        //    c'est le seul endroit où un CSV peut le dire, et c'est ce nom qui part dans le
        //    `Content-Disposition` ci-dessous et dans la trace d'export. Sous « none », deux
        //    fichiers de la même période étaient sinon indiscernables — toutes leurs lignes ont
        //    un conducteur vide (1 905 trajets sur 1 956 chez « mh cars »).
        //    ⚠️ ET CE NOM ATTEINT LE NAVIGATEUR : `reports.service.downloadCsv` LIT cet
        //    en-tête (`observe: 'response'` puis `filenameFromResponse`) au lieu de refabriquer
        //    le sien, l'ancien nom ne servant plus que de repli si un proxy filtre l'en-tête.
        //    Le `-PARTIEL` de la troncature passe par le même canal — il était avalé jusqu'à
        //    ce lot. Quatre cas le figent (`filtre-conducteur-ecran.spec.ts`, « Export CSV —
        //    la marque conducteur du nom de fichier atteint le navigateur ») : ne rebranchez
        //    pas un nom fabriqué côté client, ils tomberaient.
        case 'trips': result = await this.csv.trips(fleetId, from, to, ids, driverScope); break;
        case 'alerts': refuserSansConducteur('alertes'); result = await this.csv.alerts(fleetId, from, to, ids); break;
        case 'commands': refuserSansConducteur('commandes'); result = await this.csv.commands(fleetId, from, to, ids); break;
        default:
          throw new BadRequestException('type doit valoir positions / trips / alerts / commands');
      }
      res.setHeader('Content-Type', result.contentType);
      res.setHeader('Content-Disposition', enTeteTelechargement(result.filename));
      res.send(result.body);
      this.recordExport(req, `export_csv_${type}`, result.filename, fleetId, { from: fromRaw, to: toRaw, vehicules: ids === 'ALL' ? undefined : ids.length, driverId: driverIdQ ?? undefined });
    });
  }

  /**
   * Sprint 5 — Export Excel « soigné » PAR VÉHICULE (exceljs).
   * Body { vehicleId, from, to }. Le périmètre utilisateur est vérifié dans le
   * service (vehicleId doit être dans le périmètre accessible + la flotte de
   * l'appelant) → 403 sinon. Même périmètre d'auth que les autres exports.
   */
  @Post('excel')
  @HttpCode(200)
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('reports_export')
  async excelDownload(
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
    @Body() body: GenerateExcelDto,
  ): Promise<void> {
    await this.traceEchec(req, 'export_excel', null, { vehicleId: body.vehicleId, from: body.from, to: body.to, driverId: body.driverId ?? undefined }, async () => {
      // Jours civils de Paris, comme le PDF et les listes (cf. parisDayStart).
      const from = parisDayStart(body.from);
      const to = parisDayStart(body.to);
      if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
        throw new BadRequestException('from et to doivent être des dates ISO valides');
      }
      if (from.getTime() >= to.getTime()) {
        throw new BadRequestException('from doit etre strictement avant to');
      }
      /**
       * ── UN VÉHICULE, OU TOUT UN PÉRIMÈTRE ────────────────────────────────────────
       *
       * `vehicleId` absent = classeur de société (éventuellement borné à un groupe), avec
       * une feuille de synthèse par véhicule en tête. Jusqu'ici, obtenir le mois d'un parc
       * demandait quarante exports recollés à la main.
       *
       * ⚠️ La flotte retenue est celle du VÉHICULE (ou celle demandée), pas celle de
       * l'appelant : un super-administrateur exporte pour autrui. Le service, lui,
       * intersecte toujours avec les véhicules réellement accessibles.
       */
      const veh = body.vehicleId
        ? await this.prisma.vehicle.findUnique({ where: { id: body.vehicleId }, select: { fleetId: true } })
        : null;
      let fleetIdCible = veh?.fleetId ?? body.fleetId ?? req.user.fleetId ?? null;
      if (!body.vehicleId && !fleetIdCible) {
        // Super-administrateur sans société : on refuse plutôt que d'en choisir une au
        // hasard — un classeur portant le nom d'une société qu'on n'a pas demandée serait
        // pire qu'une erreur, il aurait l'air juste.
        throw new BadRequestException(
          'Précisez une société (fleetId) ou un véhicule : un classeur de parc doit désigner son périmètre.',
        );
      }
      /**
       * ── LE CLASSEUR SUIT LE FILTRE CONDUCTEUR (F13) ────────────────────────────────
       *
       * ⚠️ L'EXCEL NE PASSE PAS PAR `ReportsStatsService.compute` — il fait ses propres
       * requêtes (cf. `report-excel.service`). Le filtre descend donc dans SES `where`,
       * et le libellé résolu ici s'écrit dans sa feuille de synthèse : un classeur au nom
       * d'une personne qui porterait les trajets de tout le parc est exactement le fichier
       * qu'on ne peut pas rattraper une fois envoyé.
       *
       * `filtreConducteur` refuse déjà toute valeur qui n'est ni un UUID ni `none` — même
       * règle que la liste, la synthèse et le PDF.
       */
      const conducteur = await this.filtreConducteur(fleetIdCible, body.driverId);
      const filtreClasseur = conducteur.scope === undefined
        ? undefined
        : { scope: conducteur.scope, label: conducteur.nom ?? 'Conducteur' };
      const { buffer, filename } = body.vehicleId
        ? await this.excel.generate(body.vehicleId, from, to, req.user, filtreClasseur)
        : await this.excel.generateScope({ fleetId: fleetIdCible!, groupId: body.groupId }, from, to, req.user, filtreClasseur);
      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      res.setHeader('Content-Disposition', enTeteTelechargement(filename));
      res.send(buffer);
      this.recordExport(req, 'export_excel', filename, fleetIdCible, {
        vehicleId: body.vehicleId, groupId: body.groupId, from: body.from, to: body.to,
        driverId: body.driverId ?? undefined,
      });
    });
  }

  // ─── Rapport hebdomadaire : réglage par société + journal des envois ───────────────

  /** Réglage effectif (valeurs par défaut si rien n'est enregistré) + prochaine échéance. */
  @Get('schedule')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('reports_view')
  getSchedule(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    return this.schedule.get(req.user, fleetId);
  }

  /**
   * ⚠️ FLEET_MANAGER est ici volontairement : régler le rapport hebdomadaire de SA société
   * relève de la gestion de flotte, pas de l'administration de la plateforme. Le droit
   * `reports_export` reste exigé — un gestionnaire à qui on l'a retiré reçoit un 403, et
   * l'écran ne lui montre pas les commandes. Le périmètre société, lui, est verrouillé dans
   * `resolveFleetId` : un non-super-admin ne peut régler que sa propre société.
   */
  /**
   * Vue d'ensemble : le réglage hebdomadaire de TOUTES les sociétés, en une lecture.
   *
   * ⚠️ Déclarée AVANT `PUT /schedule` et les routes paramétrées — l'ordre des routes compte
   * dans Nest, et `schedule/overview` doit être reconnu comme un chemin littéral.
   */
  @Get('schedule/overview')
  @Roles(UserRole.SUPER_ADMIN)
  @RequirePermissions('reports_view')
  scheduleOverview(@Req() req: AuthenticatedRequest) {
    return this.schedule.listAll(req.user);
  }

  @Put('schedule')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('reports_export')
  async setSchedule(
    @Req() req: AuthenticatedRequest,
    @Body() body: SetReportScheduleDto,
    @Query('fleetId') fleetId?: string,
  ) {
    const dto = await this.schedule.set(req.user, body, fleetId);
    this.systemActivity.record({
      category: 'EXPORT',
      action: 'weekly_report_settings',
      status: 'SUCCESS',
      actor: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email || 'utilisateur',
      target: dto.fleetName,
      fleetId: dto.fleetId,
      triggeredByUserId: req.user.id,
      meta: { enabled: dto.enabled, weekday: dto.weekday, hour: dto.hour, recipients: dto.recipients.length, sections: dto.sections, vehicles: dto.vehicleIds.length },
    });
    return dto;
  }

  /**
   * Envoi immédiat des 7 derniers jours révolus — journalisé comme un passage manuel.
   *
   * Un envoi REFUSÉ laisse aussi une trace (design/C3 point 2, 2026-09-05) : quand l'envoi
   * automatique est coupé, le service répond 409 avant tout calcul et n'écrit aucune ligne de
   * journal d'envoi — rien n'est parti. Sans cette enveloppe, le clic disparaissait de
   * l'activité système, et « pourquoi mon rapport n'est pas parti ? » n'avait pas de réponse.
   * Même enveloppe que les exports (`traceEchec`) : une ligne FAILURE, le motif en clair,
   * l'erreur relancée telle quelle (le 409 arrive intact au front).
   */
  @Post('schedule/send-now')
  @HttpCode(200)
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('reports_export')
  async sendScheduleNow(@Req() req: AuthenticatedRequest, @Query('fleetId') fleetId?: string) {
    // La société est résolue AVANT la trace : une valeur brute de la query (société d'un autre
    // client, identifiant fantaisiste) ne doit jamais signer une ligne de journal — le refus de
    // périmètre (400/403) est alors tracé sans société, la valeur demandée restant dans meta.
    let cible: string | null = null;
    try { cible = this.schedule.resolveFleetId(req.user, fleetId); } catch { cible = null; }
    return this.traceEchec(req, 'weekly_report_send_now', cible, { trigger: 'manual', fleetIdDemande: fleetId ?? null }, async () => {
      const dispatch = await this.schedule.sendNow(req.user, fleetId);
      this.systemActivity.record({
        category: 'EXPORT',
        action: 'weekly_report_send_now',
        status: dispatch.status === 'FAILED' ? 'FAILURE' : 'SUCCESS',
        actor: [req.user.firstName, req.user.lastName].filter(Boolean).join(' ') || req.user.email || 'utilisateur',
        target: dispatch.fleetName,
        fleetId: dispatch.fleetId,
        triggeredByUserId: req.user.id,
        meta: { status: dispatch.status, recipients: dispatch.recipients.length, tripsCount: dispatch.tripsCount, pdfBytes: dispatch.pdfBytes, error: dispatch.error ?? undefined },
      });
      return { dispatch };
    });
  }

  /** Journal des envois (société courante ; toutes les sociétés pour un super-admin sans fleetId). */
  @Get('schedule/dispatches')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('reports_view')
  listScheduleDispatches(
    @Req() req: AuthenticatedRequest,
    @Query('fleetId') fleetId?: string,
    @Query('limit') limit?: string,
  ) {
    const n = Number(limit);
    return this.schedule.listDispatches(req.user, fleetId, Number.isFinite(n) && n > 0 ? n : 20);
  }

  /**
   * Rapport d'analyse de vitesse pour un trajet — HTML telechargeable.
   * Reserve aux FLEET_ADMIN et SUPER_ADMIN. Le tenant check est dans le
   * service (fleetId compare au trajet). Genere dynamiquement le rapport
   * a partir des positions GPS du trajet — generique, pas specifique a
   * une flotte.
   */
  @Get('speed-analysis/:tripId')
  @Roles(UserRole.SUPER_ADMIN, UserRole.FLEET_ADMIN)
  @RequirePermissions('reports_export')
  async speedAnalysis(
    @Param('tripId', ParseUUIDPipe) tripId: string,
    @Req() req: AuthenticatedRequest,
    @Res() res: Response,
  ): Promise<void> {
    await this.traceEchec(req, 'export_speed', null, { tripId }, async () => {
      const { html, filename } = await this.speedReport.generate(tripId, {
        userId: req.user.id,
        role: req.user.role,
        fleetId: req.user.fleetId,
      });
      // La flotte du TRAJET : le journal était écrit sans flotte, donc invisible au filtre
      // par société de l'espace admin (un super-admin exporte pour n'importe quelle société).
      const trip = await this.prisma.trip.findUnique({
        where: { id: tripId },
        select: { vehicle: { select: { fleetId: true } } },
      });
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', enTeteTelechargement(filename));
      res.send(html);
      this.recordExport(req, 'export_speed', filename, trip?.vehicle?.fleetId ?? null, { tripId });
    });
  }

  private async parseRange(
    req: AuthenticatedRequest,
    fleetIdQ: string | undefined,
    fromRaw: string,
    toRaw: string,
    vehicleIdsHint?: string[],
  ): Promise<{ from: Date; to: Date; fleetId: string }> {
    if (!fromRaw || !toRaw) {
      throw new BadRequestException('from et to (ISO date) requis');
    }
    // Jours civils Europe/Paris (« 2026-08-03 » = minuit à Paris), comme les listes et les
    // agrégats de trajets : un PDF « du 3 au 9 » doit contenir exactement les trajets que
    // l'écran affiche pour ces jours-là. Un ISO complet (avec heure) reste lu tel quel.
    const from = parisDayStart(fromRaw);
    const to = parisDayStart(toRaw);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new BadRequestException('from et to doivent être des dates ISO valides');
    }
    if (from.getTime() >= to.getTime()) {
      throw new BadRequestException('from doit etre strictement avant to');
    }
    let fleetId = req.user.role === UserRole.SUPER_ADMIN
      ? (fleetIdQ ?? req.user.fleetId ?? '')
      : (req.user.fleetId ?? '');
    if (!fleetId && req.user.role === UserRole.SUPER_ADMIN) {
      // Super-admin sans flotte explicite : si des véhicules précis sont
      // demandés (ex. export depuis une fiche véhicule), dériver la flotte de
      // CES véhicules — sinon on retombait sur une flotte arbitraire (la plus
      // ancienne), d'où le 400 « vehicleIds n'appartiennent pas a la flotte
      // demandee » dès que le véhicule vivait dans une autre flotte.
      const hintId = (vehicleIdsHint ?? []).find((id) => !!id);
      if (hintId) {
        const v = await this.prisma.vehicle.findUnique({ where: { id: hintId }, select: { fleetId: true } });
        if (v?.fleetId) fleetId = v.fleetId;
      }
      if (!fleetId) {
        const firstFleet = await this.prisma.fleet.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } });
        if (firstFleet) fleetId = firstFleet.id;
      }
    }
    if (!fleetId) {
      throw new BadRequestException('fleetId requis');
    }
    return { from, to, fleetId };
  }
}
