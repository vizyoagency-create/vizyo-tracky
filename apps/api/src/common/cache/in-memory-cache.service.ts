import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';

/**
 * V1.10 (Sprint 2 perf) — Cache in-memory simple pour les KPIs dashboard.
 *
 * Pourquoi pas Redis tout de suite : ioredis est dans package.json mais pas
 * encore cable dans Nest. On commence par un cache process-local, suffisant
 * pour 1 instance API. Quand on passera en multi-instance, on remplacera
 * ce service par un adaptateur Redis sans toucher aux callers (meme interface).
 *
 * Pourquoi pas @nestjs/cache-manager : ajoute une dependance + une couche
 * d'abstraction inutile pour notre cas (3-4 entrees max, TTL court). Le code
 * ci-dessous tient en 40 lignes et fait exactement ce dont on a besoin.
 *
 * Pattern de cache : "stale-while-revalidate" leger via `wrap()`. Si la cle
 * est expiree, on bloque sur le compute (pas de SWR pour rester simple). Un
 * upgrade Redis + SWR sera trivial quand on aura besoin de cache partage.
 */
interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

@Injectable()
export class InMemoryCacheService implements OnModuleDestroy {
  private readonly logger = new Logger(InMemoryCacheService.name);
  private readonly store = new Map<string, CacheEntry<unknown>>();
  // Cleanup periodique pour eviter que le Map grossisse indefiniment si on
  // genere des cles avec composantes variables (ex: fleetId, scope).
  private readonly cleanupInterval: NodeJS.Timeout;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupInterval);
  }

  get<T>(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    this.store.set(key, { value, expiresAt: Date.now() + ttlMs });
  }

  /**
   * Wrap pattern : lit le cache, sinon execute la fn et stocke le resultat.
   * Si la fn throw, on ne stocke rien (le caller verra l'erreur).
   */
  async wrap<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) return cached;
    const value = await fn();
    this.set(key, value, ttlMs);
    return value;
  }

  invalidate(key: string): void {
    this.store.delete(key);
  }

  /**
   * Invalide toutes les cles qui commencent par un prefix. Utile quand un
   * write touche une famille d'entrees (ex: invalider 'snapshot:*' apres
   * une commande CUT).
   */
  invalidatePrefix(prefix: string): void {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) this.store.delete(key);
    }
  }

  /**
   * Stats pour Observabilite (a brancher plus tard sur /admin/observability).
   */
  stats(): { size: number; keys: string[] } {
    return { size: this.store.size, keys: Array.from(this.store.keys()) };
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
        removed++;
      }
    }
    if (removed > 0) {
      this.logger.debug(`Cleanup: ${removed} expired entries removed (${this.store.size} remaining)`);
    }
  }
}
