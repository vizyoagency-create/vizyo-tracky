import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type {
  AgendaAgentAutonomy,
  AgendaAgentFrequency,
  AgendaAgentSettingsDto,
  FleetMetier,
  SetAgendaAgentSettingsDto,
} from '@vizyo/tracky-shared';
import type { AuthUser } from '../auth/types/auth-user';
import { AiUsageService } from '../ai-usage/ai-usage.service';
import { PrismaService } from '../prisma/prisma.service';

const FREQUENCIES: AgendaAgentFrequency[] = ['daily', 'weekly'];
const AUTONOMIES: AgendaAgentAutonomy[] = ['suggest', 'auto_high_confidence'];

type SettingsRow = {
  enabled: boolean;
  nightlyHour: number;
  frequency: string;
  autonomy: string;
  confidenceThreshold: number;
  autoCompleteAfterReservation: boolean;
  triggerNightly: boolean;
  triggerIncident: boolean;
  triggerMaintenance: boolean;
  triggerReservation: boolean;
  lastRunAt: Date | null;
};
type EditableFields = Partial<Omit<SettingsRow, 'lastRunAt'>>;

/**
 * Refonte agenda/IA (2026-07) — Réglages de l'agent d'optimisation d'agenda, PAR FLOTTE.
 * Une ligne par flotte (opt-in), lue/écrite depuis la ⚙️ « Paramètres de l'agenda ».
 * L'agent nocturne (P3) consommera ces réglages. Scoping tenant STRICT : un super-admin doit
 * préciser la flotte ; un non-SA ne peut viser que la sienne. Métier lu de la flotte (édité via
 * l'endpoint dédié `/ai/fleet-metier`) ; coût IA du mois lu via `AiUsageService`.
 */
@Injectable()
export class AgendaAgentSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly aiUsage: AiUsageService,
  ) {}

  /** Résout la flotte cible (propre flotte ou, super-admin, celle passée) + garde de périmètre. */
  private resolveFleetId(user: AuthUser, fleetId?: string): string {
    const id = fleetId ?? user.fleetId ?? undefined;
    if (!id) throw new BadRequestException('Préciser la flotte (fleetId).');
    if (user.role !== UserRole.SUPER_ADMIN && id !== user.fleetId) {
      throw new ForbiddenException('Flotte hors périmètre.');
    }
    return id;
  }

  async get(user: AuthUser, fleetId?: string): Promise<AgendaAgentSettingsDto> {
    const id = this.resolveFleetId(user, fleetId);
    const fleet = await this.prisma.fleet.findUnique({
      where: { id },
      select: { id: true, name: true, metier: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');
    const row = await this.prisma.agendaAgentSettings.findUnique({ where: { fleetId: id } });
    const monthCostEur = await this.aiUsage.monthCostEur(id, user);
    return this.toDto(fleet, row, monthCostEur);
  }

  async set(user: AuthUser, dto: SetAgendaAgentSettingsDto): Promise<AgendaAgentSettingsDto> {
    const id = this.resolveFleetId(user, dto?.fleetId);
    const fleet = await this.prisma.fleet.findUnique({
      where: { id },
      select: { id: true, name: true, metier: true },
    });
    if (!fleet) throw new NotFoundException('Flotte introuvable.');

    const data = this.sanitize(dto);
    const row = await this.prisma.agendaAgentSettings.upsert({
      where: { fleetId: id },
      create: { fleetId: id, updatedByUserId: user.id, ...data },
      update: { updatedByUserId: user.id, ...data },
    });
    const monthCostEur = await this.aiUsage.monthCostEur(id, user);
    return this.toDto(fleet, row, monthCostEur);
  }

  /** Valide + borne les champs éditables (mise à jour partielle). */
  private sanitize(dto: SetAgendaAgentSettingsDto): EditableFields {
    const out: EditableFields = {};
    if (dto.enabled !== undefined) out.enabled = !!dto.enabled;
    if (dto.nightlyHour !== undefined) {
      const h = Math.trunc(Number(dto.nightlyHour));
      if (!Number.isFinite(h) || h < 0 || h > 23) throw new BadRequestException('Heure invalide (0-23).');
      out.nightlyHour = h;
    }
    if (dto.frequency !== undefined) {
      if (!FREQUENCIES.includes(dto.frequency)) throw new BadRequestException('Fréquence invalide.');
      out.frequency = dto.frequency;
    }
    if (dto.autonomy !== undefined) {
      if (!AUTONOMIES.includes(dto.autonomy)) throw new BadRequestException('Autonomie invalide.');
      out.autonomy = dto.autonomy;
    }
    if (dto.confidenceThreshold !== undefined) {
      const c = Math.trunc(Number(dto.confidenceThreshold));
      if (!Number.isFinite(c) || c < 0 || c > 100) throw new BadRequestException('Seuil invalide (0-100).');
      out.confidenceThreshold = c;
    }
    if (dto.autoCompleteAfterReservation !== undefined) out.autoCompleteAfterReservation = !!dto.autoCompleteAfterReservation;
    if (dto.triggerNightly !== undefined) out.triggerNightly = !!dto.triggerNightly;
    if (dto.triggerIncident !== undefined) out.triggerIncident = !!dto.triggerIncident;
    if (dto.triggerMaintenance !== undefined) out.triggerMaintenance = !!dto.triggerMaintenance;
    if (dto.triggerReservation !== undefined) out.triggerReservation = !!dto.triggerReservation;
    return out;
  }

  /** Mappe la ligne (ou les défauts si absente) vers le DTO exposé. */
  private toDto(
    fleet: { id: string; name: string | null; metier: string },
    row: SettingsRow | null,
    monthCostEur: number,
  ): AgendaAgentSettingsDto {
    return {
      fleetId: fleet.id,
      fleetName: fleet.name,
      enabled: row?.enabled ?? false,
      nightlyHour: row?.nightlyHour ?? 2,
      frequency: (row?.frequency as AgendaAgentFrequency) ?? 'daily',
      autonomy: (row?.autonomy as AgendaAgentAutonomy) ?? 'suggest',
      confidenceThreshold: row?.confidenceThreshold ?? 80,
      autoCompleteAfterReservation: row?.autoCompleteAfterReservation ?? false,
      triggerNightly: row?.triggerNightly ?? true,
      triggerIncident: row?.triggerIncident ?? true,
      triggerMaintenance: row?.triggerMaintenance ?? true,
      triggerReservation: row?.triggerReservation ?? false,
      metier: fleet.metier as FleetMetier,
      lastRunAt: row?.lastRunAt ? row.lastRunAt.toISOString() : null,
      monthCostEur: Math.round(monthCostEur * 10000) / 10000,
    };
  }
}
