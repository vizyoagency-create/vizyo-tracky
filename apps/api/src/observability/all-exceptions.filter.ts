import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomUUID } from 'node:crypto';
import { ErrorLogger } from './error-logger.service';

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ExceptionFilter');

  constructor(private readonly errorLogger: ErrorLogger) {}

  async catch(exception: unknown, host: ArgumentsHost): Promise<void> {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const requestId = (req as any).id ?? randomUUID().slice(0, 8);

    let status: number;
    let message: string;
    let code: string;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      message = typeof body === 'string' ? body : (body as any).message ?? exception.message;
      code = typeof body === 'object' && (body as any).error ? (body as any).error : HttpStatus[status] ?? 'ERROR';
    } else if (exception instanceof Error) {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Internal server error';
      code = 'INTERNAL_SERVER_ERROR';
    } else {
      status = HttpStatus.INTERNAL_SERVER_ERROR;
      message = 'Unknown error';
      code = 'INTERNAL_SERVER_ERROR';
    }

    if (Array.isArray(message)) {
      message = message.join(', ');
    }

    const user = (req as any).user as
      | { id?: string; email?: string; fleetId?: string | null }
      | undefined;
    const headers: Record<string, unknown> = req.headers ?? {};
    const str = (v: unknown, max: number): string | undefined =>
      typeof v === 'string' ? v.slice(0, max) : undefined;

    if (status >= 500 || !(exception instanceof HttpException)) {
      // CRITICAL est reserve aux fautes serveur non maitrisees (exception non geree
      // -> 500). Un 5xx leve VOLONTAIREMENT (HttpException) est une condition
      // operationnelle attendue, pas un crash : ex. 503 "tracker hors ligne" sur
      // arm surveillance / engine-control, ou 503 "vizyo-texto injoignable". On le
      // logge en ERROR (toujours visible dans le centre d'alertes) sans gonfler le
      // compteur CRITICAL — sinon le centre d'alertes "crie au loup".
      const level: 'ERROR' | 'CRITICAL' =
        exception instanceof HttpException ? 'ERROR' : 'CRITICAL';
      await this.errorLogger.record(
        exception instanceof Error ? exception : new Error(String(exception)),
        'http',
        {
          requestId,
          route: `${req.method} ${req.url}`,
          userId: user?.id,
          userEmail: user?.email,
          fleetId: user?.fleetId ?? undefined,
          // Page frontend + session côté client (headers posés par l'intercepteur).
          page: str(headers['x-current-route'], 200),
          sessionId: str(headers['x-session-id'], 60),
          userAgent: str(headers['user-agent'], 300),
          ip: req.ip,
          statusCode: status,
        },
        level,
      );
    }

    this.logger.warn(
      { requestId, status, route: `${req.method} ${req.url}`, userId: user?.id },
      `${status} ${code}: ${message}`,
    );

    res.status(status).json({
      error: {
        code,
        message,
        requestId,
      },
    });
  }
}
