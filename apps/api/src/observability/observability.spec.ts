import { HttpException, HttpStatus, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { AllExceptionsFilter } from './all-exceptions.filter';
import { CobanWireLogger } from './coban-wire-logger.service';
import { ErrorLogger } from './error-logger.service';
import { LogCleanupService } from './log-cleanup.service';
import { PrismaService } from '../prisma/prisma.service';

describe('ErrorLogger', () => {
  let errorLogger: ErrorLogger;
  let prisma: { errorLog: { create: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      errorLog: {
        create: jest.fn().mockResolvedValue({ id: 'err-1' }),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        ErrorLogger,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    errorLogger = module.get(ErrorLogger);
  });

  it('should persist error with source and context', async () => {
    const id = await errorLogger.record(
      new Error('Test error'),
      'tcp-server',
      { imei: '123456789012345', commandId: 'cmd-1' },
    );
    expect(id).toBe('err-1');
    expect(prisma.errorLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        level: 'ERROR',
        source: 'tcp-server',
        message: 'Test error',
        imei: '123456789012345',
        commandId: 'cmd-1',
      }),
    });
  });

  it('should persist string errors', async () => {
    await errorLogger.record('String error', 'http');
    expect(prisma.errorLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        message: 'String error',
        stack: null,
      }),
    });
  });

  it('should handle DB failure gracefully', async () => {
    prisma.errorLog.create.mockRejectedValue(new Error('DB down'));
    const id = await errorLogger.record(new Error('oops'), 'test');
    expect(id).toBe('persist-failed');
  });

  it('should support CRITICAL level', async () => {
    await errorLogger.record(new Error('critical'), 'http', {}, 'CRITICAL');
    expect(prisma.errorLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ level: 'CRITICAL' }),
    });
  });
});

describe('CobanWireLogger', () => {
  let wireLogger: CobanWireLogger;
  let prisma: { wireLog: { create: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      wireLog: {
        create: jest.fn().mockResolvedValue({ id: 'wire-1' }),
      },
    };
    const module = await Test.createTestingModule({
      providers: [
        CobanWireLogger,
        { provide: PrismaService, useValue: prisma },
        { provide: ErrorLogger, useValue: { record: jest.fn().mockResolvedValue('id') } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('true') },
        },
      ],
    }).compile();
    wireLogger = module.get(CobanWireLogger);
  });

  it('should persist IN frame when WIRE_LOG_ENABLED=true', () => {
    wireLogger.in('123456789012345', '##,imei:123456789012345,A', 'login');
    expect(prisma.wireLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        imei: '123456789012345',
        direction: 'IN',
        frameType: 'login',
      }),
    });
  });

  it('should persist OUT frame with commandId', () => {
    wireLogger.out('123456789012345', '**,imei:123456789012345,J;', {
      commandId: 'cmd-1',
      source: 'engine',
    });
    expect(prisma.wireLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        direction: 'OUT',
        commandId: 'cmd-1',
      }),
    });
  });

  it('should persist ACK match with latency', () => {
    wireLogger.ackMatch('123456789012345', 'reset ok', 'cmd-2', 1500);
    expect(prisma.wireLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        frameType: 'ack',
        commandId: 'cmd-2',
        context: { latencyMs: 1500 },
      }),
    });
  });

  it('should persist ACK timeout', () => {
    wireLogger.ackTimeout('123456789012345', 'cmd-3', '/reset ok/i', 15000);
    expect(prisma.wireLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        commandId: 'cmd-3',
        context: { elapsedMs: 15000 },
      }),
    });
  });
});

describe('CobanWireLogger (disabled)', () => {
  let wireLogger: CobanWireLogger;
  let prisma: { wireLog: { create: jest.Mock } };

  beforeEach(async () => {
    prisma = {
      wireLog: { create: jest.fn() },
    };
    const module = await Test.createTestingModule({
      providers: [
        CobanWireLogger,
        { provide: PrismaService, useValue: prisma },
        { provide: ErrorLogger, useValue: { record: jest.fn().mockResolvedValue('id') } },
        {
          provide: ConfigService,
          useValue: { get: jest.fn().mockReturnValue('false') },
        },
      ],
    }).compile();
    wireLogger = module.get(CobanWireLogger);
  });

  it('should NOT persist when WIRE_LOG_ENABLED=false', () => {
    wireLogger.in('123456789012345', '##,imei:123456789012345,A', 'login');
    expect(prisma.wireLog.create).not.toHaveBeenCalled();
  });
});

describe('AllExceptionsFilter', () => {
  let filter: AllExceptionsFilter;
  let errorLoggerMock: { record: jest.Mock };
  let mockResponse: { status: jest.Mock; json: jest.Mock };
  let mockRequest: Record<string, unknown>;

  beforeEach(() => {
    errorLoggerMock = { record: jest.fn().mockResolvedValue('err-id') };
    filter = new AllExceptionsFilter(errorLoggerMock as any);
    mockResponse = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    mockRequest = { method: 'POST', url: '/api/test', user: { id: 'user-1' } };
  });

  function createHost() {
    return {
      switchToHttp: () => ({
        getResponse: () => mockResponse,
        getRequest: () => mockRequest,
      }),
    } as any;
  }

  it('should format HttpException as error response with requestId', async () => {
    await filter.catch(new NotFoundException('Not found'), createHost());
    expect(mockResponse.status).toHaveBeenCalledWith(404);
    expect(mockResponse.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        message: 'Not found',
        requestId: expect.any(String),
      }),
    });
  });

  it('should persist 500 errors to ErrorLog', async () => {
    await filter.catch(new Error('Boom'), createHost());
    expect(errorLoggerMock.record).toHaveBeenCalledWith(
      expect.any(Error),
      'http',
      expect.objectContaining({
        route: 'POST /api/test',
        userId: 'user-1',
        statusCode: 500,
      }),
      'CRITICAL',
    );
    expect(mockResponse.status).toHaveBeenCalledWith(500);
  });

  it('should persist deliberately-thrown 5xx (HttpException) at ERROR, not CRITICAL', async () => {
    await filter.catch(
      new ServiceUnavailableException('Tracker hors ligne, commande non envoyée'),
      createHost(),
    );
    expect(errorLoggerMock.record).toHaveBeenCalledWith(
      expect.any(Error),
      'http',
      expect.objectContaining({ statusCode: 503 }),
      'ERROR',
    );
    expect(mockResponse.status).toHaveBeenCalledWith(503);
  });

  it('should NOT persist 4xx errors to ErrorLog', async () => {
    await filter.catch(new NotFoundException('nope'), createHost());
    expect(errorLoggerMock.record).not.toHaveBeenCalled();
  });
});

describe('LogCleanupService', () => {
  let cleanupService: LogCleanupService;
  let prisma: {
    wireLog: { deleteMany: jest.Mock };
    errorLog: { deleteMany: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      wireLog: { deleteMany: jest.fn().mockResolvedValue({ count: 5 }) },
      errorLog: { deleteMany: jest.fn().mockResolvedValue({ count: 2 }) },
    };
    const module = await Test.createTestingModule({
      providers: [
        LogCleanupService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    cleanupService = module.get(LogCleanupService);
  });

  it('should delete wire logs older than 7 days', async () => {
    await cleanupService.cleanupLogs();
    expect(prisma.wireLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
    });
    const threshold = prisma.wireLog.deleteMany.mock.calls[0][0].where.createdAt.lt;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(threshold.getTime() - sevenDaysAgo)).toBeLessThan(1000);
  });

  it('should delete error logs older than 30 days', async () => {
    await cleanupService.cleanupLogs();
    expect(prisma.errorLog.deleteMany).toHaveBeenCalledWith({
      where: { createdAt: { lt: expect.any(Date) } },
    });
    const threshold = prisma.errorLog.deleteMany.mock.calls[0][0].where.createdAt.lt;
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    expect(Math.abs(threshold.getTime() - thirtyDaysAgo)).toBeLessThan(1000);
  });
});
