import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { AuthenticatedRequest, JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { ErrorLogger } from '../observability/error-logger.service';
import { RealtimeIncidentDto } from './dto/realtime-incident.dto';

/**
 * Sprint 0.1 — remontée des interruptions du canal temps réel au centre d'alerte.
 *
 * Quand le socket WS d'un utilisateur reste coupé au-delà d'un seuil (le bandeau
 * « Connexion temps réel interrompue » s'affiche), le front POST ici. On
 * enregistre un incident CRITICAL via {@link ErrorLogger} → visible dans le
 * centre d'alerte admin (`/api/admin/alerts`, section erreurs/critical). C'est
 * une panne grave : sans live, les utilisateurs n'ont plus la position de leurs
 * véhicules.
 *
 * Anti-flood : sous une panne globale (CPU VPS saturé → tous les clients
 * tombent), des dizaines de clients reporteraient en même temps. On déduplique
 * en mémoire par flotte sur une fenêtre de 5 min ; un `@Throttle` limite aussi
 * le débit par IP.
 */
@Controller('realtime')
@UseGuards(JwtAuthGuard)
export class RealtimeIncidentController {
  private static readonly DEDUPE_MS = 5 * 60 * 1000;
  private readonly lastByScope = new Map<string, number>();

  constructor(private readonly errorLogger: ErrorLogger) {}

  @Post('incident')
  @Throttle({ default: { ttl: 60_000, limit: 6 } })
  async report(
    @Req() req: AuthenticatedRequest,
    @Body() body: RealtimeIncidentDto,
  ): Promise<{ recorded: boolean }> {
    const user = req.user;
    const scopeKey = user.fleetId ?? `user:${user.id}`;
    const now = Date.now();

    const last = this.lastByScope.get(scopeKey) ?? 0;
    if (now - last < RealtimeIncidentController.DEDUPE_MS) {
      return { recorded: false };
    }
    this.lastByScope.set(scopeKey, now);
    this.gc(now);

    const downSec = Math.round((body.downMs ?? 0) / 1000);
    const reason = body.reason ?? 'inconnu';
    const transport = body.transport ?? 'n/a';
    const neverConnected = body.everConnected === false;
    // Niveau adaptatif (moins « crier au loup ») : JAMAIS connecté OU coupure ≥ 2 min = CRITICAL
    // (vraie panne, plus de vue live) ; un flap court après connexion = ERROR (visible sans gonfler
    // le compteur critique). Le détail (reason/transport/flaps) donne la cause racine.
    const level: 'ERROR' | 'CRITICAL' =
      neverConnected || (body.downMs ?? 0) >= 120_000 ? 'CRITICAL' : 'ERROR';
    const head = neverConnected
      ? `Canal temps réel JAMAIS établi (${downSec}s) — API/WS injoignable`
      : `Connexion temps réel interrompue (${downSec}s sans live)`;
    const detail = `reason=${reason}, transport=${transport}, flaps=${body.flaps ?? 0}${body.lastError ? `, err=${body.lastError}` : ''}`;
    await this.errorLogger.record(
      `${head} — ${detail}`,
      'realtime-client',
      {
        userId: user.id,
        fleetId: user.fleetId ?? undefined,
        route: '/map',
        downMs: body.downMs ?? null,
        reason,
        transport,
        flaps: body.flaps ?? null,
        everConnected: body.everConnected ?? null,
        lastError: body.lastError ?? null,
      },
      level,
    );
    return { recorded: true };
  }

  /** Purge les entrées de dédup expirées (évite une croissance non bornée). */
  private gc(now: number): void {
    if (this.lastByScope.size <= 500) return;
    for (const [key, ts] of this.lastByScope) {
      if (now - ts > RealtimeIncidentController.DEDUPE_MS) this.lastByScope.delete(key);
    }
  }
}
