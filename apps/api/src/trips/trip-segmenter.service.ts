import { Injectable } from '@nestjs/common';
import { distanceMeters } from '../common/utils/haversine';
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
}

export interface TripDraft {
  startedAt: Date;
  endedAt: Date;
  startLat: number;
  startLng: number;
  endLat: number;
  endLng: number;
  distanceMeters: number;
  maxSpeed: number;
  avgSpeed: number;
  durationSeconds: number;
  positionCount: number;
  segmentationSource: string;
  positions: Array<{ lat: number; lng: number }>;
}

@Injectable()
export class TripSegmenterService {
  segmentPositions(positions: SegmenterPosition[]): TripDraft[] {
    if (positions.length < 2) return [];

    const sorted = [...positions].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    const trips: TripDraft[] = [];

    let tripPositions: SegmenterPosition[] = [];
    let movingStartedAt: Date | null = null;
    let zeroSpeedSince: Date | null = null;
    let source = 'hybrid';

    const finalize = (endPos: SegmenterPosition) => {
      if (tripPositions.length < 2) { tripPositions = []; return; }

      let dist = 0;
      let maxSpd = 0;
      let spdSum = 0;
      for (let i = 1; i < tripPositions.length; i++) {
        const prev = tripPositions[i - 1]!;
        const cur = tripPositions[i]!;
        dist += distanceMeters(prev.lat, prev.lng, cur.lat, cur.lng);
        maxSpd = Math.max(maxSpd, cur.speedKmh);
        spdSum += cur.speedKmh;
      }

      if (dist < TRIP_MIN_DISTANCE_METERS) { tripPositions = []; return; }

      const start = tripPositions[0]!;
      const end = tripPositions[tripPositions.length - 1]!;
      const dur = Math.round((end.timestamp.getTime() - start.timestamp.getTime()) / 1000);

      trips.push({
        startedAt: start.timestamp,
        endedAt: end.timestamp,
        startLat: start.lat,
        startLng: start.lng,
        endLat: end.lat,
        endLng: end.lng,
        distanceMeters: Math.round(dist),
        maxSpeed: Math.round(maxSpd * 100) / 100,
        avgSpeed: Math.round((spdSum / tripPositions.length) * 100) / 100,
        durationSeconds: dur,
        positionCount: tripPositions.length,
        segmentationSource: source,
        positions: tripPositions.map((p) => ({ lat: p.lat, lng: p.lng })),
      });

      tripPositions = [];
    };

    for (const pos of sorted) {
      if (pos.ignition === false) {
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
