import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { AiProviderMode } from './ai-client.types';

/** Modes valides (garde-fou de désérialisation). */
const VALID: readonly AiProviderMode[] = ['claude', 'gpt', 'both'];
const CACHE_TTL_MS = 15_000;

/**
 * Provider IA sélectionné (singleton `ai_provider_settings`). Lu à CHAQUE appel IA via le routeur →
 * cache court (15 s) pour ne pas taper la DB en boucle. Modifiable depuis la page « Coûts IA »
 * (super-admin). Défaut = 'claude' (comportement historique). Ne lève jamais : en cas d'erreur DB,
 * on retombe sur 'claude' (l'IA ne doit pas casser sur un problème de réglage).
 */
@Injectable()
export class AiProviderSettingsService {
  private cache: AiProviderMode | null = null;
  private cachedAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  private coerce(v: string | null | undefined): AiProviderMode {
    return VALID.includes(v as AiProviderMode) ? (v as AiProviderMode) : 'claude';
  }

  /** Provider courant (caché). Jamais d'exception : repli 'claude'. */
  async current(now = Date.now()): Promise<AiProviderMode> {
    if (this.cache && now - this.cachedAt < CACHE_TTL_MS) return this.cache;
    try {
      const row = await this.prisma.aiProviderSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
      this.cache = this.coerce(row?.provider);
    } catch {
      this.cache = this.cache ?? 'claude';
    }
    this.cachedAt = now;
    return this.cache;
  }

  /** Réglage exposé à l'UI (provider + qui/quand). */
  async view(): Promise<{ provider: AiProviderMode; updatedAt: string | null }> {
    const row = await this.prisma.aiProviderSettings.findFirst({ orderBy: { updatedAt: 'desc' } });
    return { provider: this.coerce(row?.provider), updatedAt: row?.updatedAt?.toISOString() ?? null };
  }

  /** Change le provider global (upsert singleton) + invalide le cache. */
  async set(provider: AiProviderMode, userId?: string): Promise<{ provider: AiProviderMode; updatedAt: string | null }> {
    const value = this.coerce(provider);
    const existing = await this.prisma.aiProviderSettings.findFirst();
    if (existing) {
      await this.prisma.aiProviderSettings.update({ where: { id: existing.id }, data: { provider: value, updatedByUserId: userId ?? null } });
    } else {
      await this.prisma.aiProviderSettings.create({ data: { provider: value, updatedByUserId: userId ?? null } });
    }
    this.cache = value;
    this.cachedAt = Date.now();
    return this.view();
  }
}
