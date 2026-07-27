import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Une erreur qui se DÉCLARE passagère (`transient: true`) est journalisée mais pas archivée au
 * centre d'alerte. Contrat volontairement structurel plutôt que textuel : reconnaître « 529 » ou
 * « overloaded » dans un message serait fragile et attraperait des erreurs légitimes au passage.
 * Aujourd'hui posé par `AiServiceError` (fournisseur IA saturé/quota/réseau) ; ouvert à tout
 * service qui aurait la même situation.
 */
export function isTransient(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { transient?: unknown }).transient === true;
}

/**
 * Marqueur posé sur une erreur DÉJÀ archivée, pour qu'une couche supérieure qui la rattrape ne
 * l'archive pas une SECONDE fois.
 *
 * Cas réel (2026-07-27) : `TripAnalysisLlmService.run()` archive l'échec IA sous `TRIP_ANALYSIS_AI`
 * puis re-lève ; `TripAutomationService` le rattrape et l'archive sous `TRAJET_AUTOMATION` → DEUX
 * lignes à la milliseconde près pour UN seul incident. La dédup par empreinte ne les voit pas :
 * elle porte sur `source|niveau|message`, et c'est justement la source qui diffère.
 *
 * On marque donc l'INSTANCE d'erreur elle-même : seule la couche la plus proche de la panne (la
 * mieux renseignée en contexte) écrit. Non énumérable → n'altère ni la sérialisation ni les
 * comparaisons de tests. Symbol partagé (`Symbol.for`) pour rester robuste à un double chargement
 * du module.
 */
const RECORDED = Symbol.for('tracky.errorLogger.recorded');

/** Vrai si cette instance d'erreur a déjà été archivée par une couche inférieure. */
function alreadyRecorded(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as Record<symbol, unknown>)[RECORDED] === true;
}

/** Marque l'instance comme archivée. Silencieux si l'objet est gelé ou n'accepte pas la propriété. */
function markRecorded(error: unknown): void {
  if (typeof error !== 'object' || error === null) return;
  try {
    Object.defineProperty(error, RECORDED, { value: true, enumerable: false, configurable: true });
  } catch {
    /* objet gelé : tant pis, on retombe sur le comportement d'avant (doublon possible) */
  }
}

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

    // Échec PASSAGER d'un service tiers (fournisseur IA saturé, quota, réseau) : ni un bug de
    // l'app, ni une action à mener. On le trace dans les logs du conteneur mais on ne l'archive
    // PAS — sinon il gonfle le centre d'alerte et déclenche la vigie de saturation pour du bruit
    // fournisseur. Même traitement que les 429 de Vizyo Auth (cf. `all-exceptions.filter`).
    // Canard-typage volontaire : aucun import du module IA ici (l'observabilité ne doit rien
    // savoir de l'IA), n'importe quel service peut marquer ses erreurs `transient`.
    if (isTransient(error)) {
      this.logger.warn(`[${source}] ${message} (passager — non archivé)`);
      return 'transient';
    }

    // Déjà archivée par la couche qui l'a levée : on ne réécrit pas la même panne sous une autre
    // source. La ligne existante porte le contexte le plus précis (cf. RECORDED).
    if (alreadyRecorded(error)) {
      this.logger.warn(`[${source}] ${message} (déjà archivé par une couche inférieure)`);
      return 'already-recorded';
    }

    // Dédup : même source + niveau + début de message dans la fenêtre → on incrémente le
    // compteur et on n'écrit PAS de nouvelle ligne (le centre d'alerte reste lisible).
    const fingerprint = `${source}|${level}|${(message ?? '').slice(0, 140)}`;
    const now = Date.now();
    const seen = this.recent.get(fingerprint);
    if (seen && now - seen.at < this.dedupMs) {
      seen.suppressed += 1;
      markRecorded(error); // l'incident est déjà représenté : une couche au-dessus ne doit pas le réécrire
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
      markRecorded(error);
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
