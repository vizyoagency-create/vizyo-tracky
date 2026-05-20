import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TrackerCommandStatus } from '@prisma/client';
import { ErrorLogger } from '../observability/error-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { TrackerCommandsService } from './tracker-commands.service';

@Injectable()
export class TrackerCommandsSchedulerService {
  private readonly logger = new Logger(TrackerCommandsSchedulerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly commandsService: TrackerCommandsService,
    private readonly errorLogger: ErrorLogger,
  ) {}

  @Cron('*/30 * * * * *')
  async pollScheduledCommands(): Promise<void> {
    const due = await this.prisma.trackerCommand.findMany({
      where: {
        status: TrackerCommandStatus.SCHEDULED,
        scheduledAt: { lte: new Date() },
      },
      include: { tracker: { include: { vehicle: true } } },
      take: 10,
    });

    if (due.length === 0) return;

    this.logger.log({ count: due.length }, `Dispatching ${due.length} scheduled command(s)`);

    for (const command of due) {
      try {
        await this.commandsService.dispatch(
          command,
          command.tracker.imei,
          command.tracker.vehicle?.fleetId ?? null,
        );
      } catch (err) {
        this.logger.warn(
          { commandId: command.id, error: (err as Error).message },
          `Failed to dispatch scheduled command`,
        );
        this.errorLogger.record(
          err instanceof Error ? err : new Error(String(err)),
          'tracker-commands',
          { commandId: command.id, imei: command.tracker.imei },
        ).catch((e2) => this.logger.error('ErrorLogger persist failed', e2));
      }
    }
  }
}
