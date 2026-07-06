import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Refonte agenda/IA (2026-07, P3) — Géocodage inverse (Nominatim/OSM) pour NOMMER un point
 * d'arrivée récurrent (ex. « Carcassonne »). Best-effort et NON bloquant : un échec/timeout rend
 * `null` (la destination reste non nommée, jamais d'exception propagée).
 *
 * - Cache en base (`geocode_cache`, clé = coords arrondies ~110 m) : un point déjà vu ne re-tape
 *   jamais l'API. On mémorise MÊME un résultat vide pour ne pas boucler sur les zones sans nom.
 * - Respect du quota Nominatim (ToS : ≤ 1 req/s) via un throttle interne + `User-Agent` explicite.
 * - URL surchargeable par `NOMINATIM_URL` (permet un self-host ; défaut = instance publique OSM).
 */
@Injectable()
export class ReverseGeocodeService {
  private readonly logger = new Logger(ReverseGeocodeService.name);
  /** Horodatage du dernier appel réseau (throttle Nominatim). */
  private lastCallAt = 0;

  constructor(private readonly prisma: PrismaService) {}

  /** Clé de cache : coords arrondies à 3 décimales (~110 m) pour mutualiser les points proches. */
  private key(lat: number, lng: number): string {
    return `${lat.toFixed(3)},${lng.toFixed(3)}`;
  }

  /**
   * Libellé court (ville / village) du point, ou `null` si inconnu/indisponible.
   * Cache DB d'abord, sinon Nominatim (best-effort, rate-limité), puis mémorisation.
   */
  async label(lat: number, lng: number): Promise<string | null> {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const key = this.key(lat, lng);

    const cached = await this.prisma.geocodeCache.findUnique({ where: { key } });
    if (cached) return cached.label || null;

    const label = await this.fetchLabel(lat, lng);
    try {
      // On cache aussi le vide (label='') → une zone sans nom ne re-tape pas l'API à chaque run.
      await this.prisma.geocodeCache.create({ data: { key, label: label ?? '', lat, lng } });
    } catch {
      // Course concurrente (même clé insérée par une autre analyse) : sans gravité.
    }
    return label;
  }

  /** Appel Nominatim reverse (jsonv2), parse le nom de commune le plus pertinent. */
  private async fetchLabel(lat: number, lng: number): Promise<string | null> {
    await this.throttle();
    const base = (process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
    const url = `${base}/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=12&addressdetails=1`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          // Nominatim ToS : un User-Agent identifiable est OBLIGATOIRE.
          'User-Agent': 'Tracky/1.0 (contact@vizyoagency.com)',
          'Accept-Language': 'fr',
        },
      });
      if (!res.ok) return null;
      const json = (await res.json()) as { address?: Record<string, string>; name?: string };
      const a = json.address ?? {};
      const label = a.city || a.town || a.village || a.municipality || a.county || json.name || null;
      return label ? label.trim() : null;
    } catch (e) {
      this.logger.warn(`Nominatim échec (${lat},${lng}) : ${(e as Error)?.message ?? e}`);
      return null;
    } finally {
      // Toujours libérer le timer d'abort (y compris si fetch rejette) — sinon handle qui fuit.
      clearTimeout(timer);
    }
  }

  /** Sérialise les appels réseau à ≤ 1/s (quota Nominatim). Sans effet si le dernier appel est ancien. */
  private async throttle(): Promise<void> {
    const MIN_INTERVAL_MS = 1100;
    const wait = this.lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCallAt = Date.now();
  }
}
