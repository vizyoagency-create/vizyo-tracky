import { Injectable, Logger, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * T42 (contre-expertise du 13/09, P1-1) — « ce boîtier vient de (re)devenir joignable en TCP ».
 *
 * Émis à chaque socket NEUVE enregistrée pour un IMEI : login d'un boîtier réel, socket de
 * démonstration. Un boîtier qui renvoie son login sur la MÊME socket ne déclenche rien — ce n'est
 * pas une reconnexion. Jusqu'ici personne n'écoutait ce moment ; c'est pourtant le seul où une
 * RESTORE encore non prouvée peut repartir gratuitement, en TCP (cf. EngineControlService).
 */
export const TRACKER_CONNECTED_EVENT = 'tracker.connected';
export interface TrackerConnectedEvent {
  imei: string;
  remoteAddress: string;
  /** true = une socket précédente de ce boîtier vient d'être remplacée (reconnexion). */
  replaced: boolean;
  at: string;
}

export interface TrackerSocket {
  write(data: string | Buffer): boolean;
  destroy(): void;
  readonly remoteAddress?: string;
  readonly destroyed?: boolean;
  readonly writable?: boolean;
}

interface RegisteredSocket {
  imei: string;
  socket: TrackerSocket;
  connectedAt: Date;
  lastSeenAt: Date;
  remoteAddress: string;
}

@Injectable()
export class SocketRegistryService {
  private readonly logger = new Logger(SocketRegistryService.name);
  private readonly sockets = new Map<string, RegisteredSocket>();

  constructor(
    // Facultatif : les specs et les outils construisent le registre sans émetteur d'événements.
    @Optional() private readonly events?: EventEmitter2,
  ) {}

  register(imei: string, socket: TrackerSocket): void {
    const existing = this.sockets.get(imei);
    const replaced = existing !== undefined && existing.socket !== socket;
    if (replaced) {
      this.logger.warn(`Replacing existing socket for IMEI ${imei}`);
      existing.socket.destroy();
    }
    this.sockets.set(imei, {
      imei,
      socket,
      connectedAt: new Date(),
      lastSeenAt: new Date(),
      remoteAddress: socket.remoteAddress ?? 'unknown',
    });
    this.logger.log(`Tracker registered: ${imei} from ${socket.remoteAddress ?? 'unknown'}`);
    // T42 — après l'inscription, jamais avant : un abonné qui écrit tout de suite doit trouver
    // la socket. Et seulement pour une socket neuve (première inscription ou remplacement).
    if (!existing || replaced) this.emitConnected(imei, socket.remoteAddress ?? 'unknown', replaced);
  }

  private emitConnected(imei: string, remoteAddress: string, replaced: boolean): void {
    if (!this.events) return;
    try {
      const evt: TrackerConnectedEvent = { imei, remoteAddress, replaced, at: new Date().toISOString() };
      this.events.emit(TRACKER_CONNECTED_EVENT, evt);
    } catch (err) {
      // Un abonné qui lève ne doit jamais casser le login d'un boîtier.
      this.logger.warn(`tracker.connected non diffusé pour ${imei} : ${(err as Error)?.message ?? String(err)}`);
    }
  }

  touch(imei: string): void {
    const entry = this.sockets.get(imei);
    if (entry) entry.lastSeenAt = new Date();
  }

  unregister(imei: string): void {
    const entry = this.sockets.get(imei);
    if (!entry) return;
    this.sockets.delete(imei);
    this.logger.log(`Tracker unregistered: ${imei}`);
  }

  get(imei: string): RegisteredSocket | undefined {
    return this.sockets.get(imei);
  }

  has(imei: string): boolean {
    return this.sockets.has(imei);
  }

  listOnline(): string[] {
    return Array.from(this.sockets.keys());
  }

  send(imei: string, payload: string | Buffer): boolean {
    const entry = this.sockets.get(imei);
    if (!entry || entry.socket.destroyed) return false;
    // Guard: socket can be non-destroyed but no longer writable (half-dead TCP)
    if (entry.socket.writable === false) {
      this.logger.warn(`Socket for ${imei} is not writable, cleaning up`);
      this.unregister(imei);
      return false;
    }
    try {
      const flushed = entry.socket.write(payload);
      if (!flushed) {
        this.logger.warn(`Write buffer backpressure for ${imei} — payload queued`);
      }
      return true;
    } catch (err) {
      this.logger.error(`Failed to send to ${imei}, cleaning up`, err);
      this.unregister(imei);
      return false;
    }
  }
}
