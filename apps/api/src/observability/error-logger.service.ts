import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ErrorLogContext {
  imei?: string;
  commandId?: string;
  userId?: string;
  trackerId?: string;
  vehicleId?: string;
  fleetId?: string;
  requestId?: string;
  route?: string;
  [key: string]: unknown;
}

/**
 * Journalise les erreurs serveur au « centre d'alerte » (table error_logs) — la vue admin
 * SUPER_ADMIN qui doit rendre visible TOUTE faute réelle (« zéro erreur fantôme ») sans pour
 * autant « crier au loup ».
 *
 * Anti-flood : une même erreur en rafale (même source+niveau+début de message) n'écrit QU'UNE
 * ligne par fenêtre de dédup ; les occurrences suivantes sont comptées et reportées dans
 * `context.repeatedSuppressed` à la prochaine écriture. Sans ça, un cron qui échoue toutes les
 * 30 s produirait des milliers de lignes et noierait les vraies erreurs.
 *
 * `recordBackground()` est la variante FIRE-AND-FORGET pour les chemins d'arrière-plan
 * (fire-and-forget `.catch`, handlers process, crons) : ne s'attend jamais, ne jette JAMAIS.
 */
@Injectable()
export class ErrorLogger {
  private readonly logger = new Logger('ErrorLogger');

  /** Dédup mémoire : empreinte → { dernier ts écrit, occurrences supprimées depuis }. */
  private readonly recent = new Map<string, { at: number; suppressed: number }>();
  private readonly dedupMs = 60_000;
  private lastPrune = Date.now();

  constructor(private readonly prisma: PrismaService) {}

  async record(
    error: Error | string,
    source: string,
    context?: ErrorLogContext,
    level: 'ERROR' | 'CRITICAL' = 'ERROR',
  ): Promise<string> {
    const message = typeof error === 'string' ? error : error.message;
    const stack = typeof error === 'string' ? undefined : error.stack;

    // Dédup : même source + niveau + début de message dans la fenêtre → on incrémente le
    // compteur et on n'écrit PAS de nouvelle ligne (le centre d'alerte reste lisible).
    const fingerprint = `${source}|${level}|${(message ?? '').slice(0, 140)}`;
    const now = Date.now();
    const seen = this.recent.get(fingerprint);
    if (seen && now - seen.at < this.dedupMs) {
      seen.suppressed += 1;
      return 'deduped';
    }
    const suppressed = seen?.suppressed ?? 0;
    this.recent.set(fingerprint, { at: now, suppressed: 0 });
    this.pruneMaybe(now);

    this.logger.error({ source, ...context, stack }, `[${source}] ${message}`);

    try {
      const enrichedContext =
        suppressed > 0
          ? { ...(context ?? {}), repeatedSuppressed: suppressed }
          : context;
      const row = await this.prisma.errorLog.create({
        data: {
          level,
          source,
          message,
          stack: stack ?? null,
          imei: context?.imei ?? null,
          commandId: context?.commandId ?? null,
          userId: context?.userId ?? null,
          context: enrichedContext ? (enrichedContext as any) : undefined,
        },
      });
      return row.id;
    } catch (dbErr) {
      // Ne JAMAIS relancer : sinon un souci DB en écrivant l'erreur relance une erreur
      // (boucle de rétroaction via le handler process). On se contente du log console.
      this.logger.error('Failed to persist ErrorLog', dbErr);
      return 'persist-failed';
    }
  }

  /**
   * Variante FIRE-AND-FORGET : pour les chemins d'arrière-plan qui ne peuvent pas (ou ne
   * veulent pas) `await`. Ne jette jamais et n'interrompt jamais l'appelant. À utiliser à la
   * place d'un `.catch(e => logger.warn(e))` qui rendrait l'erreur invisible au centre d'alerte.
   */
  recordBackground(
    error: Error | string,
    source: string,
    context?: ErrorLogContext,
    level: 'ERROR' | 'CRITICAL' = 'ERROR',
  ): void {
    try {
      void this.record(error, source, context, level).catch(() => undefined);
    } catch {
      /* la remontée d'erreur ne doit JAMAIS casser l'appelant */
    }
  }

  /** Purge périodique de la table de dédup (borne mémoire). */
  private pruneMaybe(now: number): void {
    if (now - this.lastPrune < 5 * 60_000) return;
    this.lastPrune = now;
    for (const [k, v] of this.recent) if (now - v.at > this.dedupMs) this.recent.delete(k);
    if (this.recent.size > 20_000) this.recent.clear();
  }
}
