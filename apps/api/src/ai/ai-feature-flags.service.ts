import { Injectable } from '@nestjs/common';
import type { AiFeatureFlagsDto, AiFeatureKey } from '@vizyo/tracky-shared';
import { AI_FEATURE_KEYS } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';

/** Liste PARTAGÉE (shared) : une copie locale aurait fini par diverger de `AiStatusDto.features`. */
const KEYS: readonly AiFeatureKey[] = AI_FEATURE_KEYS;

/**
 * Interrupteurs GLOBAUX par fonctionnalité IA (kill-switch plateforme, super-admin/owner). Se cumule
 * AU-DESSUS de l'interrupteur maître par société (`Fleet.aiEnabled`) et des permissions : une fonction
 * n'est dispo que si son flag global est ON. Défaut TOUT ON — **fail-OPEN** (un flag DB cassé ne coupe
 * PAS l'IA déjà payée ; couper est une action explicite de l'owner). Cache 15 s (comme l'availability).
 */
@Injectable()
export class AiFeatureFlagsService {
  private cache: { flags: AiFeatureFlagsDto; at: number } | null = null;
  private static readonly TTL_MS = 15_000;

  constructor(private readonly prisma: PrismaService) {}

  async getFlags(now = Date.now()): Promise<AiFeatureFlagsDto> {
    if (this.cache && now - this.cache.at < AiFeatureFlagsService.TTL_MS) return this.cache.flags;
    let flags = this.allOn();
    try {
      const row = await this.prisma.aiFeatureFlags.findFirst();
      if (row) {
        flags = {
          tripAnalysis: row.tripAnalysis,
          agendaAgent: row.agendaAgent,
          capacity: row.capacity,
          placement: row.placement,
          bookingParse: row.bookingParse,
          activityReport: row.activityReport,
          placeAnalysis: row.placeAnalysis,
        };
      }
    } catch {
      flags = this.cache?.flags ?? this.allOn(); // erreur DB : dernière valeur connue, sinon TOUT ON
    }
    this.cache = { flags, at: now };
    return flags;
  }

  /** Une fonctionnalité IA est-elle globalement autorisée ? Fail-OPEN (défaut true). */
  async isEnabled(feature: AiFeatureKey, now = Date.now()): Promise<boolean> {
    return (await this.getFlags(now))[feature] ?? true;
  }

  /** Coupe/active une fonctionnalité POUR TOUT LE MONDE + invalide le cache (super-admin). */
  async setFlag(feature: AiFeatureKey, enabled: boolean, userId?: string): Promise<AiFeatureFlagsDto> {
    const existing = await this.prisma.aiFeatureFlags.findFirst();
    if (existing) {
      await this.prisma.aiFeatureFlags.update({ where: { id: existing.id }, data: { [feature]: enabled, updatedByUserId: userId ?? null } });
    } else {
      await this.prisma.aiFeatureFlags.create({ data: { [feature]: enabled, updatedByUserId: userId ?? null } });
    }
    this.cache = null;
    return this.getFlags();
  }

  private allOn(): AiFeatureFlagsDto {
    return Object.fromEntries(KEYS.map((k) => [k, true])) as AiFeatureFlagsDto;
  }
}
