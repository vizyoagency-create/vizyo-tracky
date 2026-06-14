import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { simStatusLabel } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { WhereverSimClient, type RawSim } from './whereversim.client';

/**
 * V1.16 — Synchronisation du parc SIM depuis WhereverSIM vers le cache local.
 *
 * Le cache local (`sims`) est rafraichi :
 *  - par cron toutes les 30 min (`handleCron`),
 *  - a la demande (`syncAll` via POST /sims/sync — SUPER_ADMIN),
 *  - apres chaque mutation (les flux lifecycle appellent `upsertRaw` avec la SIM
 *    renvoyee par updateSim, ou `syncOne(iccid)`).
 *
 * L'upsert n'ecrit QUE les champs miroir : `fleetId`/`trackerId`/`label`/`notes`
 * (couche Tracky) ne sont jamais touches. Best-effort : si WhereverSIM est
 * indisponible, on log et on abandonne (un prochain cron reconciliera).
 */
@Injectable()
export class SimsSyncService {
  private readonly logger = new Logger(SimsSyncService.name);
  private syncing = false;
  private syncPending = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly client: WhereverSimClient,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async handleCron(): Promise<void> {
    if (!this.client.isConfigured()) return;
    try {
      await this.syncAll();
    } catch (err) {
      this.logger.warn(`sync cron echoue : ${err instanceof Error ? err.message : err}`);
    }
  }

  /**
   * Tire tout le parc (listSims pagine) et upsert localement. Coalesce les
   * rafales (si un sync tourne deja, re-run a la fin). Renvoie le nb de SIM vues.
   */
  async syncAll(): Promise<{ synced: number; total: number }> {
    if (this.syncing) {
      this.syncPending = true;
      return { synced: 0, total: 0 };
    }
    this.syncing = true;
    let synced = 0;
    let total = 0;
    try {
      do {
        this.syncPending = false;
        let nextToken: string | null | undefined = undefined;
        synced = 0;
        do {
          const page = await this.client.listSims({ limit: 100, nextToken });
          total = page.totalSims;
          for (const raw of page.items) {
            await this.upsertRaw(raw);
            synced++;
          }
          nextToken = page.nextToken;
        } while (nextToken);
      } while (this.syncPending);
    } finally {
      this.syncing = false;
    }
    this.logger.log(`sync WhereverSIM : ${synced} SIM upsertees (total parc ${total})`);
    return { synced, total };
  }

  /** Rafraichit une seule SIM via quickSearch (apres une action ou a la demande). */
  async syncOne(iccid: string): Promise<void> {
    if (!this.client.isConfigured()) return;
    const page = await this.client.listSims({ limit: 1, quickSearch: iccid });
    const raw = page.items.find((s) => s.iccid === iccid) ?? page.items[0];
    if (raw && raw.iccid === iccid) {
      await this.upsertRaw(raw);
    }
  }

  /** Upsert d'une SIM brute : n'ecrit que les champs miroir. */
  async upsertRaw(raw: RawSim | null | undefined): Promise<void> {
    // #18 — un updateSim WhereverSIM peut renvoyer null (echec silencieux cote
    // fournisseur) : sans garde, buildMirror(null) dereferencait null (crash 500).
    // On ignore proprement une SIM brute absente / sans iccid.
    if (!raw || !raw.iccid) return;
    const mirror = this.buildMirror(raw);
    await this.prisma.sim.upsert({
      where: { iccid: raw.iccid },
      update: mirror,
      create: { iccid: raw.iccid, ...mirror },
    });
  }

  /** Champs miroir (hors iccid + hors couche Tracky), pour update ET create. */
  private buildMirror(raw: RawSim) {
    return {
      msisdn: raw.msisdn ?? null,
      imsi: raw.imsi ?? null,
      imei: raw.imei ?? null,
      provider: 'wherever-sim',
      providerId: raw.providerid ?? null,
      statusId: raw.statusid ?? null,
      statusLabel: raw.statusid != null ? simStatusLabel(raw.statusid) : null,
      apn: raw.apn ?? null,
      ipAddress: raw.ip_address ?? null,
      monthlyDataVolumeBytes: toBig(raw.monthly_data_volume),
      monthlyDataLimitBytes: toBig(raw.monthly_data_limit),
      prevMonthDataVolumeBytes: toBig(raw.previous_month_data_volume),
      inSessionSince: msToDate(raw.in_session_since),
      activationAt: msToDate(raw.activation_timestamp),
      customField1: raw.custom_field_1 ?? null,
      externalSyncedAt: new Date(),
      rawProvider: raw as unknown as Prisma.InputJsonValue,
    } satisfies Prisma.SimUncheckedUpdateInput;
  }
}

/** Octets (number WhereverSIM) -> bigint Prisma. */
function toBig(n: number | null | undefined): bigint | null {
  return n == null ? null : BigInt(Math.trunc(n));
}

/** Millisecondes epoch (WhereverSIM) -> Date. 0/absent -> null. */
function msToDate(ms: number | null | undefined): Date | null {
  return ms ? new Date(ms) : null;
}
