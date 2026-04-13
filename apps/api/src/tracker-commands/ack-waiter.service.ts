import { Injectable, Logger } from '@nestjs/common';

interface PendingAck {
  commandId: string;
  pattern: RegExp;
  resolve: (rawFrame: string) => void;
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  sentAt: number;
}

@Injectable()
export class AckWaiterService {
  private readonly logger = new Logger(AckWaiterService.name);
  private readonly waiters = new Map<string, PendingAck[]>();

  waitForAck(imei: string, pattern: RegExp, timeoutMs: number, commandId: string): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.removeWaiter(imei, commandId);
        reject(new Error(`ACK timeout after ${timeoutMs}ms`));
      }, timeoutMs);

      const pending: PendingAck = {
        commandId,
        pattern,
        resolve,
        reject,
        timeout,
        sentAt: Date.now(),
      };

      const existing = this.waiters.get(imei) ?? [];
      existing.push(pending);
      this.waiters.set(imei, existing);

      this.logger.debug(
        { imei, commandId, pattern: pattern.source, timeoutMs },
        `Waiting for ACK`,
      );
    });
  }

  tryMatch(imei: string, rawFrame: string): boolean {
    const pending = this.waiters.get(imei);
    if (!pending || pending.length === 0) return false;

    for (let i = 0; i < pending.length; i++) {
      if (pending[i].pattern.test(rawFrame)) {
        const matched = pending[i];
        clearTimeout(matched.timeout);
        pending.splice(i, 1);
        if (pending.length === 0) this.waiters.delete(imei);

        const latencyMs = Date.now() - matched.sentAt;
        this.logger.log(
          { imei, commandId: matched.commandId, latencyMs, rawAck: rawFrame },
          `ACK matched for ${matched.commandId.slice(0, 8)}`,
        );

        matched.resolve(rawFrame);
        return true;
      }
    }

    return false;
  }

  hasPending(imei: string): boolean {
    return (this.waiters.get(imei)?.length ?? 0) > 0;
  }

  cancelAll(imei: string): void {
    const pending = this.waiters.get(imei);
    if (!pending) return;
    for (const p of pending) {
      clearTimeout(p.timeout);
      p.reject(new Error('Cancelled: tracker disconnected'));
    }
    this.waiters.delete(imei);
  }

  private removeWaiter(imei: string, commandId: string): void {
    const pending = this.waiters.get(imei);
    if (!pending) return;
    const idx = pending.findIndex((p) => p.commandId === commandId);
    if (idx !== -1) pending.splice(idx, 1);
    if (pending.length === 0) this.waiters.delete(imei);
  }
}
