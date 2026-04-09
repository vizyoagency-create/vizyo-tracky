import { Injectable, Logger } from '@nestjs/common';
import type { Socket } from 'node:net';

interface RegisteredSocket {
  imei: string;
  socket: Socket;
  connectedAt: Date;
  lastSeenAt: Date;
  remoteAddress: string;
}

@Injectable()
export class SocketRegistryService {
  private readonly logger = new Logger(SocketRegistryService.name);
  private readonly sockets = new Map<string, RegisteredSocket>();

  register(imei: string, socket: Socket): void {
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
    this.logger.log(`Tracker registered: ${imei} from ${socket.remoteAddress}`);
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

  /**
   * Envoie une commande brute à un tracker connecté.
   * Retourne false si le tracker n'a pas de socket actif.
   */
  send(imei: string, payload: string | Buffer): boolean {
    const entry = this.sockets.get(imei);
    if (!entry || entry.socket.destroyed) return false;
    try {
      entry.socket.write(payload);
      return true;
    } catch (err) {
      this.logger.error(`Failed to send to ${imei}`, err);
      return false;
    }
  }
}
