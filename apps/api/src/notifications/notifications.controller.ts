import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '@prisma/client';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { AlertRulesService } from './alert-rules.service';
import { WebPushService } from './web-push.service';

/**
 * V1.5 (Sprint M) — Endpoints notifications.
 *
 *  - GET    /api/notifications/push/public-key    : recupere la VAPID publique
 *  - POST   /api/notifications/push/subscribe     : enregistre une subscription
 *  - DELETE /api/notifications/push/subscribe     : retire une subscription
 *  - GET    /api/notifications/push/subscriptions : liste les devices abonnes
 *  - GET    /api/notifications/rules              : CRUD AlertRule (FLEET_ADMIN+)
 *  - POST   /api/notifications/rules
 *  - PUT    /api/notifications/rules/:id
 *  - DELETE /api/notifications/rules/:id
 */
@Controller('notifications')
@UseGuards(JwtAuthGuard, RolesGuard)
export class NotificationsController {
  constructor(
    private readonly webPush: WebPushService,
    private readonly alertRules: AlertRulesService,
  ) {}

  // ─── Push subscriptions ─────────────────────────────────────

  @Get('push/public-key')
  publicKey() {
    return {
      enabled: this.webPush.isEnabled(),
      publicKey: this.webPush.isEnabled() ? this.webPush.getPublicKey() : null,
    };
  }

  @Post('push/subscribe')
  @HttpCode(HttpStatus.CREATED)
  async subscribe(
    @Req() req: AuthenticatedRequest & Request,
    @Body() body: { subscription: { endpoint: string; keys: { p256dh: string; auth: string } } },
  ) {
    if (!body?.subscription?.endpoint || !body?.subscription?.keys?.p256dh || !body?.subscription?.keys?.auth) {
      throw new BadRequestException('subscription invalide');
    }
    const ua = req.headers['user-agent']?.toString();
    await this.webPush.subscribe(req.user.id, body.subscription, ua);
    return { ok: true };
  }

  @Delete('push/subscribe')
  @HttpCode(HttpStatus.NO_CONTENT)
  async unsubscribe(
    @Req() req: AuthenticatedRequest,
    @Body() body: { endpoint: string },
  ) {
    if (!body?.endpoint) throw new BadRequestException('endpoint requis');
    await this.webPush.unsubscribe(body.endpoint, req.user.id);
  }

  @Get('push/subscriptions')
  async listSubs(@Req() req: AuthenticatedRequest) {
    const subs = await this.webPush.listForUser(req.user.id);
    return {
      items: subs.map((s) => ({
        id: s.id,
        endpoint: s.endpoint.slice(0, 60) + '...', // truncate pour ne pas exposer le secret
        userAgent: s.userAgent,
        lastSeenAt: s.lastSeenAt.toISOString(),
        createdAt: s.createdAt.toISOString(),
      })),
    };
  }

  // ─── AlertRules CRUD ────────────────────────────────────────

  @Get('rules')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  async listRules(@Req() req: AuthenticatedRequest) {
    const items = await this.alertRules.list({ role: req.user.role, fleetId: req.user.fleetId });
    return { items };
  }

  @Post('rules')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async createRule(
    @Req() req: AuthenticatedRequest,
    @Body() body: {
      fleetId?: string;
      vehicleId?: string | null;
      alertType: string;
      enabled?: boolean;
      channels: string[];
      escalateAfterMin?: number | null;
      escalateToUserId?: string | null;
    },
  ) {
    return this.alertRules.upsert(body, {
      id: req.user.id, role: req.user.role, fleetId: req.user.fleetId,
    });
  }

  @Put('rules/:id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  async updateRule(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: {
      vehicleId?: string | null;
      alertType: string;
      enabled?: boolean;
      channels: string[];
      escalateAfterMin?: number | null;
      escalateToUserId?: string | null;
    },
  ) {
    return this.alertRules.upsert({ ...body, id }, {
      id: req.user.id, role: req.user.role, fleetId: req.user.fleetId,
    });
  }

  @Delete('rules/:id')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRule(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.alertRules.delete(id, { role: req.user.role, fleetId: req.user.fleetId });
  }
}
