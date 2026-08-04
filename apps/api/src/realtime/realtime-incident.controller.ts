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
  /** Fenêtre au-delà de laquelle deux reports ne sont plus « le même épisode » (TRK-003). */
  private static readonly REPEAT_MS = 60 * 60 * 1000;
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
    // TRK-003 — un second report pour la même flotte dans l'heure : la coupure ne se résorbe
    // pas toute seule. C'est ce qui distingue un aléa d'une panne (cf. niveau ci-dessous).
    const repeated = last > 0 && now - last < RealtimeIncidentController.REPEAT_MS;
    this.lastByScope.set(scopeKey, now);
    this.gc(now);

    const downSec = Math.round((body.downMs ?? 0) / 1000);
    const reason = body.reason ?? 'inconnu';
    const transport = body.transport ?? 'n/a';
    const neverConnected = body.everConnected === false;
    // Niveau adaptatif (moins « crier au loup ») : une coupure ≥ 2 min = CRITICAL (vraie panne,
    // plus de vue live) ; un flap court après connexion = ERROR.
    //
    // TRK-003 — `neverConnected` seul ne suffit PLUS à déclencher CRITICAL. Un premier
    // chargement de page qui met 45 s à établir son WebSocket n'est pas du même ordre qu'une
    // plateforme injoignable : sous 2 vCPU, l'API rate un pong et tous les incidents tombent
    // pile à 45 s (cf. `redis-io.adapter`). Une occurrence isolée était donc classée au niveau
    // maximal pour un aléa de charge. Il faut désormais que ça RECOMMENCE — ou que ça dure.
    // `everConnected` reste dans le corps du message : l'information n'est pas perdue, seul
    // le cri baisse.
    const level: 'ERROR' | 'CRITICAL' =
      (body.downMs ?? 0) >= 120_000 || (neverConnected && repeated) ? 'CRITICAL' : 'ERROR';
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
      // ⚠️ Purger sur DEDUPE_MS effacerait la mémoire dont dépend `repeated` (TRK-003) : on
      // garde jusqu'à la plus longue fenêtre réellement consultée.
      if (now - ts > RealtimeIncidentController.REPEAT_MS) this.lastByScope.delete(key);
    }
  }
}
