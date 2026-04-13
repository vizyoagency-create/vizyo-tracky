import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ErrorLogContext {
  imei?: string;
  commandId?: string;
  userId?: string;
  trackerId?: string;
  vehicleId?: string;
  fleetId?: string;
  requestId?: string;
  route?: string;
  [key: string]: unknown;
}

@Injectable()
export class ErrorLogger {
  private readonly logger = new Logger('ErrorLogger');

  constructor(private readonly prisma: PrismaService) {}

  async record(
    error: Error | string,
    source: string,
    context?: ErrorLogContext,
    level: 'ERROR' | 'CRITICAL' = 'ERROR',
  ): Promise<string> {
    const message = typeof error === 'string' ? error : error.message;
    const stack = typeof error === 'string' ? undefined : error.stack;

    this.logger.error(
      { source, ...context, stack },
      `[${source}] ${message}`,
    );

    try {
      const row = await this.prisma.errorLog.create({
        data: {
          level,
          source,
          message,
          stack: stack ?? null,
          imei: context?.imei ?? null,
          commandId: context?.commandId ?? null,
          userId: context?.userId ?? null,
          context: context ? (context as any) : undefined,
        },
      });
      return row.id;
    } catch (dbErr) {
      this.logger.error('Failed to persist ErrorLog', dbErr);
      return 'persist-failed';
    }
  }
}
