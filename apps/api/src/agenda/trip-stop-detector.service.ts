import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { haversineMeters } from '@vizyo/tracky-shared';

/** Une position minimale (testable sans Prisma). */
export interface StopPosition {
  lat: number;
  lng: number;
  speedKmh: number;
  timestamp: Date;
}

/** Un ARRÊT significatif : un lieu où le véhicule est resté stationnaire un moment (destination réelle). */
export interface TripStop {
  lat: number;
  lng: number;
  arrivedAt: Date;
  leftAt: Date;
  durationMin: number;
}

/** Rayon (m) : positions plus proches que ça = « même endroit ». */
const STOP_RADIUS_M = 130;
/** Durée MINIMALE d'un arrêt retenu : exclut feux/bouchons, garde les vraies visites. */
const STOP_MIN_MS = 4 * 60 * 1000;
/** Vitesse (km/h) sous laquelle on considère le véhicule à l'arrêt (bruit GPS toléré). */
const STOP_SPEED_KMH = 4;
/** Borne dure de positions lues par trajet (perf). */
const MAX_POSITIONS = 4000;

/**
 * Refonte agenda/IA (#3) — Détection des ARRÊTS d'un trajet à partir des positions GPS.
 *
 * Le détecteur de récurrence ne regardait que le POINT D'ARRIVÉE d'un trajet — or pour une flotte qui
 * rentre au dépôt, c'est TOUJOURS le dépôt (« → Launaguet »), ce qui n'apprend rien à l'IA. Ici on
 * dérive les vrais lieux visités : on regroupe les positions consécutives restées dans un petit rayon
 * pendant ≥ 4 min = un arrêt (Borderouge, Ramonville…). Robuste aux données éparses (un véhicule garé
 * n'émet qu'un heartbeat/heure) car l'arrêt est mesuré en DURÉE (timestamps), pas en nombre de points.
 */
@Injectable()
export class TripStopDetectorService {
  constructor(private readonly prisma: PrismaService) {}

  /** Arrêts significatifs d'un trajet (positions du tracker sur la fenêtre du trajet). */
  async deriveStops(trackerId: string, from: Date, to: Date): Promise<TripStop[]> {
    const positions = await this.prisma.position.findMany({
      where: { trackerId, timestamp: { gte: from, lte: to }, valid: true },
      select: { lat: true, lng: true, speedKmh: true, timestamp: true },
      orderBy: { timestamp: 'asc' },
      take: MAX_POSITIONS,
    });
    return this.detectStops(positions);
  }

  /**
   * Détection PURE (testable) : regroupe les positions consécutives « au même endroit » (rayon), et
   * ne retient un groupe comme arrêt que s'il a duré ≥ STOP_MIN_MS. La vitesse sert d'indice secondaire
   * (un point clairement en mouvement rompt un groupe même s'il repasse dans le rayon).
   */
  detectStops(positions: StopPosition[]): TripStop[] {
    const stops: TripStop[] = [];
    let run: StopPosition[] = [];
    let cLat = 0;
    let cLng = 0;

    const flush = () => {
      if (run.length === 0) return;
      const arrived = run[0].timestamp;
      const left = run[run.length - 1].timestamp;
      const durMs = left.getTime() - arrived.getTime();
      if (durMs >= STOP_MIN_MS) {
        stops.push({
          lat: cLat,
          lng: cLng,
          arrivedAt: arrived,
          leftAt: left,
          durationMin: Math.round(durMs / 60000),
        });
      }
      run = [];
    };

    for (const p of positions) {
      if (run.length === 0) {
        run = [p];
        cLat = p.lat;
        cLng = p.lng;
        continue;
      }
      const moving = p.speedKmh > STOP_SPEED_KMH;
      const withinRadius = haversineMeters(cLat, cLng, p.lat, p.lng) <= STOP_RADIUS_M;
      if (withinRadius && !moving) {
        // Même endroit, à l'arrêt → étend le groupe et recentre (moyenne incrémentale).
        run.push(p);
        cLat += (p.lat - cLat) / run.length;
        cLng += (p.lng - cLng) / run.length;
      } else {
        flush();
        run = [p];
        cLat = p.lat;
        cLng = p.lng;
      }
    }
    flush();
    return stops;
  }
}

/** Distance haversine en mètres (auto-suffisant : pas de dépendance géo pour un composant back). */
/**
 * ⚠️ ALIAS de la formule PARTAGÉE (`utils/gps-sanity`), qui sert déjà à l'ingestion, au
 * segmenteur et au replay. Une copie locale vivait ici ; elle donnait le même résultat, donc
 * rien ne signalait la divergence — et c'est exactement ce qui la rendait durable.
 * Ne PAS y remettre de calcul.
 */
export { haversineMeters };
