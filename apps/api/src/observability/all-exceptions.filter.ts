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

    const user = (req as any).user;

    if (status >= 500 || !(exception instanceof HttpException)) {
      await this.errorLogger.record(
        exception instanceof Error ? exception : new Error(String(exception)),
        'http',
        {
          requestId,
          route: `${req.method} ${req.url}`,
          userId: user?.id,
          statusCode: status,
        },
        'CRITICAL',
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
