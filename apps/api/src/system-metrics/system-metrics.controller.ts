import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { SystemRange } from '@vizyo/tracky-shared';
import { SYSTEM_RANGES } from '@vizyo/tracky-shared';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { SystemMetricsService } from './system-metrics.service';

/**
 * Monitoring VPS — endpoints admin (SUPER_ADMIN). Lecture seule.
 *  - GET /api/admin/system/current        snapshot live (CPU/RAM/load/dbSize)
 *  - GET /api/admin/system/history?range= série temporelle agrégée
 *  - GET /api/admin/system/db             tailles tables + prévision purge
 */
@Controller('admin/system')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class SystemMetricsController {
  constructor(private readonly metrics: SystemMetricsService) {}

  @Get('current')
  current() {
    return this.metrics.collectSnapshot();
  }

  @Get('history')
  history(@Query('range') range?: string) {
    const r: SystemRange = SYSTEM_RANGES.includes(range as SystemRange)
      ? (range as SystemRange)
      : '1h';
    return this.metrics.getHistory(r);
  }

  @Get('db')
  db() {
    return this.metrics.getDbStats();
  }
}
