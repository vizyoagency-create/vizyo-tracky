import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SystemActivityService } from '../system-activity/system-activity.service';

export interface AllowlistEntryDto {
  id: string;
  phone: string;
  label: string | null;
  source: string;
  createdAt: string;
}

export interface AllowlistSyncResult {
  added: number;
  removed: number;
  unchanged: number;
  skipped: number;
  /**
   * Suppressions RETENUES par la garde anti-suppression de masse de la passerelle
   * (V1.20). Optionnel : une passerelle anterieure au 2026-08-10 ne renvoie pas ce champ.
   */
  removalsBlocked?: number;
}

export interface AllowlistStatus {
  entries: AllowlistEntryDto[];
  total: number;
  trackersWithSim: number;
  /** Trackers dont le simPhoneNumber n'est PAS dans l'allowlist (a synchroniser). */
  missing: { imei: string; phone: string }[];
  /** Entrees 'synced' sans tracker correspondant (SIM changee / tracker supprime). */
  orphans: { phone: string; label: string | null }[];
}

/**
 * V1.14 — Gere l'allowlist du tenant Tracky cote vizyo-texto, via son API
 * /v1/allowlist (auth api-key VIZYO_TEXTO_API_KEY), + la reconciliation avec
 * les SIM des trackers Tracky (source de verite).
 */
@Injectable()
export class AllowlistService {
  private readonly logger = new Logger(AllowlistService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly errorLogger: ErrorLogger,
    private readonly systemActivity: SystemActivityService,
  ) {
    this.baseUrl = (this.config.get('VIZYO_TEXTO_URL', { infer: true }) ?? '').replace(/\/+$/, '');
    this.apiKey = this.config.get('VIZYO_TEXTO_API_KEY', { infer: true }) ?? '';
  }

  // ─── Auto-sync sur changement de SIM tracker ──────────────────────────────
  private syncing = false;
  private syncPending = false;

  /**
   * Reconcilie l'allowlist quand un tracker.simPhoneNumber change (event).
   * Coalesce les rafales (si un sync tourne deja, re-run a la fin) ; best-effort
   * (si vizyo-texto est down, on log et on abandonne — un sync manuel ou un
   * prochain event reconciliera).
   */
  @OnEvent('tracker.sim-changed')
  async onTrackerSimChanged(): Promise<void> {
    if (!this.baseUrl || !this.apiKey || this.syncing) {
      if (this.syncing) this.syncPending = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.syncPending = false;
        await this.syncFromTrackers();
      } while (this.syncPending);
    } catch (err) {
      this.logger.warn(`auto-sync allowlist echoue: ${err instanceof Error ? err.message : err}`);
      // A6 — persiste l'echec dans ErrorLog pour visibilite.
      this.errorLogger.record(
        err instanceof Error ? err : new Error(String(err)),
        'sms-allowlist',
        { trigger: 'auto-sync' },
      ).catch((e) => this.logger.error('ErrorLog persist failed', e));
    } finally {
      this.syncing = false;
    }
  }

  /**
   * Réconciliation PÉRIODIQUE de l'allowlist (toutes les heures).
   *
   * Jusqu'ici la synchro ne partait QUE sur `tracker.sim-changed`. Un seul événement manqué —
   * vizyo-texto injoignable à cet instant, SIM saisie avant l'existence de l'auto-synchro, échec
   * réseau silencieux — et le numéro n'entrait jamais dans l'allowlist. Rien ne le rattrapait, et
   * rien ne le signalait : le symptôme n'apparaissait qu'au pire moment, un 403 « hors allowlist »
   * au moment d'un repli SMS de coupe-circuit.
   *
   * Constat prod 2026-07-27 : 9 SIM de boîtiers sur 39 étaient absentes de l'allowlist — le repli
   * SMS était donc MORT pour ces véhicules, en silence.
   *
   * Idempotent (le PUT /sync reconcilie la liste entière) et non bloquant. Une dérive RÉELLEMENT
   * corrigée est remontée au centre d'alerte : elle signale que des SMS n'auraient pas pu partir.
   */
  @Cron('0 25 * * * *')
  async reconcilePeriodically(): Promise<void> {
    if (!this.baseUrl || !this.apiKey || this.syncing) return;
    this.syncing = true;
    try {
      const result = await this.syncFromTrackers();

      // ── Preuve d'exécution — inconditionnelle ────────────────────────────────
      // Jusqu'au 2026-08-10, un passage qui ne changeait rien n'écrivait RIEN. Impossible
      // donc de distinguer « a tourné, tout allait bien » de « n'a pas tourné » : l'audit
      // TRK-017 a mis deux passages à trancher cette seule question. Une trace par
      // exécution, même à zéro, la rend lisible en une requête.
      // Volontairement au journal système (consultable) et PAS au centre d'alerte : une
      // exécution normale n'est pas une faute.
      this.systemActivity.record({
        category: 'SMS',
        action: 'allowlist_reconciled',
        status: 'SUCCESS',
        actor: 'system',
        detail: `+${result.added} / -${result.removed} (${result.unchanged} inchangés)`,
        meta: { ...result, episodeRepairs: this.episodeRepairs },
      });

      this.reportCoverage(result);
    } catch (err) {
      this.logger.warn(`reconciliation allowlist echouee: ${err instanceof Error ? err.message : err}`);
      this.errorLogger.recordBackground(
        err instanceof Error ? err : new Error(String(err)),
        'sms-allowlist',
        { trigger: 'reconcile-cron' },
      );
    } finally {
      this.syncing = false;
    }
  }

  // ─── État de l'épisode de couverture en cours ──────────────────────────────
  /** Instant d'ouverture de l'épisode courant (trou de couverture non refermé durablement). */
  private episodeOpenedAt: number | null = null;
  /** Nombre de réparations depuis l'ouverture de l'épisode. */
  private episodeRepairs = 0;
  /** Dernière remontée au centre d'alerte pour cet épisode. */
  private lastEpisodeAlertAt = 0;
  /** Un état qui dure se CONSULTE ; on ne le re-notifie qu'une fois par jour. */
  private static readonly EPISODE_REMINDER_MS = 24 * 60 * 60 * 1000;

  /**
   * Décide de ce qui mérite le centre d'alerte, et de ce qui n'y a pas sa place.
   *
   * Le défaut d'origine : une ligne d'erreur à CHAQUE réparation. En régime normal ça ne
   * se voyait pas ; le 2026-08-10, un tiers effaçant l'allowlist plusieurs fois par jour a
   * produit six lignes identiques en dix-neuf heures — six fois le même fait, aucune
   * information nouvelle après la première. *Un état qui dure se consulte, il ne se notifie
   * pas en boucle.*
   *
   * ⚠️ Ce qui n'est PAS fait ici, exprès : rien n'est rendu muet. Le premier trou d'un
   * épisode alerte toujours, immédiatement ; un épisode qui persiste réalerte chaque jour ;
   * et la fermeture est tracée. On corrige le cri, pas le garde-fou.
   */
  private reportCoverage(result: AllowlistSyncResult, now = Date.now()): void {
    // Une suppression de masse retenue par la passerelle est un fait NEUF et grave : quelque
    // chose a demandé le retrait d'une large part de la couverture SMS. Toujours remonté.
    if ((result.removalsBlocked ?? 0) > 0) {
      this.errorLogger.recordBackground(
        `Allowlist SMS : ${result.removalsBlocked} suppression(s) retenues par la passerelle — ` +
          `cette synchronisation aurait retiré le repli SMS à autant de destinataires. ` +
          `Vérifier le journal des appels de la passerelle avant de débloquer.`,
        'sms-allowlist',
        { trigger: 'reconcile-cron', removalsBlocked: result.removalsBlocked },
      );
    }

    if (result.added === 0) {
      // Couverture complète. Si un épisode était ouvert, il se referme : on le trace au
      // journal système (pas au centre d'alerte — une bonne nouvelle n'est pas une faute).
      if (this.episodeOpenedAt !== null) {
        const hours = Math.round((now - this.episodeOpenedAt) / 36e5);
        this.systemActivity.record({
          category: 'SMS',
          action: 'allowlist_episode_closed',
          status: 'SUCCESS',
          actor: 'system',
          detail: `Couverture SMS rétablie durablement après ${this.episodeRepairs} réparation(s) sur ~${hours} h`,
          meta: { repairs: this.episodeRepairs, hours },
        });
        this.episodeOpenedAt = null;
        this.episodeRepairs = 0;
        this.lastEpisodeAlertAt = 0;
      }
      return;
    }

    // Des numéros manquaient : ils ne pouvaient PAS recevoir de SMS (403 côté passerelle,
    // levé avant toute écriture — donc sans laisser la moindre trace ailleurs).
    this.episodeRepairs += 1;
    const isNewEpisode = this.episodeOpenedAt === null;
    if (isNewEpisode) this.episodeOpenedAt = now;
    const openedAt = this.episodeOpenedAt ?? now;

    const dueForReminder = now - this.lastEpisodeAlertAt >= AllowlistService.EPISODE_REMINDER_MS;
    if (!isNewEpisode && !dueForReminder) {
      this.logger.warn(
        `Allowlist SMS : ${result.added} numéro(s) rétablis (réparation n°${this.episodeRepairs} ` +
          `de l'épisode en cours) — déjà signalé, pas de nouvelle ligne au centre d'alerte.`,
      );
      return;
    }
    this.lastEpisodeAlertAt = now;

    const recurrence =
      this.episodeRepairs > 1
        ? ` Le trou se ROUVRE : ${this.episodeRepairs} réparations depuis ${new Date(openedAt).toISOString()} — ` +
          `quelque chose retire ces numéros entre deux réconciliations (journal des appels de la passerelle).`
        : '';

    this.errorLogger.recordBackground(
      `Allowlist SMS incomplète : ${result.added} numéro(s) manquant(s) rétabli(s) — le repli SMS ` +
        `(coupe-circuit, notifications) était inopérant pour ces destinataires.${recurrence}`,
      'sms-allowlist',
      {
        trigger: 'reconcile-cron',
        added: result.added,
        removed: result.removed,
        episodeRepairs: this.episodeRepairs,
        episodeOpenedAt: new Date(openedAt).toISOString(),
      },
    );
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.baseUrl || !this.apiKey) {
      throw new ServiceUnavailableException(
        'vizyo-texto non configure (VIZYO_TEXTO_URL / VIZYO_TEXTO_API_KEY)',
      );
    }
    let res: Response;
    try {
      // B3 — timeout 10s pour ne pas rester pendu si le relay hang.
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(init?.headers ?? {}),
        },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`vizyo-texto injoignable (${path}): ${msg}`);
      throw new ServiceUnavailableException(`vizyo-texto injoignable : ${msg}`);
    }
    // B5 — si le JSON est malformé, throw au lieu de retourner un objet vide corrompu.
    let jsonParseOk = true;
    const data = (await res.json().catch(() => { jsonParseOk = false; return {}; })) as T & { message?: string };
    if (!res.ok) {
      throw new ServiceUnavailableException(data.message ?? `vizyo-texto HTTP ${res.status}`);
    }
    if (!jsonParseOk) {
      throw new ServiceUnavailableException('vizyo-texto: response body malformé (JSON invalide)');
    }
    return data;
  }

  list(): Promise<AllowlistEntryDto[]> {
    return this.call<AllowlistEntryDto[]>('/v1/allowlist');
  }

  add(phone: string, label?: string): Promise<AllowlistEntryDto> {
    return this.call<AllowlistEntryDto>('/v1/allowlist', {
      method: 'POST',
      body: JSON.stringify({ phone, label }),
    });
  }

  remove(phone: string): Promise<{ removed: boolean }> {
    return this.call<{ removed: boolean }>(`/v1/allowlist/${encodeURIComponent(phone)}`, {
      method: 'DELETE',
    });
  }

  /**
   * Pousse vers l'allowlist vizyo-texto (source='synced') :
   *   - les `simPhoneNumber` des trackers (label `Tracker <imei>`)
   *   - les `User.phone` des utilisateurs actifs (label `User <email>`) — requis
   *     pour que les notifications SMS d'alerte (V1.15) soient livrees : sans ca
   *     vizyo-texto renvoie 403 sur un numero non-allowliste.
   * Dedup par numero ; un tracker prime sur un user en cas de meme numero.
   */
  async syncFromTrackers(): Promise<AllowlistSyncResult> {
    const [trackers, users] = await Promise.all([
      this.prisma.tracker.findMany({
        where: { simPhoneNumber: { not: null } },
        select: { imei: true, simPhoneNumber: true },
      }),
      this.prisma.user.findMany({
        where: { phone: { not: null }, isActive: true },
        select: { email: true, phone: true },
      }),
    ]);
    const byPhone = new Map<string, string>();
    for (const t of trackers) byPhone.set(t.simPhoneNumber as string, `Tracker ${t.imei}`);
    for (const u of users) {
      const phone = u.phone as string;
      if (!byPhone.has(phone)) byPhone.set(phone, `User ${u.email}`);
    }
    const entries = Array.from(byPhone, ([phone, label]) => ({ phone, label }));
    const result = await this.call<AllowlistSyncResult>('/v1/allowlist/sync', {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    });
    // Journal Système — des numéros GAGNENT/PERDENT le droit de recevoir des SMS
    // (effet réel côté vizyo-texto). Silencieux quand rien ne change (sync no-op).
    if (result.added > 0 || result.removed > 0) {
      this.systemActivity.record({
        category: 'SMS',
        action: 'allowlist_synced',
        status: 'SUCCESS',
        actor: 'system',
        detail: `+${result.added} / -${result.removed} numéro(s) (${result.unchanged} inchangés)`,
        meta: { added: result.added, removed: result.removed, unchanged: result.unchanged, skipped: result.skipped },
      });
    }
    return result;
  }

  /** Reconciliation : trackers non synces + entrees orphelines. */
  async status(): Promise<AllowlistStatus> {
    const [entries, trackers, users] = await Promise.all([
      this.list(),
      this.prisma.tracker.findMany({
        where: { simPhoneNumber: { not: null } },
        select: { imei: true, simPhoneNumber: true },
      }),
      this.prisma.user.findMany({
        where: { phone: { not: null }, isActive: true },
        select: { phone: true },
      }),
    ]);
    const allowed = new Set(entries.map((e) => e.phone));
    const trackerPhones = new Set(trackers.map((t) => t.simPhoneNumber as string));
    // V1.15 — les User.phone actifs sont aussi des numeros legitimes (notifs SMS
    // d'alerte) synces par syncFromTrackers() : on les considere "connus" pour ne
    // pas les remonter comme orphelins (sinon un admin les supprimerait a tort).
    const knownPhones = new Set<string>([
      ...trackerPhones,
      ...users.map((u) => u.phone as string),
    ]);

    const missing = trackers
      .filter((t) => !allowed.has(t.simPhoneNumber as string))
      .map((t) => ({ imei: t.imei, phone: t.simPhoneNumber as string }));

    const orphans = entries
      .filter((e) => e.source === 'synced' && !knownPhones.has(e.phone))
      .map((e) => ({ phone: e.phone, label: e.label }));

    return { entries, total: entries.length, trackersWithSim: trackers.length, missing, orphans };
  }
}
