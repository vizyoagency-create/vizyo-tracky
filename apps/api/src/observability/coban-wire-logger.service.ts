import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import { PrismaService } from '../prisma/prisma.service';
import { ErrorLogger } from './error-logger.service';

export interface WireLogContext {
  commandId?: string;
  source?: 'engine' | 'tracker-cmd' | 'ack' | 'tcp-server';
  trackerId?: string;
  vehicleId?: string;
  fleetId?: string;
  [key: string]: unknown;
}

@Injectable()
export class CobanWireLogger {
  private readonly logger = new Logger('CobanWire');
  private readonly enabled: boolean;

  constructor(
    private readonly prisma: PrismaService,
    private readonly errorLogger: ErrorLogger,
    config: ConfigService<Env, true>,
  ) {
    this.enabled = config.get('WIRE_LOG_ENABLED', { infer: true }) === 'true';
  }

  in(imei: string, rawFrame: string, frameType: string): void {
    this.logger.debug({ imei, frameType, direction: 'IN', frameRaw: rawFrame }, `Frame IN from ${imei}`);
    if (this.enabled) {
      this.persist(imei, 'IN', rawFrame, frameType, undefined, undefined).catch((e) => this.errorLogger.record(e instanceof Error ? e : new Error(String(e)), 'wire-logger').catch((e2) => this.logger.error('ErrorLogger persist failed', e2)));
    }
  }

  out(imei: string, payload: string, context?: WireLogContext): void {
    this.logger.log(
      { imei, direction: 'OUT', payload, commandId: context?.commandId, source: context?.source },
      `Frame OUT to ${imei}`,
    );
    if (this.enabled) {
      this.persist(imei, 'OUT', payload, 'command', context?.commandId, context).catch((e) => this.errorLogger.record(e instanceof Error ? e : new Error(String(e)), 'wire-logger').catch((e2) => this.logger.error('ErrorLogger persist failed', e2)));
    }
  }

  ackMatch(imei: string, rawFrame: string, commandId: string, latencyMs: number): void {
    this.logger.log(
      { imei, commandId, latencyMs, direction: 'IN', frameRaw: rawFrame },
      `ACK matched for command ${commandId.slice(0, 8)} (${latencyMs}ms)`,
    );
    if (this.enabled) {
      this.persist(imei, 'IN', rawFrame, 'ack', commandId, { latencyMs }).catch((e) => this.errorLogger.record(e instanceof Error ? e : new Error(String(e)), 'wire-logger').catch((e2) => this.logger.error('ErrorLogger persist failed', e2)));
    }
  }

  ackTimeout(imei: string, commandId: string, pattern: string, elapsedMs: number): void {
    this.logger.warn(
      { imei, commandId, expectedPattern: pattern, elapsedMs },
      `ACK timeout for command ${commandId.slice(0, 8)} after ${elapsedMs}ms`,
    );
    if (this.enabled) {
      this.persist(imei, 'OUT', `ACK_TIMEOUT pattern=${pattern}`, 'ack', commandId, { elapsedMs }).catch((e) => this.errorLogger.record(e instanceof Error ? e : new Error(String(e)), 'wire-logger').catch((e2) => this.logger.error('ErrorLogger persist failed', e2)));
    }
  }

  private async persist(
    imei: string,
    direction: string,
    raw: string,
    frameType: string,
    commandId?: string,
    context?: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma.wireLog.create({
      data: {
        imei,
        direction,
        raw,
        frameType,
        commandId: commandId ?? null,
        context: context ? (context as any) : undefined,
      },
    });
  }
}
