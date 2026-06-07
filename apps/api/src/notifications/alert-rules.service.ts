import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AlertRule } from '@prisma/client';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * V1.5 (Sprint M) — CRUD des regles d'alerte personnalisables.
 *
 * Une regle = (fleet, [vehicule], type d'alerte, channels[]). Plusieurs regles
 * peuvent matcher un meme event (ex: une catch-all '*' + une override pour OVERSPEED).
 * Le service de dispatch fusionne les channels (union).
 */

const VALID_CHANNELS = ['IN_APP', 'WEB_PUSH', 'EMAIL', 'WHATSAPP', 'SMS'] as const;

interface UpsertParams {
  id?: string;
  fleetId?: string;
  vehicleId?: string | null;
  alertType: string;
  enabled?: boolean;
  channels: string[];
  escalateAfterMin?: number | null;
  escalateToUserId?: string | null;
}

@Injectable()
export class AlertRulesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(requestedBy: { role: UserRole | string; fleetId: string | null }): Promise<AlertRule[]> {
    const where = requestedBy.role === UserRole.SUPER_ADMIN
      ? {}
      : { fleetId: requestedBy.fleetId ?? '' };
    return this.prisma.alertRule.findMany({ where, orderBy: { createdAt: 'desc' } });
  }

  async upsert(
    params: UpsertParams,
    requestedBy: { id: string; role: UserRole | string; fleetId: string | null },
  ): Promise<AlertRule> {
    if (!params.alertType) throw new BadRequestException('alertType requis');
    for (const c of params.channels) {
      if (!VALID_CHANNELS.includes(c as typeof VALID_CHANNELS[number])) {
        throw new BadRequestException(`Channel invalide : ${c}`);
      }
    }

    const fleetId = requestedBy.role === UserRole.SUPER_ADMIN
      ? (params.fleetId ?? requestedBy.fleetId ?? '')
      : (requestedBy.fleetId ?? '');
    if (!fleetId) throw new BadRequestException('fleetId requis');

    if (params.vehicleId) {
      const v = await this.prisma.vehicle.findUnique({ where: { id: params.vehicleId } });
      if (!v) throw new NotFoundException('Vehicule introuvable');
      if (v.fleetId !== fleetId) {
        throw new ForbiddenException('Le vehicule n\'appartient pas a la flotte');
      }
    }
    if (params.escalateToUserId) {
      const u = await this.prisma.user.findUnique({ where: { id: params.escalateToUserId } });
      if (!u) throw new NotFoundException('Utilisateur d\'escalade introuvable');
      if (requestedBy.role !== UserRole.SUPER_ADMIN && u.fleetId !== fleetId) {
        throw new ForbiddenException('Utilisateur d\'escalade hors flotte');
      }
    }

    const data: Prisma.AlertRuleUncheckedCreateInput = {
      fleetId,
      vehicleId: params.vehicleId ?? null,
      alertType: params.alertType,
      enabled: params.enabled ?? true,
      channels: params.channels as unknown as Prisma.InputJsonValue,
      escalateAfterMin: params.escalateAfterMin ?? null,
      escalateToUserId: params.escalateToUserId ?? null,
    };

    if (params.id) {
      // Filtre tenant integre au where pour empecher l'enumeration cross-fleet.
      const where: Prisma.AlertRuleWhereInput = { id: params.id };
      if (requestedBy.role !== UserRole.SUPER_ADMIN) {
        if (!requestedBy.fleetId) throw new NotFoundException('Regle introuvable');
        where.fleetId = requestedBy.fleetId;
      }
      const existing = await this.prisma.alertRule.findFirst({ where });
      if (!existing) throw new NotFoundException('Regle introuvable');
      return this.prisma.alertRule.update({ where: { id: params.id }, data });
    }
    return this.prisma.alertRule.create({ data });
  }

  async delete(id: string, requestedBy: { role: UserRole | string; fleetId: string | null }): Promise<void> {
    const where: Prisma.AlertRuleWhereInput = { id };
    if (requestedBy.role !== UserRole.SUPER_ADMIN) {
      if (!requestedBy.fleetId) throw new NotFoundException('Regle introuvable');
      where.fleetId = requestedBy.fleetId;
    }
    const existing = await this.prisma.alertRule.findFirst({ where });
    if (!existing) throw new NotFoundException('Regle introuvable');
    await this.prisma.alertRule.delete({ where: { id } });
  }
}
