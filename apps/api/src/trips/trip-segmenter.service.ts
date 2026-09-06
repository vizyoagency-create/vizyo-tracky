import { Injectable, Logger } from '@nestjs/common';
import { sanitizePositions, vitesseMaxCorroboree } from '@vizyo/tracky-shared';
import { distanceMeters } from '../common/utils/haversine';
import { tempsRoulantSec, vitesseMoyenneTrajet } from '../common/vitesse-moyenne';
import {
  TRIP_MIN_DISTANCE_METERS,
  TRIP_SPEED_THRESHOLD_KMH,
  TRIP_STOP_TIMEOUT_MS,
  TRIP_MOVING_CONFIRM_MS,
} from './trip-segmenter.constants';

export interface SegmenterPosition {
  lat: number;
  lng: number;
  speedKmh: number;
  timestamp: Date;
  ignition?: boolean;
  /**
   * Fix GPS valide ? `false` = le boîtier n'avait pas de position sûre. Absent = inconnu, donc
   * conservé (lot V7 : on aligne la population de points sur celle de l'analyse, on ne
   * durcit pas le filtre au passage).
   */
  valid?: boolean;
}

export interface TripDraft {
  startedAt: Date;
  endedAt: Date;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  distanceMeters: number;
  /**
   * Vitesse maximale CORROBORÉE par le déplacement : les points dont le boîtier annonce une
   * vitesse que la trajectoire contredit n'y entrent pas (cf. `vitesseMaxCorroboree`).
   */
  maxSpeed: number;
  /** Pointe brute annoncée par le boîtier, conservée pour ne rien effacer en silence. */
  maxSpeedBrute: number;
  /** Nombre de points dont la vitesse annoncée n'était soutenue par aucun intervalle voisin. */
  pointsVitesseEcartes: number;
  /**
   * Distance ÷ TEMPS ROULANT. Ce champ portait la moyenne arithmétique des vitesses des
   * points, qui pondérait chaque relevé pareil quelle que soit sa durée : sur les 12 314
   * trajets analysés de la base, elle sortait 7,7 km/h en dessous de la vraie moyenne, et
   * dépendait de la cadence du boîtier plutôt que de la conduite. Une seule définition
   * désormais, celle de `common/vitesse-moyenne`, partagée avec l'analyse.
   */
  avgSpeed: number;
  /**
   * Le dénominateur de la ligne ci-dessus, STOCKÉ et pas seulement calculé : sans lui, la
   * moyenne ne serait vérifiable par personne — ni par un gestionnaire qui doute, ni par une
   * reprise de données. C'est aussi ce qui permet d'agréger une flotte correctement
   * (Σ km ÷ Σ temps roulant) au lieu de moyenner des moyennes.
   */
  movingSeconds: number;
  durationSeconds: number;
  positionCount: number;
  segmentationSource: string;
  positions: Array<{ lat: number; lng: number }>;
}

@Injectable()
export class TripSegmenterService {
  private readonly logger = new Logger(TripSegmenterService.name);

  segmentPositions(positions: SegmenterPosition[]): TripDraft[] {
    if (positions.length < 2) return [];

    // Tri chronologique puis filtre defensif (Null Island, sauts > 250 km/h,
    // doublons de timestamp). Garantit une polyligne propre en sortie.
    // ⚠️ MÊME FILTRE QUE L'ANALYSE (lot V7) : un fix invalide ne fait ni la distance, ni la
    // vitesse maximale, ni un excès. Sans cela, le trajet et son analyse comptaient sur deux
    // populations de points différentes, et pouvaient afficher deux vitesses maximales.
    const retenues = positions.filter((p) => p.valid !== false);
    const sorted = [...retenues].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const sanitized = sanitizePositions(sorted) as SegmenterPosition[];
    if (sanitized.length < 2) return [];

    const trips: TripDraft[] = [];

    let tripPositions: SegmenterPosition[] = [];
    let movingStartedAt: Date | null = null;
    let zeroSpeedSince: Date | null = null;
    let source = 'hybrid';

    const finalize = (endPos: SegmenterPosition) => {
      if (tripPositions.length < 2) { tripPositions = []; return; }

      let dist = 0;
      for (let i = 1; i < tripPositions.length; i++) {
        const prev = tripPositions[i - 1]!;
        const cur = tripPositions[i]!;
        dist += distanceMeters(prev.lat, prev.lng, cur.lat, cur.lng);
      }

      /**
       * ⚠️ LA VITESSE MAXIMALE NE PEUT PAS ÊTRE CELLE QUE LA TRAJECTOIRE CONTREDIT.
       *
       * Elle était jusqu'ici le simple maximum du champ vitesse du boîtier. Le 29 août, sur
       * EY-613-MF, ce champ a annoncé 180 km/h pendant que le véhicule parcourait 727 mètres
       * en vingt secondes, soit 131 km/h. Le 180 est parti en base, s'est affiché en rouge et
       * a nourri le score de conduite comme le rapport de vitesse — qui sert de pièce
       * disciplinaire.
       *
       * On ne corrige aucune valeur : on retient la plus haute vitesse que le déplacement
       * SOUTIENT, et on conserve la pointe brute pour que la réserve reste visible.
       */
      const vitesses = vitesseMaxCorroboree(tripPositions);
      const maxSpd = vitesses.maxCorroboreeKmh;
      if (vitesses.pointsEcartes > 0) {
        this.logger.warn(
          `Trajet ${source} : ${vitesses.pointsEcartes} point(s) de vitesse non corroborés par la trajectoire ` +
            `(pointe brute ${Math.round(vitesses.pointeBruteKmh)} km/h, retenu ${Math.round(maxSpd)} km/h).`,
        );
      }

      if (dist < TRIP_MIN_DISTANCE_METERS) { tripPositions = []; return; }

      const start = tripPositions[0]!;
      const end = tripPositions[tripPositions.length - 1]!;
      // Garantie : tripPositions est issu de `sanitized` (ligne 43) qui est tri-
      // ordonne et dedoublonne, donc end.timestamp >= start.timestamp toujours.
      // `Math.max(0, ...)` est belt-and-suspenders au cas ou un futur changement
      // de sanitizePositions casserait l'invariant.
      const dur = Math.max(
        0,
        Math.round((end.timestamp.getTime() - start.timestamp.getTime()) / 1000),
      );
      // Le temps réellement passé à rouler, seuils et trous de signal compris (cf.
      // `common/vitesse-moyenne`). C'est le dénominateur de la vitesse moyenne.
      const roulantSec = tempsRoulantSec(tripPositions);

      trips.push({
        startedAt: start.timestamp,
        endedAt: end.timestamp,
        startLat: start.lat,
        startLng: start.lng,
        endLat: end.lat,
        endLng: end.lng,
        distanceMeters: Math.max(0, Math.round(dist)),
        maxSpeed: Math.max(0, Math.round(maxSpd * 100) / 100),
        maxSpeedBrute: Math.max(0, Math.round(vitesses.pointeBruteKmh * 100) / 100),
        pointsVitesseEcartes: vitesses.pointsEcartes,
        avgSpeed: vitesseMoyenneTrajet({
          distanceKm: dist / 1000, movingSec: roulantSec, durationSec: dur, maxSpeedKmh: maxSpd,
        }),
        movingSeconds: roulantSec,
        durationSeconds: dur,
        positionCount: tripPositions.length,
        segmentationSource: source,
        positions: tripPositions.map((p) => ({ lat: p.lat, lng: p.lng })),
      });

      tripPositions = [];
    };

    for (const pos of sanitized) {
      if (pos.ignition === false && pos.speedKmh <= TRIP_SPEED_THRESHOLD_KMH) {
        if (tripPositions.length > 0) {
          tripPositions.push(pos);
          source = 'ignition';
          finalize(pos);
        }
        movingStartedAt = null;
        zeroSpeedSince = null;
        continue;
      }

      if (pos.ignition === true && tripPositions.length === 0) {
        source = 'ignition';
      }

      if (pos.speedKmh > TRIP_SPEED_THRESHOLD_KMH) {
        zeroSpeedSince = null;

        if (tripPositions.length === 0) {
          if (!movingStartedAt) {
            movingStartedAt = pos.timestamp;
          } else if (pos.timestamp.getTime() - movingStartedAt.getTime() >= TRIP_MOVING_CONFIRM_MS) {
            tripPositions.push(pos);
            if (source !== 'ignition') source = 'speed';
          }
        } else {
          tripPositions.push(pos);
        }
      } else {
        movingStartedAt = null;

        if (tripPositions.length > 0) {
          tripPositions.push(pos);

          if (pos.speedKmh === 0) {
            if (!zeroSpeedSince) {
              zeroSpeedSince = pos.timestamp;
            } else if (pos.timestamp.getTime() - zeroSpeedSince.getTime() >= TRIP_STOP_TIMEOUT_MS) {
              if (source !== 'ignition') source = 'speed';
              finalize(pos);
              zeroSpeedSince = null;
            }
          } else {
            zeroSpeedSince = null;
          }
        }
      }
    }

    if (tripPositions.length >= 2) {
      finalize(tripPositions[tripPositions.length - 1]!);
    }

    return trips;
  }
}
