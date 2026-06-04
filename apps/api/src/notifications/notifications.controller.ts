import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { UserRole } from '@prisma/client';
import { RequirePermissions } from '../auth/decorators/permissions.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { PrismaService } from '../prisma/prisma.service';
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
@UseGuards(JwtAuthGuard, RolesGuard, PermissionsGuard)
export class NotificationsController {
  constructor(
    private readonly webPush: WebPushService,
    private readonly alertRules: AlertRulesService,
    private readonly prisma: PrismaService,
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
    @Body() body: {
      subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
      /** UUID stable du device cote client (localStorage). Permet dedup parfaite. */
      deviceId?: string;
    },
  ) {
    if (!body?.subscription?.endpoint || !body?.subscription?.keys?.p256dh || !body?.subscription?.keys?.auth) {
      throw new BadRequestException('subscription invalide');
    }
    const ua = req.headers['user-agent']?.toString();
    // deviceId optionnel — validate format UUID si fourni (best-effort, le client
    // genere via crypto.randomUUID() donc devrait toujours etre valide).
    const deviceId = typeof body.deviceId === 'string' && /^[0-9a-f-]{8,64}$/i.test(body.deviceId)
      ? body.deviceId
      : undefined;
    await this.webPush.subscribe(req.user.id, body.subscription, ua, deviceId);
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

  /**
   * Liste les subscriptions push.
   *   - Par defaut : celles du user courant uniquement.
   *   - `?scope=all` : toutes les subscriptions de la base (SUPER_ADMIN seulement).
   *     Utile pour la page Observabilite : voir qui est abonne, identifier des
   *     subs zombies, supprimer celles de comptes clients par erreur.
   */
  @Get('push/subscriptions')
  async listSubs(
    @Req() req: AuthenticatedRequest,
    @Query('scope') scope?: 'all' | 'mine',
  ) {
    const wantAll = scope === 'all' && req.user.role === UserRole.SUPER_ADMIN;
    const subs = wantAll
      ? await this.prisma.pushSubscription.findMany({ orderBy: { lastSeenAt: 'desc' } })
      : await this.webPush.listForUser(req.user.id);

    // Jointure manuelle user (pas de relation Prisma declaree pour eviter une
    // migration). On collecte les userIds uniques et on fetch les users.
    const userIds = [...new Set(subs.map((s) => s.userId))];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, email: true, firstName: true, lastName: true, role: true },
        })
      : [];
    const userById = new Map(users.map((u) => [u.id, u]));

    return {
      items: subs.map((s) => {
        const u = userById.get(s.userId);
        const fullName = u ? [u.firstName, u.lastName].filter(Boolean).join(' ').trim() : '';
        return {
          id: s.id,
          endpoint: s.endpoint.slice(0, 60) + '...', // truncate pour ne pas exposer le secret
          endpointHost: (() => { try { return new URL(s.endpoint).hostname; } catch { return 'unknown'; } })(),
          userId: s.userId,
          userEmail: u?.email ?? null,
          userName: fullName || null,
          userRole: u?.role ?? null,
          userAgent: s.userAgent,
          lastSeenAt: s.lastSeenAt.toISOString(),
          createdAt: s.createdAt.toISOString(),
          isMine: s.userId === req.user.id,
        };
      }),
    };
  }

  /**
   * Supprime une subscription par id.
   *   - Le proprietaire peut supprimer les siennes.
   *   - SUPER_ADMIN peut supprimer celles de n'importe quel user (pour purger
   *     les zombies depuis Observabilite).
   */
  @Delete('push/subscriptions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteSub(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const sub = await this.prisma.pushSubscription.findUnique({ where: { id } });
    if (!sub) throw new NotFoundException('subscription introuvable');
    const isOwner = sub.userId === req.user.id;
    const isSuperAdmin = req.user.role === UserRole.SUPER_ADMIN;
    if (!isOwner && !isSuperAdmin) {
      throw new ForbiddenException('Acces refuse');
    }
    await this.webPush.deleteSubscriptionById(id);
  }

  // ─── Push test (SUPER_ADMIN — page Observabilite) ───────────

  /**
   * Envoie une notification push de test a l'utilisateur courant (toutes ses
   * subscriptions), avec un delai optionnel cote serveur. Reserve aux
   * SUPER_ADMIN — sert d'outil de QA sur l'onglet Observabilite.
   *
   * Le delai est un setTimeout en-process : suffisant pour tester (5/30s),
   * pas pour scheduler durable. Pas de Promise rejetee meme si l'envoi
   * differe echoue : on log, on n'expose pas au client (la reponse a deja
   * ete renvoyee).
   */
  @Post('test')
  @Roles(UserRole.SUPER_ADMIN)
  async sendTest(
    @Req() req: AuthenticatedRequest,
    @Body() body: {
      title?: string;
      body?: string;
      severity?: 'INFO' | 'WARNING' | 'CRITICAL';
      delayMs?: number;
      /**
       * Optionnel — sous-ensemble de subscriptions a cibler. Si absent ou vide,
       * envoie a TOUTES les subs du SUPER_ADMIN connecte. Securite : on filtre
       * pour ne garder que les subs qui appartiennent au user courant (un
       * SUPER_ADMIN ne peut pas pusher sur les devices d'un client).
       */
      subscriptionIds?: string[];
    },
  ) {
    if (!this.webPush.isEnabled()) {
      throw new BadRequestException('Push desactive cote serveur (VAPID manquant)');
    }
    const allMySubs = await this.webPush.listForUser(req.user.id);
    if (allMySubs.length === 0) {
      throw new BadRequestException(
        'Aucune subscription pour cet utilisateur — active d\'abord les notifications sur ce device.',
      );
    }

    // Filtrage ciblage : si subscriptionIds est fourni, on ne garde que ceux
    // qui appartiennent au user courant (security : pas de push sur les devices
    // d'autres comptes, y compris les clients en prod).
    const requestedIds = Array.isArray(body?.subscriptionIds) ? body.subscriptionIds : [];
    const targetIds = requestedIds.length > 0
      ? allMySubs.filter((s) => requestedIds.includes(s.id)).map((s) => s.id)
      : allMySubs.map((s) => s.id);

    if (targetIds.length === 0) {
      throw new BadRequestException(
        'Aucune subscription valide pour ce SUPER_ADMIN parmi celles selectionnees.',
      );
    }

    const severity = body?.severity ?? 'INFO';
    const payload = {
      title: body?.title?.trim() || `Test Tracky (${severity})`,
      body: body?.body?.trim() || 'Ceci est une notification de test envoyee depuis Observabilite.',
      severity,
      data: { kind: 'test', triggeredBy: req.user.id, at: new Date().toISOString() },
      url: '/admin/observability',
      tag: `test-${Date.now()}`,
      // appBadge: 1 -> Android Chrome / Chrome desktop / iOS 18.4+ PWA afficheront
      // le "1" sur l'icone de l'app. Le SW lit ce champ et appelle setAppBadge(1).
      appBadge: 1,
    };

    // Bornes : 0..60s. Au-dela, le client est cense recevoir une vraie alerte
    // schedulee, pas un test.
    const delayMs = Math.max(0, Math.min(60_000, Math.floor(body?.delayMs ?? 0)));
    const targetDevices = targetIds.length;

    if (delayMs === 0) {
      const res = await this.webPush.sendToSubscriptionIds(targetIds, req.user.id, payload);
      return { scheduled: false, delayMs: 0, targetDevices, ...res };
    }

    setTimeout(() => {
      this.webPush.sendToSubscriptionIds(targetIds, req.user.id, payload).catch(() => {/* logged inside service */});
    }, delayMs);
    return { scheduled: true, delayMs, targetDevices };
  }

  // ─── AlertRules CRUD ────────────────────────────────────────

  @Get('rules')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER, UserRole.VIEWER)
  @RequirePermissions('alerts_view')
  async listRules(@Req() req: AuthenticatedRequest) {
    const items = await this.alertRules.list({ role: req.user.role, fleetId: req.user.fleetId });
    return { items };
  }

  @Post('rules')
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('alerts_configure')
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
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('alerts_configure')
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
  @Roles(UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN, UserRole.FLEET_MANAGER)
  @RequirePermissions('alerts_configure')
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteRule(
    @Req() req: AuthenticatedRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    await this.alertRules.delete(id, { role: req.user.role, fleetId: req.user.fleetId });
  }
}
