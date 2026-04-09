import { Logger } from '@nestjs/common';
import type { TrackerSocket } from '../socket-registry/socket-registry.service';

export class FakeTcpSocket implements TrackerSocket {
  private readonly logger = new Logger(FakeTcpSocket.name);
  readonly remoteAddress = '[mock]';
  destroyed = false;

  constructor(
    public readonly imei: string,
    private readonly onCommand: (imei: string, action: 'CUT' | 'RESTORE') => void,
  ) {}

  write(data: string | Buffer): boolean {
    const payload = typeof data === 'string' ? data : data.toString('ascii');
    this.logger.log(`[MOCK SOCKET] <- ${this.imei}: ${payload}`);

    if (payload.includes(',J')) {
      this.onCommand(this.imei, 'CUT');
      this.logger.warn(`[MOCK] Engine CUT executed for ${this.imei}`);
    } else if (payload.includes(',K')) {
      this.onCommand(this.imei, 'RESTORE');
      this.logger.warn(`[MOCK] Engine RESTORE executed for ${this.imei}`);
    }

    return true;
  }

  destroy(): void {
    this.destroyed = true;
  }
}
