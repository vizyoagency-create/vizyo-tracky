import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { PositionUpdateEvent } from '@vizyo/tracky-shared';
import { WS_EVENTS } from '@vizyo/tracky-shared';
import { RealtimeGateway } from './realtime.gateway';

/**
 * V1.5 (Sprint H1) — Batch coalescing des positions.
 *
 * A 30+ vehicules actifs simultanes, le serveur emet 30+ events `POSITION_UPDATE`
 * en rafale toutes les ~30s. Chaque event = 1 frame WS = 1 cycle parse/render
 * cote client. Ce buffer accumule les positions par fleet pendant 1s puis emet
 * un unique `POSITIONS_BATCH` (deduplique par trackerId — on garde la derniere).
 *
 * Pour preserver la latence ressentie en mouvement, l'event `POSITION_UPDATE`
 * legacy reste emis en parallele tant que le frontend ne s'est pas migre
 * completement (les deux events arrivent — le client doit ignorer les doublons).
 *
 * Desactivable via env `WS_BATCH_COALESCING_ENABLED=false` pour rollback rapide.
 */
@Injectable()
export class PositionBroadcastBuffer {
  private readonly logger = new Logger(PositionBroadcastBuffer.name);
  private readonly buffer = new Map<string, Map<string, PositionUpdateEvent>>();
  private readonly enabled: boolean;

  constructor(private readonly gateway: RealtimeGateway) {
    const flag = process.env.WS_BATCH_COALESCING_ENABLED?.toLowerCase();
    this.enabled = flag !== 'false' && flag !== '0';
  }

  /**
   * Add an event to the buffer. Returns true if buffered (caller may skip the
   * legacy immediate emit), false if buffering is disabled (caller must emit).
   */
  enqueue(fleetId: string, event: PositionUpdateEvent): boolean {
    if (!this.enabled) return false;

    let fleetBucket = this.buffer.get(fleetId);
    if (!fleetBucket) {
      fleetBucket = new Map();
      this.buffer.set(fleetId, fleetBucket);
    }
    // Dedup by trackerId: keep the freshest position per tracker in the window.
    fleetBucket.set(event.trackerId, event);
    return true;
  }

  @Interval(1000)
  flush(): void {
    if (this.buffer.size === 0) return;

    const server = this.gateway.server;
    if (!server) return;

    for (const [fleetId, fleetBucket] of this.buffer) {
      if (fleetBucket.size === 0) continue;

      // Filtrage room vide : si aucun client connecte sur cette fleet ET que la
      // room super-admin est vide aussi, on droppe le batch silencieusement.
      const fleetRoom = server.sockets.adapter.rooms.get(`fleet:${fleetId}`);
      const wildcardRoom = server.sockets.adapter.rooms.get('fleet:*');
      const hasListeners = (fleetRoom && fleetRoom.size > 0) || (wildcardRoom && wildcardRoom.size > 0);
      if (!hasListeners) {
        fleetBucket.clear();
        continue;
      }

      const positions = Array.from(fleetBucket.values());
      server
        .to(`fleet:${fleetId}`)
        .to('fleet:*')
        .emit(WS_EVENTS.POSITIONS_BATCH, { fleetId, positions });
      fleetBucket.clear();
    }
    // Garbage collect empty buckets (optional, prevents memory creep on long runs).
    for (const [fleetId, fleetBucket] of this.buffer) {
      if (fleetBucket.size === 0) this.buffer.delete(fleetId);
    }
  }
}
