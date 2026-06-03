import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OnEvent } from '@nestjs/event-emitter';
import type { Env } from '../config/env.validation';
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
      res = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`vizyo-texto injoignable (${path}): ${msg}`);
      throw new ServiceUnavailableException(`vizyo-texto injoignable : ${msg}`);
    }
    const data = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) {
      throw new ServiceUnavailableException(data.message ?? `vizyo-texto HTTP ${res.status}`);
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

  /** Pousse tous les simPhoneNumber des trackers vers l'allowlist (source='synced'). */
  async syncFromTrackers(): Promise<AllowlistSyncResult> {
    const trackers = await this.prisma.tracker.findMany({
      where: { simPhoneNumber: { not: null } },
      select: { imei: true, simPhoneNumber: true },
    });
    const entries = trackers.map((t) => ({
      phone: t.simPhoneNumber as string,
      label: `Tracker ${t.imei}`,
    }));
    return this.call<AllowlistSyncResult>('/v1/allowlist/sync', {
      method: 'PUT',
      body: JSON.stringify({ entries }),
    });
  }

  /** Reconciliation : trackers non synces + entrees orphelines. */
  async status(): Promise<AllowlistStatus> {
    const [entries, trackers] = await Promise.all([
      this.list(),
      this.prisma.tracker.findMany({
        where: { simPhoneNumber: { not: null } },
        select: { imei: true, simPhoneNumber: true },
      }),
    ]);
    const allowed = new Set(entries.map((e) => e.phone));
    const trackerPhones = new Set(trackers.map((t) => t.simPhoneNumber as string));

    const missing = trackers
      .filter((t) => !allowed.has(t.simPhoneNumber as string))
      .map((t) => ({ imei: t.imei, phone: t.simPhoneNumber as string }));

    const orphans = entries
      .filter((e) => e.source === 'synced' && !trackerPhones.has(e.phone))
      .map((e) => ({ phone: e.phone, label: e.label }));

    return { entries, total: entries.length, trackersWithSim: trackers.length, missing, orphans };
  }
}
