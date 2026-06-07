import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { Env } from '../config/env.validation';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';

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
    return this.call<AllowlistSyncResult>('/v1/allowlist/sync', {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    });
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
