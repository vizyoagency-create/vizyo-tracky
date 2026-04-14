import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface FleetSummary {
  id: string;
  name: string;
}

@Injectable()
export class FleetsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(role: UserRole, fleetId: string | null): Promise<FleetSummary[]> {
    if (role === UserRole.SUPER_ADMIN) {
      return this.prisma.fleet.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      });
    }

    if (!fleetId) return [];

    return this.prisma.fleet.findMany({
      where: { id: fleetId },
      select: { id: true, name: true },
    });
  }
}
