import { Body, Controller, Get, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ConsentService } from './consent.service';

@Controller('consent')
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  /** Statut de consentement de l'utilisateur courant (auth requise, gate exempté). */
  @Get('current')
  @UseGuards(JwtAuthGuard)
  current(@Req() req: AuthenticatedRequest) {
    return this.consent.status(req.user.id);
  }

  /** Acceptation CGU + Confidentialité (version courante) — horodatée avec IP/UA. */
  @Post('accept')
  @UseGuards(JwtAuthGuard)
  accept(@Req() req: AuthenticatedRequest) {
    return this.consent.acceptCurrent(req.user.id, ip(req), ua(req));
  }

  /** Permission device (notifications / localisation) accordée ou refusée. */
  @Post('permission')
  @UseGuards(JwtAuthGuard)
  @HttpCode(204)
  async permission(
    @Req() req: AuthenticatedRequest,
    @Body() body: { kind?: string; granted?: boolean; deviceId?: string },
  ): Promise<void> {
    await this.consent.recordPermission(req.user.id, {
      kind: String(body?.kind ?? ''),
      granted: !!body?.granted,
      deviceId: String(body?.deviceId ?? ''),
      ip: ip(req),
      userAgent: ua(req),
    });
  }

  /** PUBLIC — choix du bandeau LP (accepter/refuser), enregistré avec l'IP. */
  @Post('lp')
  // Écriture publique en base : un visiteur légitime ne soumet le bandeau qu'1-2 fois.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @HttpCode(204)
  async lp(
    @Req() req: Request,
    @Body()
    body: { choice?: string; sessionId?: string; categories?: unknown; page?: string },
  ): Promise<void> {
    await this.consent.recordLp({
      choice: body?.choice === 'granted' ? 'granted' : 'denied',
      sessionId: body?.sessionId ?? null,
      categories: body?.categories,
      ip: ip(req),
      userAgent: ua(req),
      page: body?.page ?? null,
    });
  }
}

/** IP réelle derrière Traefik : 1er hop de X-Forwarded-For, puis req.ip / socket. */
function ip(req: Request): string | null {
  const xff = req.headers['x-forwarded-for'];
  const first =
    typeof xff === 'string' ? xff.split(',')[0]?.trim() : Array.isArray(xff) ? xff[0] : undefined;
  return first || req.ip || req.socket?.remoteAddress || null;
}
function ua(req: Request): string | null {
  const v = req.headers['user-agent'];
  return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}
