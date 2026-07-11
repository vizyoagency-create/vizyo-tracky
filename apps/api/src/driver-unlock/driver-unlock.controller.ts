import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { DriverUnlockService } from './driver-unlock.service';
import { UnlockDriverDto } from './dto/unlock-driver.dto';

/**
 * feat/comptes-conducteurs (4b) — endpoint de déverrouillage conducteur par QR.
 * Auth requise (session). L'autorisation réelle (per-véhicule `engine_control`) + la proximité
 * sont vérifiées dans le service. Rôles éligibles = ceux qui peuvent porter `engine_control`.
 */
@Controller('driver')
@UseGuards(JwtAuthGuard, RolesGuard)
export class DriverUnlockController {
  constructor(private readonly service: DriverUnlockService) {}

  @Post('unlock')
  @Roles(
    UserRole.DRIVER,
    UserRole.NIGHT_WATCHMAN,
    UserRole.FLEET_MANAGER,
    UserRole.FLEET_ADMIN,
    UserRole.SUPER_ADMIN,
  )
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  @HttpCode(200)
  unlock(@Req() req: AuthenticatedRequest, @Body() dto: UnlockDriverDto) {
    return this.service.unlock(req.user, dto);
  }
}
