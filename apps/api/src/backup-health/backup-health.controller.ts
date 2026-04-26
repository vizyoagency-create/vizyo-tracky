import { BadRequestException, Body, Controller, Get, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { InternalSecretGuard } from '../internal/internal-secret.guard';
import { BackupHealthService } from './backup-health.service';

/**
 * V1.5 (Sprint I) — Backup health endpoints.
 *
 * - POST /internal/backup-health : appele par le script `deploy/vps/backup-db.sh`
 *   apres chaque execution. Authentifie via INTERNAL_API_SECRET.
 *
 * - GET  /admin/backup-health   : liste des derniers backups pour le SUPER_ADMIN.
 */
@Controller()
export class BackupHealthController {
  constructor(private readonly service: BackupHealthService) {}

  @Post('internal/backup-health')
  @UseGuards(InternalSecretGuard)
  @HttpCode(HttpStatus.CREATED)
  async record(
    @Body()
    body: {
      status?: 'OK' | 'FAILED';
      sizeBytes?: number;
      durationMs?: number;
      destination?: string;
      filename?: string;
      errorMessage?: string;
    },
  ) {
    if (body?.status !== 'OK' && body?.status !== 'FAILED') {
      throw new BadRequestException('status doit valoir OK ou FAILED');
    }
    return this.service.record({
      status: body.status,
      sizeBytes: body.sizeBytes,
      durationMs: body.durationMs,
      destination: body.destination,
      filename: body.filename,
      errorMessage: body.errorMessage,
    });
  }

  @Get('admin/backup-health')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(UserRole.SUPER_ADMIN)
  async list(@Query('limit') limitRaw?: string) {
    const limit = Math.max(1, Math.min(parseInt(limitRaw ?? '30', 10) || 30, 200));
    const last = await this.service.lastSuccessfulRun();
    const items = await this.service.listRecent(limit);
    const lastSuccessAgeMs = last ? Date.now() - last.createdAt.getTime() : null;
    return {
      items: items.map((r) => ({
        id: r.id,
        status: r.status,
        sizeBytes: r.sizeBytes ? r.sizeBytes.toString() : null,
        durationMs: r.durationMs,
        destination: r.destination,
        filename: r.filename,
        errorMessage: r.errorMessage,
        createdAt: r.createdAt.toISOString(),
      })),
      lastSuccess: last
        ? {
            id: last.id,
            createdAt: last.createdAt.toISOString(),
            ageHours: Math.round((Date.now() - last.createdAt.getTime()) / 3600000 * 10) / 10,
          }
        : null,
      stale: !last || (lastSuccessAgeMs !== null && lastSuccessAgeMs > 30 * 60 * 60 * 1000),
    };
  }
}
