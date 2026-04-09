import type { PositionUpdateDto } from '../dto/position.dto';
import type { TrackerStatusChangedDto } from '../dto/tracker.dto';
import type { AlertDto } from '../dto/alert.dto';

export const WS_EVENTS = {
  POSITION_UPDATE: 'position:update',
  TRACKER_STATUS: 'tracker:status',
  ALERT_NEW: 'alert:new',
} as const;

export interface ServerToClientEvents {
  'position:update': (payload: PositionUpdateDto) => void;
  'tracker:status': (payload: TrackerStatusChangedDto) => void;
  'alert:new': (payload: AlertDto) => void;
}

export interface ClientToServerEvents {
  'fleet:subscribe': (fleetId: string) => void;
  'fleet:unsubscribe': (fleetId: string) => void;
}
