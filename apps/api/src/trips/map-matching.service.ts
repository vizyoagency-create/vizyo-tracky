import { Injectable, Logger } from '@nestjs/common';

/**
 * Sprint G.3 V1.4 — service de map-matching OSRM.
 *
 * Snap une polyligne GPS aux routes les plus proches via le service OSRM
 * `/match/v1/driving/{coords}`. Retourne une nouvelle polyligne fidele au
 * reseau routier reel (vs ligne droite entre points GPS).
 *
 * Provider par defaut : `https://router.project-osrm.org` (demo gratuit, rate
 * limite mais OK pour V1.4 sans hosting). Configurable via OSRM_BASE_URL si
 * un OSRM self-host est en place.
 *
 * Limite OSRM /match : 100 coordonnees max par requete. On chunk au-dela.
 */
@Injectable()
export class MapMatchingService {
  private readonly logger = new Logger(MapMatchingService.name);
  private readonly baseUrl = process.env.OSRM_BASE_URL ?? 'https://router.project-osrm.org';

  /**
   * Snap une polyligne aux routes. Retourne null si OSRM est indisponible
   * ou si moins de 2 points sont fournis.
   */
  async match(points: Array<{ lat: number; lng: number }>): Promise<Array<{ lat: number; lng: number }> | null> {
    if (points.length < 2) return null;

    // Chunk a 100 points (limite OSRM /match).
    const chunks: Array<typeof points> = [];
    for (let i = 0; i < points.length; i += 100) {
      chunks.push(points.slice(i, Math.min(i + 100, points.length)));
    }

    const matched: Array<{ lat: number; lng: number }> = [];
    for (const chunk of chunks) {
      const segment = await this.matchChunk(chunk);
      if (!segment) {
        this.logger.warn(`OSRM match echoue sur ${chunk.length} points, fallback raw`);
        return null;
      }
      // Eviter de dupliquer le dernier point d'un chunk avec le premier du suivant.
      if (matched.length > 0) segment.shift();
      matched.push(...segment);
    }
    return matched;
  }

  private async matchChunk(points: Array<{ lat: number; lng: number }>): Promise<Array<{ lat: number; lng: number }> | null> {
    const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const url = `${this.baseUrl}/match/v1/driving/${coords}?geometries=geojson&overview=full&radiuses=${points.map(() => 25).join(';')}`;

    try {
      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 15_000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(timeout);
      if (!res.ok) {
        this.logger.warn(`OSRM /match HTTP ${res.status}`);
        return null;
      }
      const data = await res.json() as {
        code: string;
        matchings?: Array<{ geometry: { type: 'LineString'; coordinates: Array<[number, number]> } }>;
      };
      if (data.code !== 'Ok' || !data.matchings || data.matchings.length === 0) return null;

      // OSRM peut retourner plusieurs matchings (segments deconnectes). On les concatene.
      const merged: Array<{ lat: number; lng: number }> = [];
      for (const m of data.matchings) {
        for (const [lng, lat] of m.geometry.coordinates) {
          merged.push({ lat, lng });
        }
      }
      return merged;
    } catch (err) {
      this.logger.warn(`OSRM /match erreur reseau : ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }
}
