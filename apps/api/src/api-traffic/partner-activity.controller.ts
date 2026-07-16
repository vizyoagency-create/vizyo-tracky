import { Controller, HttpCode, HttpStatus, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { ApiTrafficService } from './api-traffic.service';

/**
 * Endpoint PUBLIC d'ingestion des beacons d'activité partenaire (LP / Maestroo).
 *
 * Aucune auth (même mécanisme que POST /api/leads/contact). Rate-limité. Tolérant à
 * `navigator.sendBeacon` (Content-Type text/plain → corps brut parsé en JSON, non couvert
 * par le ValidationPipe global) : on lit `@Req()` et le service sanitise/tronque tout.
 * Réponse 204 sans contenu — aucune fuite d'info.
 */
@Controller('partner')
export class PartnerActivityController {
  constructor(private readonly traffic: ApiTrafficService) {}

  @Post('activity')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  @HttpCode(HttpStatus.NO_CONTENT)
  activity(@Req() req: Request): void {
    // Garde-fou taille : ignore silencieusement un payload > ~4 Ko.
    if (this.rawLength(req) > 4096) return;
    this.traffic.recordPartnerBeacon(this.parseBody(req), {
      ip: this.extractIp(req),
      userAgent: this.header(req, 'user-agent'),
      origin: this.header(req, 'origin') ?? this.header(req, 'referer'),
    });
  }

  /** Corps parsé : req.body si déjà objet (application/json), sinon rawBody en JSON tolérant. */
  private parseBody(req: Request): unknown {
    const b = (req as { body?: unknown }).body;
    if (b && typeof b === 'object' && Object.keys(b as object).length > 0) return b;
    const raw = (req as { rawBody?: Buffer }).rawBody;
    if (raw && raw.length) {
      try {
        return JSON.parse(raw.toString('utf8'));
      } catch {
        return {};
      }
    }
    if (typeof b === 'string' && b.length) {
      try {
        return JSON.parse(b);
      } catch {
        return {};
      }
    }
    return {};
  }

  private rawLength(req: Request): number {
    const raw = (req as { rawBody?: Buffer }).rawBody;
    if (raw) return raw.length;
    const cl = req.headers['content-length'];
    return cl ? Number.parseInt(Array.isArray(cl) ? cl[0] : cl, 10) || 0 : 0;
  }

  private extractIp(req: Request): string | null {
    const xff = req.headers['x-forwarded-for'];
    const first =
      typeof xff === 'string' ? xff.split(',')[0]?.trim() : Array.isArray(xff) ? xff[0] : undefined;
    return first || req.ip || req.socket?.remoteAddress || null;
  }

  private header(req: Request, name: string): string | null {
    const v = req.headers[name];
    return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
  }
}
