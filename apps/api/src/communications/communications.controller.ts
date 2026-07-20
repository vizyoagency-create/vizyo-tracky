import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import type { CommChannel } from './communications.catalog';
import { CommunicationsService } from './communications.service';

const CHANNELS: CommChannel[] = ['EMAIL', 'SMS', 'PUSH'];

/**
 * Centre « Communications » (admin) — e-mails, SMS et notifications push réunis.
 * Même garde que les autres écrans admin : SUPER_ADMIN uniquement.
 *
 * L'aperçu et l'envoi de test restent servis par /admin/emails (spécifiques au
 * rendu HTML e-mail) : on ne duplique pas, on complète.
 */
@Controller('admin/communications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class CommunicationsController {
  constructor(private readonly svc: CommunicationsService) {}

  @Get('overview')
  overview(@Query('range') range?: string) {
    const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
    return this.svc.overview(days);
  }

  @Get('logs')
  logs(
    @Query('channel') channel?: string,
    @Query('template') template?: string,
    @Query('q') q?: string,
    @Query('limit') limit?: string,
    @Query('offset') offset?: string,
  ) {
    const ch = CHANNELS.find((c) => c === channel?.toUpperCase());
    return this.svc.logs({
      channel: ch,
      template: template || undefined,
      q: q || undefined,
      limit: limit ? Number(limit) : undefined,
      offset: offset ? Number(offset) : undefined,
    });
  }

  @Get('templates')
  templates() {
    return this.svc.templates();
  }

  @Get('catalog-counts')
  catalogCounts() {
    return this.svc.catalogCounts();
  }
}
