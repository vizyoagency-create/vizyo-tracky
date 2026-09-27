import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CommandStatus, EngineAction, UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { RequireVehiclePermission } from '../auth/decorators/vehicle-permissions.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PermissionsResolverService } from '../permissions/permissions-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { RequestEngineCommandDto } from './dto/request-engine-command.dto';
import { EngineControlService } from './engine-control.service';

@Controller('engine-control')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class EngineControlController {
  constructor(
    private readonly engineControl: EngineControlService,
    private readonly permissions: PermissionsResolverService,
    private readonly prisma: PrismaService,
    // C7 (24/09/2026) — le périmètre véhicules de l'appelant. Sans lui, le cloisonnement
    // par véhicule écrit dans le service serait INERTE : il ne lirait qu'un champ jamais
    // renseigné. Un garde-fou qu'on n'alimente pas ne garde rien — c'est la forme de défaut
    // la plus fréquente de ce dépôt.
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  /**
   * V1.11 Phase 1 — Coupure/redemarrage moteur protege par la permission
   * `engine_control` resolue per-vehicle (regle "specifique gagne"). Ouvert aux
   * 4 roles mais @RequireVehiclePermission filtre selon les overrides.
   *
   * Les contraintes metier (vitesse < 20 km/h, position fraiche, fix GPS valide)
   * sont appliquees dans le service apres le passage du guard.
   */
  @Post('trackers/:trackerId/commands')
  @Roles(
    UserRole.FLEET_ADMIN,
    UserRole.SUPER_ADMIN,
    UserRole.FLEET_MANAGER,
    UserRole.VIEWER,
    UserRole.NIGHT_WATCHMAN,
  )
  @RequireVehiclePermission('engine_control', { paramName: 'trackerId' })
  async requestCommand(
    @Param('trackerId') trackerId: string,
    @Body() dto: RequestEngineCommandDto,
    @Req() req: AuthenticatedRequest,
  ) {
    // `disableSchedule` n'est pas une simple variante de CUT : il sort durablement le véhicule
    // du planning. La route est normalement gardée par `engine_control`, donc on vérifie ici le
    // second droit conditionnel. Sans cette garde, un rôle autorisé à couper mais pas à gérer les
    // horaires pouvait contourner `schedules_manage` en forgeant le body HTTP.
    if (dto.disableSchedule && dto.action !== EngineAction.CUT) {
      throw new BadRequestException('disableSchedule est réservé à une coupure durable');
    }
    if (dto.disableSchedule) {
      const tracker = await this.prisma.tracker.findUnique({
        where: { id: trackerId },
        select: { vehicle: { select: { id: true } } },
      });
      const vehicleId = tracker?.vehicle?.id;
      const allowed = vehicleId
        ? await this.permissions.canOnVehicle(req.user, vehicleId, 'schedules_manage')
        : false;
      if (!allowed) throw new ForbiddenException('Permission requise : schedules_manage');
    }

    return this.engineControl.requestCommand(trackerId, dto.action, dto.reason ?? null, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    }, 'MANUAL', dto.disableSchedule, false, dto.idempotencyKey);
  }

  @Get('commands')
  /**
   * C7 (incident CDEF31 du 24/09/2026) — LE VEILLEUR EST ADMIS ICI, ET C'EST LA CAUSE DE FOND.
   *
   * Il en était exclu : 232 réponses `403` sur le seul créneau 01h52 → 03h02, une par véhicule et
   * par rafraîchissement. Conséquence côté client, assumée dans `engine-control-button` : sa liste
   * `recentCommands` restait TOUJOURS vide, et l'état de son bouton ne pouvait venir que de
   * l'overlay WebSocket — un canal que chaque recréation de conteneur interrompt. Le rôle qui a le
   * plus besoin de savoir si un véhicule est coupé était le seul privé de la source de vérité.
   *
   * Le cloisonnement ne s'en trouve pas relâché : le service borne à la flotte ET aux véhicules
   * accessibles, et CAVIARDE le motif libre pour ce rôle (cf. `listCommands`). Il obtient l'état,
   * pas le dossier.
   */
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.NIGHT_WATCHMAN)
  async listCommands(
    @Req() req: AuthenticatedRequest,
    @Query('trackerId') trackerId?: string,
    @Query('status') status?: CommandStatus,
    @Query('limit') limit?: string,
  ) {
    return this.engineControl.listCommands(
      {
        userId: req.user.id,
        role: req.user.role,
        fleetId: req.user.fleetId,
        // Cette route prend `trackerId` en paramètre de requête et n'a PAS de garde
        // `@RequireVehiclePermission` (contrairement à l'envoi de commande, qui en a une) :
        // le périmètre est donc la seule chose qui empêche un sous-utilisateur restreint de
        // lire les commandes de toute sa flotte en forgeant l'identifiant.
        accessibleVehicleIds: await this.vehicleAccess.getAccessibleVehicleIds(req.user),
      },
      {
        trackerId,
        status,
        limit: limit ? parseInt(limit, 10) : undefined,
      },
    );
  }

  /**
   * TRK-018 nº 4 — l'écran « immobilisations non confirmées ».
   *
   * Volontairement AVANT `commands/:id` : Nest résout dans l'ordre de déclaration, et une route
   * littérale placée après une route paramétrée serait avalée par elle (`:id` = 'unconfirmed').
   *
   * Ouvert aux mêmes rôles que la liste des commandes. Le cloisonnement est fait dans le service
   * par `resolveTenantScope` (fail-closed).
   */
  @Get('unconfirmed')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  listUnconfirmed(@Req() req: AuthenticatedRequest, @Query('days') days?: string) {
    return this.engineControl.listUnconfirmedImmobilisations(
      { userId: req.user.id, role: req.user.role, fleetId: req.user.fleetId },
      { days: days ? parseInt(days, 10) : undefined },
    );
  }

  @Get('commands/:id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  getCommand(@Param('id') id: string, @Req() req: AuthenticatedRequest) {
    return this.engineControl.getCommand(id, {
      userId: req.user.id,
      role: req.user.role,
      fleetId: req.user.fleetId,
    });
  }
}
