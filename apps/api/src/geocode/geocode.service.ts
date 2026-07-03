import { Injectable, Logger } from '@nestjs/common';

interface NominatimReverse {
  display_name?: string;
  address?: Record<string, string>;
}

/**
 * Géocodage inverse (lat/lng → adresse courte) pour la colonne « Dernière
 * position » de la liste des véhicules.
 *
 * Contraintes Nominatim (OSM) respectées :
 *   - **1 requête/seconde max** : file d'attente + throttle global (une seule
 *     IP serveur, donc throttle partagé pour tout le monde).
 *   - **User-Agent identifiable** (obligatoire, sinon 403).
 *   - **Cache** agressif par coordonnées arrondies (~110 m, 3 décimales) : un
 *     véhicule garé ou repassant au même endroit ne re-géocode pas. TTL 30 j.
 *
 * En prod multi-flottes à grande échelle, remplacer le provider par un
 * géocodeur dédié / cache partagé (Redis) — l'interface `reverse()` ne change pas.
 */
@Injectable()
export class GeocodeService {
  private readonly logger = new Logger(GeocodeService.name);
  private readonly cache = new Map<string, { address: string; at: number }>();
  private readonly queue: Array<{ key: string; lat: number; lng: number; resolve: (a: string) => void }> = [];
  private running = false;
  private lastCall = 0;

  private static readonly TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 jours
  private static readonly MAX_ENTRIES = 5000;
  private static readonly MIN_INTERVAL_MS = 1100; // ~1 req/s (marge sur la policy Nominatim)

  private key(lat: number, lng: number): string {
    return `${lat.toFixed(3)},${lng.toFixed(3)}`;
  }

  async reverse(lat: number, lng: number): Promise<string> {
    const key = this.key(lat, lng);
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < GeocodeService.TTL_MS) return hit.address;
    return new Promise<string>((resolve) => {
      this.queue.push({ key, lat, lng, resolve });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue.shift();
        if (!job) break;
        const hit = this.cache.get(job.key);
        if (hit && Date.now() - hit.at < GeocodeService.TTL_MS) {
          job.resolve(hit.address);
          continue;
        }
        const wait = Math.max(0, GeocodeService.MIN_INTERVAL_MS - (Date.now() - this.lastCall));
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.lastCall = Date.now();

        let address = '';
        try {
          const url =
            `https://nominatim.openstreetmap.org/reverse?format=jsonv2` +
            `&lat=${job.lat}&lon=${job.lng}&zoom=16&addressdetails=1&accept-language=fr`;
          const res = await fetch(url, {
            headers: {
              'User-Agent': 'VizyoTracky/1.0 (gestion de flotte; contact@vizyoagency.com)',
              Accept: 'application/json',
            },
          });
          if (res.ok) {
            address = this.shortAddress((await res.json()) as NominatimReverse);
          }
        } catch (err) {
          this.logger.warn(`Reverse geocode échoué (${job.key}): ${(err as Error).message}`);
        }

        this.cache.set(job.key, { address, at: Date.now() });
        if (this.cache.size > GeocodeService.MAX_ENTRIES) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        job.resolve(address);
      }
    } finally {
      this.running = false;
    }
  }

  private shortAddress(j: NominatimReverse): string {
    const a = j.address ?? {};
    const city = a['city'] || a['town'] || a['village'] || a['municipality'] || a['county'] || '';
    const road = a['road'] || a['pedestrian'] || a['neighbourhood'] || a['suburb'] || '';
    if (city && road) return `${city}, ${road}`;
    if (city) return city;
    if (j.display_name) return j.display_name.split(',').slice(0, 2).join(',').trim();
    return '';
  }
}
