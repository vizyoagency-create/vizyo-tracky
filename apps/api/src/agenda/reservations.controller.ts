import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { UserRole, VehicleEventStatus } from '@prisma/client';
import type {
  ConfirmReservationDto,
  ReorganiserReservationsDto,
  RequestReservationDto,
  UpdateReservationDto,
} from '@vizyo/tracky-shared';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { ReservationsService } from './reservations.service';

const ALL_ROLES = [
  UserRole.SUPER_ADMIN,
  UserRole.FLEET_ADMIN,
  UserRole.FLEET_MANAGER,
  UserRole.VIEWER,
  UserRole.NIGHT_WATCHMAN,
];
const DAY_MS = 24 * 60 * 60 * 1000;

function parseIntOr(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Sprint 8 (Palier B) — Réservations. Demande (reservations_request) → validation
 * (reservations_manage) ; lecture + auto-complétion (reservations_view). Scoping tenant
 * strict + conflits gérés dans le service.
 */
@Controller('reservations')
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  /** Auto-complétion : véhicules libres + conformes aux critères sur le créneau. */
  @Get('suggest')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  suggest(
    @Req() req: AuthenticatedRequest,
    @Query('startAt') startAt: string,
    @Query('endAt') endAt: string,
    @Query('minSeats') minSeats?: string,
    @Query('minChildSeats') minChildSeats?: string,
    @Query('features') features?: string,
  ) {
    if (!startAt || !endAt) throw new BadRequestException('startAt et endAt (ISO) requis.');
    return this.reservations.suggest(req.user, {
      startAt,
      endAt,
      criteria: {
        minSeats: parseIntOr(minSeats),
        minChildSeats: parseIntOr(minChildSeats),
        requiredFeatures: features
          ? features.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
      },
    });
  }

  /** Liste des réservations (scopée). Filtre `status=REQUESTED` = file de validation. */
  @Get()
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_view')
  list(
    @Req() req: AuthenticatedRequest,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('status') status?: string,
    @Query('vehicleId') vehicleId?: string,
    @Query('groupId') groupId?: string,
    /**
     * Filtre société du bandeau (SUPER_ADMIN). ⚠️ IL MANQUAIT : sans lui, `scopedWhere` ne posait
     * aucune borne de flotte pour un super-admin, et la file « À valider » mélangeait les demandes
     * de TOUTES les sociétés — avec le risque d'en valider une sur la mauvaise. Ses voisines
     * `/agenda/events` et `/agenda/summary` le portaient depuis toujours.
     */
    @Query('fleetId') fleetId?: string,
  ) {
    const now = Date.now();
    const f = from ? new Date(from) : new Date(now - 31 * DAY_MS);
    const t = to ? new Date(to) : new Date(now + 365 * DAY_MS);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) {
      throw new BadRequestException('Fenêtre invalide.');
    }
    return this.reservations.list(req.user, {
      from: f,
      to: t,
      status: status ? (status as VehicleEventStatus) : undefined,
      vehicleId,
      groupId,
      fleetId,
    });
  }

  /** Déposer une demande de réservation (REQUESTED). */
  @Post('request')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_request')
  request(@Req() req: AuthenticatedRequest, @Body() dto: RequestReservationDto) {
    return this.reservations.request(req.user, dto);
  }

  /** Valider une demande -> CONFIRMED (bloquant). */
  @Post(':id/confirm')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_manage')
  confirm(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ConfirmReservationDto,
  ) {
    return this.reservations.confirm(req.user, id, dto ?? {});
  }

  /** Refuser / annuler -> CANCELLED. */
  @Post(':id/cancel')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_manage')
  cancel(@Req() req: AuthenticatedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.reservations.cancel(req.user, id);
  }

  /**
   * Lot 3c — REPRENDRE UN LOT de réservations (annuler / décaler), en masse.
   *
   * Même permission que la validation, et pour la même raison : reprendre cent réservations d'un
   * coup, c'est la même autorité que d'en valider une — en plus lourd de conséquences.
   *
   * ⚠️ `simulation` vaut VRAI par défaut côté service : un appel sans ce champ ne modifie RIEN et
   * rend le compte-rendu. Il faut demander explicitement `simulation: false` pour écrire.
   */
  @Post('reorganiser')
  @HttpCode(200)
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_manage')
  reorganiser(@Req() req: AuthenticatedRequest, @Body() dto: ReorganiserReservationsDto) {
    return this.reservations.reorganiser(req.user, dto);
  }

  /** Éditer une réservation (créneau / critères / libellé). */
  @Patch(':id')
  @Roles(...ALL_ROLES)
  @RequirePermissions('reservations_manage')
  update(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateReservationDto,
  ) {
    return this.reservations.update(req.user, id, dto);
  }
}
