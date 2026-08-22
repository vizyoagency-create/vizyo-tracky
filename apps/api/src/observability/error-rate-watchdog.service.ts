import { CLES_REFROIDISSEMENT, RefroidissementAlerteService } from './refroidissement-alerte.service';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { EmailService } from '../email/email.service';
import { PrismaService } from '../prisma/prisma.service';

/** Source de CE service — exclue du comptage (cf. boucle de rétroaction plus bas). */
export const WATCHDOG_SOURCE = 'error-rate-watchdog';
/** Seuil par défaut : au-delà de N erreurs sur l'heure glissante, on prévient. */
const DEFAULT_THRESHOLD = 5;
/** Destinataire par défaut (surchargeable par env). */
const DEFAULT_RECIPIENT = 'contact@vizyoagency.com';
/** Une alerte au plus par heure : prévenir ne doit pas devenir spammer. */
const COOLDOWN_MS = 60 * 60 * 1000;
/** Détail affiché dans l'e-mail (les sources les plus bruyantes). */
const TOP_SOURCES = 5;

/**
 * Vigie du centre d'alerte (2026-07) — prévient par e-mail quand les erreurs s'accumulent VITE.
 *
 * Motivation (incident du 2026-07-19) : 954 échecs de coupe-circuit se sont empilés toute la nuit
 * sans que personne ne soit prévenu. Le centre d'alerte est une page qu'on consulte ; il fallait
 * quelque chose qui vienne CHERCHER l'exploitant.
 *
 * Trois précautions qui comptent :
 *  1. **Pas de boucle de rétroaction** — les erreurs de CE service sont exclues du comptage. Sans
 *     ça, un e-mail qui échoue crée une erreur, qui déclenche un e-mail, qui échoue…
 *  2. **Cooldown d'une heure** — pendant une tempête on prévient une fois, pas 60 fois.
 *  3. **Ne lève jamais** — une vigie qui casse le scheduler serait pire que pas de vigie.
 */
@Injectable()
export class ErrorRateWatchdogService {
  private readonly logger = new Logger(ErrorRateWatchdogService.name);
  // TRK-038 — refroidissement EN BASE. Cette vigie est le cas le plus embarrassant du lot :
  // l'instrument charge de crier quand les erreurs flambent portait son propre anti-flambee
  // en memoire, donc REARME par le deploiement — l'instant ou les erreurs flambent.
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    // Refroidissements d'alerte — ObservabilityModule est @Global, aucun import a ajouter.
    private readonly refroidissement: RefroidissementAlerteService,
  ) {}

  private get threshold(): number {
    const raw = Number(this.config.get('ERROR_RATE_ALERT_THRESHOLD'));
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_THRESHOLD;
  }

  private get recipient(): string {
    return (this.config.get<string>('ERROR_RATE_ALERT_TO') || DEFAULT_RECIPIENT).trim();
  }

  /**
   * Toutes les 10 min : un pic doit se voir vite, mais l'heure glissante lisse les rafales
   * ponctuelles (un cron qui rate une fois ne réveille personne).
   */
  @Cron('0 */10 * * * *')
  async check(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.evaluate(now);
    } catch (e) {
      // Volontairement PAS remonté au centre d'alerte : ce serait la boucle de rétroaction.
      this.logger.warn(`Vigie du centre d'alerte indisponible : ${(e as Error)?.message ?? e}`);
    } finally {
      this.running = false;
    }
  }

  private async evaluate(now: number): Promise<void> {
    const since = new Date(now - 60 * 60 * 1000);
    const rows = await this.prisma.errorLog.groupBy({
      by: ['source', 'level'],
      where: { createdAt: { gte: since }, source: { not: WATCHDOG_SOURCE } },
      _count: { _all: true },
    });

    const total = rows.reduce((n, r) => n + r._count._all, 0);
    if (total <= this.threshold) return;

    // Cooldown : la tempête continue ? On le saura à la prochaine fenêtre, pas 6 fois par heure.
    //
    // ⚠️ Lecture et pose sont SEPAREES ici, volontairement : le refroidissement ne doit etre
    // pose que si l'e-mail est REELLEMENT parti (voir plus bas). Une forme atomique
    // « je demande et je consomme » nous rendrait muets une heure sur une panne d'e-mail.
    const derniereAlerteAt = await this.refroidissement.derniereEmission(CLES_REFROIDISSEMENT.VIGIE_SATURATION);
    if (derniereAlerteAt && now - derniereAlerteAt.getTime() < COOLDOWN_MS) {
      this.logger.warn(`${total} erreurs sur l'heure — e-mail déjà envoyé récemment, pas de relance.`);
      return;
    }

    const critical = rows.filter((r) => r.level === 'CRITICAL').reduce((n, r) => n + r._count._all, 0);
    const bySource = new Map<string, number>();
    for (const r of rows) bySource.set(r.source, (bySource.get(r.source) ?? 0) + r._count._all);
    const top = [...bySource.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TOP_SOURCES)
      .map(([source, count]) => ({ source, count }));

    const html = this.email.buildErrorRateAlertEmail({ total, critical, threshold: this.threshold, top, since });
    // Refonte e-mails : pas de crochets de marque en tete de sujet (cf. shell()).
    const subject = `${total} erreurs en 1 h${critical > 0 ? ` (dont ${critical} critiques)` : ''}`;

    const res = await this.email.send({
      to: this.recipient,
      subject,
      html,
      text: `${total} erreurs enregistrees sur la derniere heure (seuil ${this.threshold}). Sources : ${top.map((t) => `${t.source} (${t.count})`).join(', ')}.`,
      template: 'error_rate_alert',
      context: { total, critical, threshold: this.threshold },
    });

    // On ne pose le cooldown QUE si l'envoi est parti : sinon une panne d'e-mail nous rendrait
    // muets pendant une heure alors que rien n'a été signalé.
    if (res.ok) {
      await this.refroidissement.marquerEmission(CLES_REFROIDISSEMENT.VIGIE_SATURATION, new Date(now));
      this.logger.warn(`Centre d'alerte : ${total} erreurs en 1 h — e-mail envoyé à ${this.recipient}.`);
    } else {
      this.logger.error(`Alerte de saturation NON envoyée (${res.error ?? 'erreur inconnue'})`);
    }
  }
}
