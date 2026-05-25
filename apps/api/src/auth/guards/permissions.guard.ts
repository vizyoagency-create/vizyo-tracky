import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@prisma/client';
import type { UserPermissions } from '@vizyo/tracky-shared';
import { PermissionsResolverService } from '../../permissions/permissions-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import {
  VEHICLE_PERMISSIONS_KEY,
  type VehiclePermissionsSpec,
} from '../decorators/vehicle-permissions.decorator';
import type { AuthenticatedRequest } from './jwt-auth.guard';

/**
 * V1.11 Phase 1 — Enforcement des permissions, version 2 (per-scope).
 *
 * Lit deux types de metadata :
 *
 *  - **@RequirePermissions(...keys)** : permission globale. Le user peut
 *    l'action s'il peut sur AU MOINS un de ses scopes (union). Utilise pour
 *    les actions sans contexte vehicleId (ex: POST /vehicles, GET /reports).
 *
 *  - **@RequireVehiclePermission(key, { paramName })** : permission per-vehicle.
 *    Resolu selon la ligne UserVehicleAccess qui couvre ce vehicleId
 *    (regle "specifique gagne"). Utilise pour les actions sensibles ciblees
 *    (ex: couper moteur sur ce vehicule).
 *
 * Combinable : les deux decorateurs peuvent etre presents sur la meme route,
 * la guard verifie les deux.
 *
 * SUPER_ADMIN et FLEET_ADMIN bypass dans tous les cas (decision metier).
 *
 * Ordre d'application : @UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard).
 * Le PermissionsGuard est en dernier — il assume que req.user est resolu.
 */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly resolver: PermissionsResolverService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<Array<keyof UserPermissions> | undefined>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );
    const requiredVehicle = this.reflector.getAllAndOverride<
      VehiclePermissionsSpec | undefined
    >(VEHICLE_PERMISSIONS_KEY, [context.getHandler(), context.getClass()]);

    if ((!required || required.length === 0) && !requiredVehicle) return true;

    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = req.user;

    // Bypass total pour les admins (cf. doc service).
    if (user.role === UserRole.SUPER_ADMIN || user.role === UserRole.FLEET_ADMIN) return true;

    // 1) Verifier les permissions per-vehicle si present.
    if (requiredVehicle) {
      const vehicleId = await this.extractVehicleId(req, requiredVehicle.paramName);
      for (const key of requiredVehicle.keys) {
        const ok = await this.resolver.canOnVehicle(user, vehicleId, key);
        if (!ok) {
          throw new ForbiddenException(`Permission requise : ${String(key)}`);
        }
      }
    }

    // 2) Verifier les permissions globales si present.
    if (required && required.length > 0) {
      for (const key of required) {
        const ok = await this.resolver.canGlobally(user, key);
        if (!ok) {
          throw new ForbiddenException(`Permission requise : ${String(key)}`);
        }
      }
    }

    return true;
  }

  /**
   * Extrait le vehicleId depuis la request. Si `paramName` vaut 'trackerId',
   * resout d'abord trackerId → vehicleId via 1 query Prisma.
   *
   * Fallback : params → body → query. Si absent, BadRequestException (signale
   * un usage incorrect du decorateur — ne devrait jamais arriver en prod).
   */
  private async extractVehicleId(
    req: AuthenticatedRequest,
    paramName: string,
  ): Promise<string> {
    const raw =
      this.pickStringField(req.params as Record<string, unknown>, paramName) ??
      this.pickStringField(req.body as Record<string, unknown> | undefined, paramName) ??
      this.pickStringField(req.query as Record<string, unknown> | undefined, paramName);

    if (!raw) {
      throw new BadRequestException(
        `Parametre ${paramName} requis pour verifier la permission`,
      );
    }

    if (paramName === 'trackerId') {
      const tracker = await this.prisma.tracker.findUnique({
        where: { id: raw },
        select: { vehicle: { select: { id: true } } },
      });
      if (!tracker?.vehicle) {
        // 404 plutot que 403 pour ne pas leak l'existence d'un tracker.
        // Cohere avec le pattern Sprint 6 (cf. plan section D).
        throw new ForbiddenException('Ressource introuvable');
      }
      return tracker.vehicle.id;
    }

    return raw;
  }

  private pickStringField(
    source: Record<string, unknown> | undefined,
    key: string,
  ): string | undefined {
    if (!source) return undefined;
    const value = source[key];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
}
