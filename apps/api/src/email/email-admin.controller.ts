import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { EmailAdminService } from './email-admin.service';

/**
 * Centre e-mails (admin) — suivi des envois, modèles, délivrabilité.
 * Toutes les routes réservées SUPER_ADMIN (même garde que SmsAdminController).
 */
@Controller('admin/emails')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN)
export class EmailAdminController {
  constructor(private readonly svc: EmailAdminService) {}

  @Get('stats')
  stats(@Query('range') range?: string) {
    const days = range === '7d' ? 7 : range === '90d' ? 90 : 30;
    return this.svc.stats(days);
  }

  @Get('logs')
  logs(
    @Query('status') status?: string,
    @Query('template') template?: string,
    @Query('q') q?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.logs({ status, template, q, cursor, limit: limit ? parseInt(limit, 10) : undefined });
  }

  @Get('templates')
  templates() {
    return this.svc.templates();
  }

  @Get('deliverability')
  deliverability() {
    return this.svc.deliverability();
  }

  @Get('templates/:id/preview')
  preview(@Param('id') id: string) {
    return this.svc.preview(id);
  }

  @Post('templates/:id/test')
  test(@Param('id') id: string, @Body() body: { to?: string }) {
    if (!body?.to?.trim()) throw new BadRequestException('« to » (destinataire) requis');
    return this.svc.sendTest(id, body.to.trim());
  }
}
