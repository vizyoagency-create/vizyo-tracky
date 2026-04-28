import { Injectable, Logger } from '@nestjs/common';

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

  register(imei: string, socket: TrackerSocket): void {
    const existing = this.sockets.get(imei);
    if (existing && existing.socket !== socket) {
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
