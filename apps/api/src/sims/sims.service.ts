import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Prisma, UserRole } from '@prisma/client';
import {
  SIM_STATUS,
  simStatusLabel,
  type AssignableTrackerDto,
  type BulkCreateSimResultDto,
  type SimConsumptionPointDto,
  type SimDto,
  type SimEventDto,
  type SimStatsDto,
} from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { VEHICLE_GROUP_SELECT, vehicleGroupOf } from '../common/vehicle-group';
import type { CreateSimDto } from './dto/create-sim.dto';
import type { UpdateSimDto } from './dto/update-sim.dto';
import { SimsSyncService } from './sims-sync.service';
import { WhereverSimClient } from './whereversim.client';

interface RequestedBy {
  userId: string;
  role: UserRole;
  fleetId: string | null;
}

interface SimFilters {
  q?: string;
  unassigned?: string;
  fleetId?: string;
}

const SIM_INCLUDE = {
  fleet: { select: { id: true, name: true } },
  tracker: { select: { id: true, imei: true, vehicle: { select: { plate: true, ...VEHICLE_GROUP_SELECT } } } },
} satisfies Prisma.SimInclude;

type SimWithRefs = Prisma.SimGetPayload<{ include: typeof SIM_INCLUDE }>;

const ICCID_REGEX = /^\d{18,22}$/;
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

/**
 * V1.16 — Service de gestion du parc SIM (WhereverSIM).
 *
 * Lecture sc0pee par flotte (FLEET_ADMIN bypass permissions, voit sa flotte ;
 * SUPER_ADMIN voit tout). Assignation tracker ouverte au FLEET_ADMIN (+ delegues
 * via permission `sims_assign`). Cycle de vie / sync / allocation = SUPER_ADMIN
 * (gate au controller). Le cache local est la source de la liste ; les actions
 * passent par l'API WhereverSIM puis rafraichissent le cache.
 */
@Injectable()
export class SimsService {
  private readonly logger = new Logger(SimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly client: WhereverSimClient,
    private readonly sync: SimsSyncService,
  ) {}

  // ─── Lecture ──────────────────────────────────────────────────────────────

  async list(rb: RequestedBy, filters: SimFilters = {}): Promise<SimDto[]> {
    const where: Prisma.SimWhereInput = { ...this.scope(rb) };
    if (filters.unassigned === 'true') where.trackerId = null;
    if (filters.fleetId && rb.role === UserRole.SUPER_ADMIN) where.fleetId = filters.fleetId;
    if (filters.q) {
      const q = filters.q.trim();
      where.OR = [
        { iccid: { contains: q, mode: 'insensitive' } },
        { msisdn: { contains: q, mode: 'insensitive' } },
        { imei: { contains: q, mode: 'insensitive' } },
        { label: { contains: q, mode: 'insensitive' } },
      ];
    }
    const sims = await this.prisma.sim.findMany({
      where,
      include: SIM_INCLUDE,
      orderBy: [{ createdAt: 'desc' }],
      take: 1000,
    });
    return sims.map((s) => this.mapSim(s));
  }

  async findOne(id: string, rb: RequestedBy): Promise<SimDto> {
    const sim = await this.prisma.sim.findFirst({
      where: { id, ...this.scope(rb) },
      include: SIM_INCLUDE,
    });
    if (!sim) throw new NotFoundException('Carte SIM introuvable');
    return this.mapSim(sim);
  }

  /** Trackers du scope sans SIM, pour le picker d'assignation. */
  async assignableTrackers(rb: RequestedBy): Promise<AssignableTrackerDto[]> {
    const where: Prisma.TrackerWhereInput = { sim: { is: null } };
    if (rb.role !== UserRole.SUPER_ADMIN) {
      if (!rb.fleetId) return [];
      where.vehicle = { fleetId: rb.fleetId };
    }
    const trackers = await this.prisma.tracker.findMany({
      where,
      select: {
        id: true,
        imei: true,
        vehicle: { select: { plate: true, fleet: { select: { name: true } } } },
      },
      orderBy: { createdAt: 'desc' },
      take: 500,
    });
    return trackers.map((t) => ({
      id: t.id,
      imei: t.imei,
      vehiclePlate: t.vehicle?.plate ?? null,
      fleetName: t.vehicle?.fleet?.name ?? null,
    }));
  }

  // ─── Assignation tracker (FLEET_ADMIN + SUPER_ADMIN) ───────────────────────

  async assign(id: string, trackerId: string, rb: RequestedBy): Promise<SimDto> {
    const sim = await this.loadSim(id, rb);
    if (sim.trackerId) {
      throw new BadRequestException('Cette SIM est déjà posée sur un tracker — détachez-la d\'abord');
    }
    if (sim.statusId === SIM_STATUS.RETIRED || sim.statusId === SIM_STATUS.DELETED) {
      throw new BadRequestException('SIM résiliée/supprimée — réactivez-la avant de la poser');
    }

    const trackerWhere: Prisma.TrackerWhereInput = { id: trackerId };
    if (rb.role !== UserRole.SUPER_ADMIN) {
      if (!rb.fleetId) throw new NotFoundException('Tracker introuvable');
      trackerWhere.vehicle = { fleetId: rb.fleetId };
    }
    const tracker = await this.prisma.tracker.findFirst({
      where: trackerWhere,
      select: {
        id: true,
        imei: true,
        simPhoneNumber: true,
        vehicle: { select: { fleetId: true } },
        sim: { select: { id: true, iccid: true } },
      },
    });
    if (!tracker) throw new NotFoundException('Tracker introuvable');
    if (tracker.sim) {
      throw new BadRequestException(`Ce tracker a déjà une SIM (ICCID ${tracker.sim.iccid})`);
    }

    const trackerFleetId = tracker.vehicle?.fleetId ?? null;
    if (sim.fleetId && trackerFleetId && sim.fleetId !== trackerFleetId) {
      throw new BadRequestException('La SIM et le tracker n\'appartiennent pas à la même flotte');
    }
    // SIM en stock posée sur un tracker de flotte => auto-allocation a cette flotte.
    const newFleetId = sim.fleetId ?? trackerFleetId;
    const simChanged = !!sim.msisdn && tracker.simPhoneNumber !== sim.msisdn;

    await this.prisma.$transaction(async (tx) => {
      await tx.sim.update({ where: { id }, data: { trackerId, fleetId: newFleetId } });
      if (simChanged) {
        await tx.tracker.update({ where: { id: trackerId }, data: { simPhoneNumber: sim.msisdn } });
      }
    });

    // Apres commit : re-sync allowlist vizyo-texto si le n° du tracker a change.
    if (simChanged) {
      this.eventEmitter.emit('tracker.sim-changed', { trackerId, imei: tracker.imei });
    }
    // Best-effort : ecrire l'IMEI du tracker dans custom_field_1 cote WhereverSIM
    // (lien bidirectionnel visible dans leur portail). Non bloquant.
    void this.pushDeviceName(sim.iccid, tracker.imei);

    this.logger.log(`SIM ${sim.iccid} assignée au tracker ${tracker.imei}`);
    return this.findOne(id, rb);
  }

  async unassign(id: string, rb: RequestedBy): Promise<SimDto> {
    const sim = await this.loadSim(id, rb);
    if (!sim.trackerId) return this.findOne(id, rb);

    const tracker = await this.prisma.tracker.findUnique({
      where: { id: sim.trackerId },
      select: { id: true, imei: true, simPhoneNumber: true },
    });
    // On ne vide le n° SMS du tracker que s'il vaut encore le MSISDN de cette SIM
    // (ne pas ecraser un numero saisi manuellement).
    const clearPhone = !!tracker && !!sim.msisdn && tracker.simPhoneNumber === sim.msisdn;

    await this.prisma.$transaction(async (tx) => {
      await tx.sim.update({ where: { id }, data: { trackerId: null } });
      if (clearPhone && tracker) {
        await tx.tracker.update({ where: { id: tracker.id }, data: { simPhoneNumber: null } });
      }
    });

    if (clearPhone && tracker) {
      this.eventEmitter.emit('tracker.sim-changed', { trackerId: tracker.id, imei: tracker.imei });
    }
    void this.pushDeviceName(sim.iccid, ''); // efface le device name cote provider
    this.logger.log(`SIM ${sim.iccid} détachée`);
    return this.findOne(id, rb);
  }

  // ─── Gestion (SUPER_ADMIN — gate au controller) ────────────────────────────

  async create(dto: CreateSimDto): Promise<SimDto> {
    const iccid = dto.iccid.trim();
    if (!ICCID_REGEX.test(iccid)) throw new BadRequestException('ICCID invalide (18 à 22 chiffres)');
    const msisdn = dto.msisdn?.trim() || null;
    if (msisdn && !E164_REGEX.test(msisdn)) {
      throw new BadRequestException('msisdn : format E.164 attendu (ex +33612345678)');
    }
    if (dto.fleetId) await this.assertFleetExists(dto.fleetId);

    try {
      const created = await this.prisma.sim.create({
        data: {
          iccid,
          msisdn,
          label: dto.label?.trim() || null,
          fleetId: dto.fleetId ?? null,
        },
      });
      // Enrichissement best-effort depuis WhereverSIM si la SIM y existe.
      await this.sync.syncOne(iccid).catch(() => undefined);
      return this.findOne(created.id, this.superRb());
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException(`ICCID ${iccid} déjà enregistré`);
      }
      throw err;
    }
  }

  async bulkCreate(raw: string): Promise<BulkCreateSimResultDto> {
    const created: SimDto[] = [];
    const skipped: { iccid: string; reason: string }[] = [];
    const seen = new Set<string>();

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const [rawIccid, rawMsisdn, ...rest] = trimmed.split(/[\s,;\t]+/);
      const iccid = (rawIccid ?? '').trim();
      if (!ICCID_REGEX.test(iccid)) {
        skipped.push({ iccid: iccid || trimmed.slice(0, 24), reason: 'ICCID invalide' });
        continue;
      }
      if (seen.has(iccid)) {
        skipped.push({ iccid, reason: 'Doublon dans la liste' });
        continue;
      }
      seen.add(iccid);
      const msisdn = (rawMsisdn ?? '').trim() || null;
      if (msisdn && !E164_REGEX.test(msisdn)) {
        skipped.push({ iccid, reason: 'MSISDN invalide (E.164)' });
        continue;
      }
      const label = rest.join(' ').trim() || null;
      try {
        const c = await this.prisma.sim.create({ data: { iccid, msisdn, label } });
        created.push(await this.findOne(c.id, this.superRb()));
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          skipped.push({ iccid, reason: 'Déjà enregistrée' });
        } else {
          skipped.push({ iccid, reason: 'Erreur création' });
        }
      }
    }
    return { created, skipped };
  }

  async update(id: string, dto: UpdateSimDto): Promise<SimDto> {
    const sim = await this.prisma.sim.findUnique({ where: { id }, select: { id: true, trackerId: true } });
    if (!sim) throw new NotFoundException('Carte SIM introuvable');

    const data: Prisma.SimUpdateInput = {};
    if (dto.label !== undefined) data.label = dto.label?.trim() || null;
    if (dto.notes !== undefined) data.notes = dto.notes?.trim() || null;
    if (dto.fleetId !== undefined) {
      if (sim.trackerId) {
        throw new BadRequestException('Détachez la SIM du tracker avant de changer sa flotte');
      }
      if (dto.fleetId === null) {
        data.fleet = { disconnect: true };
      } else {
        await this.assertFleetExists(dto.fleetId);
        data.fleet = { connect: { id: dto.fleetId } };
      }
    }
    await this.prisma.sim.update({ where: { id }, data });
    return this.findOne(id, this.superRb());
  }

  async remove(id: string): Promise<void> {
    const sim = await this.prisma.sim.findUnique({ where: { id }, select: { id: true, trackerId: true } });
    if (!sim) throw new NotFoundException('Carte SIM introuvable');
    if (sim.trackerId) {
      throw new BadRequestException('Détachez la SIM de son tracker avant de la supprimer');
    }
    // Supprime uniquement la ligne locale (cache) — la SIM reste chez l'operateur.
    await this.prisma.sim.delete({ where: { id } });
  }

  // ─── Cycle de vie / provider (SUPER_ADMIN) ─────────────────────────────────

  async setStatus(id: string, statusId: number): Promise<SimDto> {
    const sim = await this.loadSimUnique(id);
    const raw = await this.client.updateSim({ iccid: sim.iccid, statusid: statusId });
    await this.sync.upsertRaw(raw);
    return this.findOne(id, this.superRb());
  }

  async setDataLimit(id: string, bytes: number | null): Promise<SimDto> {
    const sim = await this.loadSimUnique(id);
    // 0 = illimite cote WhereverSIM.
    const raw = await this.client.updateSim({ iccid: sim.iccid, monthly_data_limit: bytes ?? 0 });
    await this.sync.upsertRaw(raw);
    return this.findOne(id, this.superRb());
  }

  async sendSms(id: string, text: string): Promise<{ sent: boolean }> {
    const sim = await this.loadSimUnique(id);
    const sent = await this.client.sendSms(sim.iccid, text);
    return { sent };
  }

  async syncAll(): Promise<{ synced: number; total: number }> {
    return this.sync.syncAll();
  }

  async stats(): Promise<SimStatsDto> {
    return this.client.getStatistics();
  }

  async consumption(
    id: string,
    rb: RequestedBy,
    from?: string,
    to?: string,
  ): Promise<SimConsumptionPointDto[]> {
    const sim = await this.loadSim(id, rb);
    const stop = to ?? isoDate(new Date());
    const start = from ?? isoDate(new Date(Date.now() - 30 * 86_400_000));
    const points = await this.client.getDataConsumptionReport(sim.iccid, { start, stop });
    return points.map((p) => ({ day: p.day, bytes: p.bytes }));
  }

  async events(
    id: string,
    rb: RequestedBy,
    nextToken?: string,
  ): Promise<{ items: SimEventDto[]; nextToken: string | null }> {
    const sim = await this.loadSim(id, rb);
    try {
      const res = await this.client.listSimEvents(sim.iccid, { limit: 50, nextToken });
      return {
        items: res.items.map((e) => ({
          timestamp: new Date(e.timestampMilliseconds || 0).toISOString(),
          type: e.type,
          details: e.details,
        })),
        nextToken: res.nextToken,
      };
    } catch (err) {
      // WhereverSIM est un service EXTERNE (parfois indisponible, schéma qui
      // évolue). On dégrade en liste vide plutôt que de propager un 503 qui
      // inonderait le centre d'alerte (cf. erreurs SimEvent). Logué en warn.
      this.logger.warn(
        `SIM events indisponibles (${sim.iccid}) : ${err instanceof Error ? err.message : String(err)}`,
      );
      return { items: [], nextToken: null };
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private scope(rb: RequestedBy): Prisma.SimWhereInput {
    if (rb.role === UserRole.SUPER_ADMIN) return {};
    if (!rb.fleetId) return { id: '__none__' };
    return { fleetId: rb.fleetId };
  }

  private superRb(): RequestedBy {
    return { userId: 'system', role: UserRole.SUPER_ADMIN, fleetId: null };
  }

  /** Charge l'entite SIM en respectant le scope (assign/unassign/consumption/events). */
  private async loadSim(id: string, rb: RequestedBy) {
    const sim = await this.prisma.sim.findFirst({ where: { id, ...this.scope(rb) } });
    if (!sim) throw new NotFoundException('Carte SIM introuvable');
    return sim;
  }

  /** Charge l'entite SIM sans scope (actions SUPER_ADMIN gate au controller). */
  private async loadSimUnique(id: string) {
    const sim = await this.prisma.sim.findUnique({ where: { id } });
    if (!sim) throw new NotFoundException('Carte SIM introuvable');
    return sim;
  }

  private async assertFleetExists(fleetId: string): Promise<void> {
    const fleet = await this.prisma.fleet.findUnique({ where: { id: fleetId }, select: { id: true } });
    if (!fleet) throw new NotFoundException('Flotte introuvable');
  }

  /** Best-effort : pousse le device name (IMEI tracker) dans custom_field_1 WhereverSIM. */
  private async pushDeviceName(iccid: string, deviceName: string): Promise<void> {
    if (!this.client.isConfigured()) return;
    try {
      const raw = await this.client.updateSim({ iccid, custom_field_1: deviceName });
      await this.sync.upsertRaw(raw);
    } catch (err) {
      this.logger.warn(
        `push custom_field_1 vers WhereverSIM echoue (${iccid}) : ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private mapSim(s: SimWithRefs): SimDto {
    return {
      id: s.id,
      iccid: s.iccid,
      msisdn: s.msisdn,
      imsi: s.imsi,
      imei: s.imei,
      provider: s.provider,
      providerId: s.providerId,
      statusId: s.statusId,
      statusLabel: s.statusLabel ?? (s.statusId != null ? simStatusLabel(s.statusId) : null),
      apn: s.apn,
      ipAddress: s.ipAddress,
      networkOperator: s.networkOperator,
      monthlyDataVolumeBytes: bigToNum(s.monthlyDataVolumeBytes),
      monthlyDataLimitBytes: bigToNum(s.monthlyDataLimitBytes),
      prevMonthDataVolumeBytes: bigToNum(s.prevMonthDataVolumeBytes),
      inSessionSince: s.inSessionSince ? s.inSessionSince.toISOString() : null,
      activationAt: s.activationAt ? s.activationAt.toISOString() : null,
      customField1: s.customField1,
      label: s.label,
      notes: s.notes,
      fleet: s.fleet ? { id: s.fleet.id, name: s.fleet.name } : null,
      tracker: s.tracker
        ? {
            id: s.tracker.id,
            imei: s.tracker.imei,
            vehiclePlate: s.tracker.vehicle?.plate ?? null,
            vehicleGroup: vehicleGroupOf(s.tracker.vehicle),
          }
        : null,
      externalSyncedAt: s.externalSyncedAt ? s.externalSyncedAt.toISOString() : null,
      createdAt: s.createdAt.toISOString(),
      updatedAt: s.updatedAt.toISOString(),
    };
  }
}

/** bigint Prisma -> number (octets ; plage safe-integer pour nos volumes). */
function bigToNum(v: bigint | null): number | null {
  return v == null ? null : Number(v);
}

/** Date -> "YYYY-MM-DD". */
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
