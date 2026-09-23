import { CLES_REFROIDISSEMENT, RefroidissementAlerteService } from './refroidissement-alerte.service';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DemoModeService } from '../demo/demo-mode.service';
import { EmailService } from '../email/email.service';
import { UserRole } from '@prisma/client';
import { NotificationDispatchService } from '../notifications/notification-dispatch.service';
import { PrismaService } from '../prisma/prisma.service';
import { ReglagesAlertesExploitationService } from './reglages-alertes-exploitation.service';

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
 *
 * ── ET UNE ERREUR CRITIQUE SUFFIT (2026-09-08) ────────────────────────────────────────────
 * Le seuil ne regardait que le DÉBIT. Un passage d'automatisation tué, un agent local muet,
 * une base injoignable écrivent UNE ligne CRITICAL — et personne n'était prévenu tant que
 * quatre autres erreurs ne suivaient pas (mesuré le 2026-09-07 : « Passage manqué :
 * agent-limites-vitesse » à 18:50, aucun e-mail). Désormais toute erreur critique de l'heure
 * prévient, sous le seuil, avec son propre refroidissement d'une heure ; au-dessus du seuil,
 * l'e-mail de saturation la cite déjà et pose les deux refroidissements — un seul e-mail par
 * heure, quelle que soit la vigie qui parle.
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
    // Environnement de démonstration : ses erreurs ne concernent pas l'exploitation.
    // Optionnel pour les specs, qui instancient ce service sans conteneur DI.
    @Optional() private readonly demoMode?: DemoModeService,
    /**
     * Canaux réglables (2026-09-23). `@Optional()` : les specs montent ce service à la main, et
     * son absence doit laisser les DEUX canaux ouverts — jamais rendre l'exploitation muette.
     */
    @Optional() private readonly canaux?: ReglagesAlertesExploitationService,
    /** Socle de notification : c'est lui qui pousse aux super-admins. `@Optional()`, même raison. */
    @Optional() private readonly dispatch?: NotificationDispatchService,
  ) {}

  /**
   * ── LA VIGIE POUSSE, ELLE NE FAIT PLUS QUE POSTER (2026-09-23) ─────────────────────────────
   *
   * Elle n'avait QU'UN canal : l'e-mail. 81 courriels en 14 jours vers la boîte d'exploitation,
   * dont 65 « erreur critique ». Le propriétaire voulait couper l'e-mail — mais le couper
   * l'aurait laissé sans rien, puisque rien d'autre ne partait. On ouvre donc le second canal
   * AVANT de rendre le premier débrayable : c'est l'ordre qui évite le silence.
   *
   * Le socle générique s'applique par-dessus : `PUSH_ROLLOUT`, les préférences de chaque
   * super-admin, l'anti-spam et le journal des notifications. Best-effort — un push qui échoue
   * ne doit ni casser la vigie ni empêcher l'e-mail.
   */
  private async pousser(sujet: string, titre: string, corps: string): Promise<void> {
    if (!this.dispatch) return;
    if (this.canaux && !(await this.canaux.pushAutorise())) return;
    try {
      const admins = await this.prisma.user.findMany({
        where: { role: UserRole.SUPER_ADMIN, isActive: true },
        select: { id: true },
      });
      if (admins.length === 0) return;
      await this.dispatch.notifyUsers({
        userIds: admins.map((a) => a.id),
        category: 'SYSTEM',
        kind: 'centre-alerte',
        subjectKey: sujet,
        title: titre,
        body: corps,
        url: '/admin/alerts',
      });
    } catch (e) {
      // Volontairement PAS remonté au centre d'alerte : ce serait la boucle de rétroaction.
      this.logger.warn(`Notification de la vigie non poussée (${sujet}) : ${(e as Error)?.message ?? e}`);
    }
  }

  /** L'e-mail est-il autorisé ? Absence de service = oui (fail-open, cf. constructeur). */
  private async emailAutorise(): Promise<boolean> {
    return this.canaux ? this.canaux.emailAutorise() : true;
  }

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
    // ══ DÉMO — NE JAMAIS ALERTER L'EXPLOITATION ════════════════════════════════
    //
    // Mesuré le 2026-09-07, jour de la mise en service : la démo a écrit « 54 erreurs
    // en 1 h (dont 6 critiques) » à contact@vizyoagency.com. Aucune ne venait de la
    // production, et la quasi-totalité était auto-infligée — passerelle SMS absente
    // en démo, par conception.
    //
    // Une alerte de démo dans la boîte d'exploitation ne se distingue pas d'une vraie.
    // C'est ainsi qu'on cesse de les lire, et qu'une vraie panne passe inaperçue. Les
    // erreurs de la démo restent visibles dans SON propre centre d'alerte, ce qui
    // suffit à qui la prépare avant un rendez-vous.
    if (this.demoMode?.enabled) return;
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

  /**
   * `ERROR_CRITICAL_ALERT=off` coupe la vigie des critiques sans toucher à celle de saturation :
   * un interrupteur par vigie, pour ne jamais avoir à choisir entre les deux.
   */
  private get critiquesActives(): boolean {
    const brut = String(this.config.get('ERROR_CRITICAL_ALERT') ?? '').trim().toLowerCase();
    return !['off', '0', 'false', 'non'].includes(brut);
  }

  private async evaluate(now: number): Promise<void> {
    const since = new Date(now - 60 * 60 * 1000);
    const comptage = await this.prisma.errorLog.groupBy({
      by: ['source', 'level'],
      where: { createdAt: { gte: since }, source: { not: WATCHDOG_SOURCE } },
      _count: { _all: true },
    });
    const rows: LigneComptage[] = comptage.map((r) => ({ source: r.source, level: r.level, _count: { _all: r._count._all } }));

    const total = rows.reduce((n, r) => n + r._count._all, 0);
    const critical = rows.filter((r) => r.level === 'CRITICAL').reduce((n, r) => n + r._count._all, 0);

    // Deux vigies, un seul e-mail par heure : la saturation a la priorité (elle cite déjà les
    // critiques), et la critique ne parle que SOUS le seuil de débit — là où, avant le
    // 2026-09-08, une panne isolée restait muette.
    if (total > this.threshold) {
      await this.alerterSaturation({ rows, total, critical, since, now });
      return;
    }
    if (critical > 0 && this.critiquesActives) {
      await this.alerterCritiques({ rows, total, critical, since, now });
    }
  }

  private async alerterSaturation(constat: Constat): Promise<void> {
    const { rows, total, critical, since, now } = constat;

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

    const top = sourcesLesPlusBruyantes(rows);
    const detail = top.map((t) => `${t.source} (${t.count})`).join(', ');
    // Refonte e-mails : pas de crochets de marque en tete de sujet (cf. shell()).
    const subject = `${total} erreurs en 1 h${critical > 0 ? ` (dont ${critical} critiques)` : ''}`;

    // Le PUSH d'abord, et indépendamment de l'e-mail : c'est le canal que le propriétaire a
    // demandé de privilégier, et il ne doit pas dépendre du sort d'un envoi SMTP.
    await this.pousser(
      CLES_REFROIDISSEMENT.VIGIE_SATURATION,
      subject,
      `Seuil ${this.threshold} dépassé. Sources : ${detail}.`,
    );

    if (!(await this.emailAutorise())) {
      // Canal e-mail coupé par réglage : on pose quand même le refroidissement, sinon la vigie
      // repousserait à chaque passage de 10 min au lieu d'une fois par heure.
      await this.refroidissement.marquerEmission(CLES_REFROIDISSEMENT.VIGIE_SATURATION, new Date(now));
      if (critical > 0) await this.refroidissement.marquerEmission(CLES_REFROIDISSEMENT.VIGIE_CRITIQUE, new Date(now));
      this.logger.warn(`Centre d'alerte : ${total} erreurs en 1 h — poussé aux super-admins (e-mail coupé par réglage).`);
      return;
    }

    const html = this.email.buildErrorRateAlertEmail({ total, critical, threshold: this.threshold, top, since });
    const res = await this.email.send({
      to: this.recipient,
      subject,
      html,
      text: `${total} erreurs enregistrees sur la derniere heure (seuil ${this.threshold}). Sources : ${detail}.`,
      template: 'error_rate_alert',
      context: { total, critical, threshold: this.threshold },
    });

    // On ne pose le cooldown QUE si l'envoi est parti : sinon une panne d'e-mail nous rendrait
    // muets pendant une heure alors que rien n'a été signalé.
    if (res.ok) {
      await this.refroidissement.marquerEmission(CLES_REFROIDISSEMENT.VIGIE_SATURATION, new Date(now));
      // Cet e-mail cite déjà les critiques : pas un second e-mail dix minutes plus tard.
      if (critical > 0) {
        await this.refroidissement.marquerEmission(CLES_REFROIDISSEMENT.VIGIE_CRITIQUE, new Date(now));
      }
      this.logger.warn(`Centre d'alerte : ${total} erreurs en 1 h — e-mail envoyé à ${this.recipient}.`);
    } else {
      this.logger.error(`Alerte de saturation NON envoyée (${res.error ?? 'erreur inconnue'})`);
    }
  }

  /** Une erreur critique suffit — même seule, même sous le seuil de débit. */
  private async alerterCritiques(constat: Constat): Promise<void> {
    const { rows, total, critical, since, now } = constat;
    const s = critical > 1 ? 's' : '';

    const derniereAlerteAt = await this.refroidissement.derniereEmission(CLES_REFROIDISSEMENT.VIGIE_CRITIQUE);
    if (derniereAlerteAt && now - derniereAlerteAt.getTime() < COOLDOWN_MS) {
      this.logger.warn(`${critical} erreur${s} critique${s} sur l'heure — e-mail déjà envoyé récemment, pas de relance.`);
      return;
    }

    // Le détail ne montre que les sources CRITIQUES : c'est elles qu'on vient lire.
    const top = sourcesLesPlusBruyantes(rows.filter((r) => r.level === 'CRITICAL'));
    const subject = `${critical} erreur${s} critique${s} — ${top[0]?.source ?? "centre d'alerte"}`;

    await this.pousser(
      CLES_REFROIDISSEMENT.VIGIE_CRITIQUE,
      subject,
      `Sources : ${top.map((t) => `${t.source} (${t.count})`).join(', ')}.`,
    );

    if (!(await this.emailAutorise())) {
      await this.refroidissement.marquerEmission(CLES_REFROIDISSEMENT.VIGIE_CRITIQUE, new Date(now));
      this.logger.warn(
        `Centre d'alerte : ${critical} erreur${s} critique${s} en 1 h — poussé aux super-admins (e-mail coupé par réglage).`,
      );
      return;
    }

    const html = this.email.buildCriticalErrorAlertEmail({ critical, total, top, since });
    const res = await this.email.send({
      to: this.recipient,
      subject,
      html,
      text: `${critical} erreur${s} critique${s} sur la derniere heure (${total} erreur${total > 1 ? 's' : ''} en tout). Sources : ${top.map((t) => `${t.source} (${t.count})`).join(', ')}.`,
      template: 'critical_error_alert',
      context: { critical, total },
    });

    // Même règle que la saturation : le refroidissement n'est posé que si l'e-mail est parti.
    if (res.ok) {
      await this.refroidissement.marquerEmission(CLES_REFROIDISSEMENT.VIGIE_CRITIQUE, new Date(now));
      this.logger.warn(`Centre d'alerte : ${critical} erreur${s} critique${s} en 1 h — e-mail envoyé à ${this.recipient}.`);
    } else {
      this.logger.error(`Alerte critique NON envoyée (${res.error ?? 'erreur inconnue'})`);
    }
  }
}

/** Une ligne du comptage `groupBy` : une source, un niveau, un nombre. */
interface LigneComptage {
  source: string;
  level: string;
  _count: { _all: number };
}

/** Ce que l'heure glissante a donné, partagé par les deux vigies. */
interface Constat {
  rows: LigneComptage[];
  total: number;
  critical: number;
  since: Date;
  now: number;
}

/** Les sources les plus bruyantes, dans l'ordre, pour le détail de l'e-mail. */
function sourcesLesPlusBruyantes(rows: LigneComptage[]): { source: string; count: number }[] {
  const parSource = new Map<string, number>();
  for (const r of rows) parSource.set(r.source, (parSource.get(r.source) ?? 0) + r._count._all);
  return [...parSource.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_SOURCES)
    .map(([source, count]) => ({ source, count }));
}
