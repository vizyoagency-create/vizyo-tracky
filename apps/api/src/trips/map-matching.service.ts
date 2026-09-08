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
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CE QUE LE SERVICE PUBLIC ACCEPTE VRAIMENT — mesuré le 2026-09-08           │
 * │                                                                            │
 * │ Sur un vrai trajet de production (29 points, GA-490-SJ) : dix coordonnées  │
 * │ passent, onze sont refusées (HTTP 400, corps vide) ; un rayon de 40 m      │
 * │ passe, 50 m est refusé. Ce fichier envoyait des lots de CENT, en croyant   │
 * │ à la limite documentée d'OSRM. Résultat en base, sur huit jours : 100 % de │
 * │ trajets recalés sous dix points, 39 % entre 10 et 29, 0 % au-delà de 30.   │
 * │ Autrement dit, tout trajet qui vaut la peine d'être rejoué coupait les     │
 * │ virages — et le rejeu coloré par la vitesse l'a rendu visible.             │
 * │                                                                            │
 * │ Un self-host (OSRM_BASE_URL) lèverait ces limites ; en attendant on les    │
 * │ respecte : lots de dix, une pause entre deux, et un lot refusé ne fait     │
 * │ plus perdre tout le trajet — ses points bruts restent, les autres lots     │
 * │ sont recalés.                                                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const OSRM_MAX_COORDONNEES = 10;
/** 25 m : accepté par le service public (40 passe encore, 50 est refusé). */
export const OSRM_RAYON_M = 25;

type Point = { lat: number; lng: number };

/**
 * Découpe en lots de `taille` points, chaque lot REPARTANT du dernier point du précédent :
 * sans ce chevauchement, la route entre deux lots resterait une droite.
 */
export function decouperEnLots<T>(points: T[], taille: number): T[][] {
  const lots: T[][] = [];
  let debut = 0;
  while (debut < points.length) {
    const fin = Math.min(points.length, debut + taille);
    lots.push(points.slice(debut, fin));
    if (fin >= points.length) break;
    debut = fin - 1;
  }
  return lots;
}

@Injectable()
export class MapMatchingService {
  private readonly logger = new Logger(MapMatchingService.name);
  private readonly baseUrl = process.env.OSRM_BASE_URL ?? 'https://router.project-osrm.org';
  /** Pause entre deux lots : un service public gratuit, on ne le mitraille pas. Les tests la mettent à 0. */
  protected pauseMs = 150;

  /**
   * Snap une polyligne aux routes. Retourne null si moins de 2 points sont fournis, ou si
   * AUCUN lot n'a pu être recalé ; un lot refusé garde ses points bruts.
   */
  async match(points: Point[]): Promise<Point[] | null> {
    if (points.length < 2) return null;

    const lots = decouperEnLots(points, OSRM_MAX_COORDONNEES);
    const resultat: Point[] = [];
    let recales = 0;
    for (let i = 0; i < lots.length; i++) {
      const lot = lots[i]!;
      if (i > 0) await this.pause();
      const segment = await this.matchChunk(lot);
      if (segment) recales++;
      else this.logger.warn(`OSRM : lot ${i + 1}/${lots.length} (${lot.length} points) non recalé, tronçon brut conservé`);
      const morceau = segment ?? lot;
      // Le premier point d'un lot est le dernier du précédent : ne pas le doubler.
      resultat.push(...(resultat.length > 0 ? morceau.slice(1) : morceau));
    }
    if (recales === 0) {
      this.logger.warn(`OSRM : aucun des ${lots.length} lots recalé (${points.length} points), fallback raw`);
      return null;
    }
    return resultat;
  }

  protected pause(): Promise<void> {
    return this.pauseMs > 0 ? new Promise((r) => setTimeout(r, this.pauseMs)) : Promise.resolve();
  }

  private async matchChunk(points: Point[]): Promise<Point[] | null> {
    const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const url = `${this.baseUrl}/match/v1/driving/${coords}?geometries=geojson&overview=full&radiuses=${points.map(() => OSRM_RAYON_M).join(';')}`;

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
