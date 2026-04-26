import { Test } from '@nestjs/testing';
import { CobanWireLogger } from '../observability/coban-wire-logger.service';
import { PrismaService } from '../prisma/prisma.service';
import { SocketRegistryService } from '../socket-registry/socket-registry.service';
import { TrackerFixModeService } from './tracker-fix-mode.service';

describe('TrackerFixModeService.intervalLabel', () => {
  it('formats sub-minute intervals with `s` suffix and zero-padding', () => {
    expect(TrackerFixModeService.intervalLabel(30)).toBe('030s');
    expect(TrackerFixModeService.intervalLabel(60)).toBe('001m');
    expect(TrackerFixModeService.intervalLabel(45)).toBe('045s');
  });

  it('formats minute-scale intervals with `m` suffix', () => {
    expect(TrackerFixModeService.intervalLabel(120)).toBe('002m');
    expect(TrackerFixModeService.intervalLabel(300)).toBe('005m');
  });
});

describe('TrackerFixModeService.buildDiagnosticHint', () => {
  const NOW = new Date('2026-04-26T12:00:00Z');

  it('returns null hint for normal first attempt', () => {
    const hint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: true,
      failureCount: 0,
      lastSeenAt: new Date(NOW.getTime() - 5_000),
      lastValidFrameAt: new Date(NOW.getTime() - 30_000),
      desiredIntervalS: 30,
      now: NOW,
    });
    expect(hint).toBeNull();
  });

  it('mentions GPRS coverage when offline > 1h', () => {
    const hint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: false,
      failureCount: 0,
      lastSeenAt: new Date(NOW.getTime() - 90 * 60_000),
      lastValidFrameAt: new Date(NOW.getTime() - 90 * 60_000),
      desiredIntervalS: 30,
      now: NOW,
    });
    expect(hint).toMatch(/offline/);
    expect(hint).toMatch(/GPRS/i);
  });

  it('escalates after 3 consecutive failures', () => {
    const hint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: true,
      failureCount: 3,
      lastSeenAt: new Date(NOW.getTime() - 1_000),
      lastValidFrameAt: new Date(NOW.getTime() - 1_000),
      desiredIntervalS: 30,
      now: NOW,
    });
    expect(hint).toMatch(/3 commandes/);
    expect(hint).toMatch(/RESET123456/);
  });

  it('warns about GPS occlusion when socket is healthy but no valid frame > 30min', () => {
    const hint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: true,
      failureCount: 0,
      lastSeenAt: new Date(NOW.getTime() - 1_000),
      lastValidFrameAt: new Date(NOW.getTime() - 45 * 60_000),
      desiredIntervalS: 30,
      now: NOW,
    });
    expect(hint).toMatch(/antenne GPS/);
  });

  it('flags first-time tracker (lastSeenAt null) when socket unavailable', () => {
    const hint = TrackerFixModeService.buildDiagnosticHint({
      sentViaSocket: false,
      failureCount: 0,
      lastSeenAt: null,
      lastValidFrameAt: null,
      desiredIntervalS: 30,
      now: NOW,
    });
    expect(hint).toMatch(/jamais vu/);
  });
});

describe('TrackerFixModeService.desiredIntervalFor', () => {
  let service: TrackerFixModeService;
  const NOW = new Date('2026-04-26T12:00:00Z');

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TrackerFixModeService,
        { provide: PrismaService, useValue: {} },
        { provide: SocketRegistryService, useValue: {} },
        { provide: CobanWireLogger, useValue: {} },
      ],
    }).compile();
    service = module.get(TrackerFixModeService);
  });

  it('returns 30s for MOVING regardless of ignition history', () => {
    expect(service.desiredIntervalFor('MOVING', { lastIgnitionChangeAt: null, lastKnownIgnition: false }, NOW))
      .toBe(30);
  });

  it('returns 30s for IDLE_ENGINE_ON', () => {
    expect(service.desiredIntervalFor('IDLE_ENGINE_ON', { lastIgnitionChangeAt: null, lastKnownIgnition: true }, NOW))
      .toBe(30);
  });

  it('keeps 30s for STOPPED when ignition was OFF less than 10 minutes ago', () => {
    const recentOff = new Date(NOW.getTime() - 5 * 60 * 1000);
    expect(service.desiredIntervalFor('STOPPED', { lastIgnitionChangeAt: recentOff, lastKnownIgnition: false }, NOW))
      .toBe(30);
  });

  it('switches to 300s for STOPPED when ignition has been OFF > 10 minutes', () => {
    const oldOff = new Date(NOW.getTime() - 15 * 60 * 1000);
    expect(service.desiredIntervalFor('STOPPED', { lastIgnitionChangeAt: oldOff, lastKnownIgnition: false }, NOW))
      .toBe(300);
  });

  it('keeps 30s for STOPPED when ignition history is unknown', () => {
    expect(service.desiredIntervalFor('STOPPED', { lastIgnitionChangeAt: null, lastKnownIgnition: null }, NOW))
      .toBe(30);
  });
});

describe('TrackerFixModeService.reconcile', () => {
  let service: TrackerFixModeService;
  const baseTracker = {
    desiredFixIntervalS: 30,
    currentFixIntervalS: null as number | null,
    fixCommandFailureCount: 0,
    lastValidFrameAt: null as Date | null,
    lastFixIntervalSyncAt: null as Date | null,
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        TrackerFixModeService,
        { provide: PrismaService, useValue: {} },
        { provide: SocketRegistryService, useValue: {} },
        { provide: CobanWireLogger, useValue: {} },
      ],
    }).compile();
    service = module.get(TrackerFixModeService);
  });

  it('returns no-op when there is no previous frame', () => {
    const out = service.reconcile(baseTracker, {
      deviceTime: new Date(),
      speedKmh: 0,
      ignition: false,
      lat: 48, lng: 2,
    });
    expect(out.nextCurrentFixIntervalS).toBe(null);
    expect(out.nextFailureCount).toBe(0);
    expect(out.nextFailing).toBe(false);
  });

  it('confirms current interval when delta is within ±20% of desired', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:32Z'); // 32s delta vs target 30s -> within 20%
    const out = service.reconcile(
      { ...baseTracker, desiredFixIntervalS: 30, lastValidFrameAt: prev },
      { deviceTime: next, speedKmh: 5, ignition: true, lat: 48, lng: 2 },
    );
    expect(out.nextCurrentFixIntervalS).toBe(32);
    expect(out.nextFailureCount).toBe(0);
    expect(out.nextFailing).toBe(false);
  });

  it('increments failure count when delta is outside tolerance and no recent sync', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:30Z'); // 30s observed but desired is 300s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        // sync was 10 minutes ago, well past the 2x300s grace
        lastFixIntervalSyncAt: new Date(prev.getTime() - 10 * 60 * 1000),
        fixCommandFailureCount: 1,
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    expect(out.nextFailureCount).toBe(2);
    expect(out.nextFailing).toBe(false);
  });

  it('flips fixCommandFailing to true after 3 consecutive misses', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:30Z');
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        lastFixIntervalSyncAt: new Date(prev.getTime() - 10 * 60 * 1000),
        fixCommandFailureCount: 2,
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    expect(out.nextFailureCount).toBe(3);
    expect(out.nextFailing).toBe(true);
  });

  it('does not increment failure count if a sync was recent (grace window)', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:00:30Z');
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        // sync 1 minute ago — well within 2 * 300s grace
        lastFixIntervalSyncAt: new Date(Date.now() - 60_000),
        fixCommandFailureCount: 1,
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    expect(out.nextFailureCount).toBe(1);
    expect(out.nextFailing).toBe(false);
  });

  it('resets failure count to 0 when convergence is observed', () => {
    const prev = new Date('2026-04-26T12:00:00Z');
    const next = new Date('2026-04-26T12:05:05Z'); // 305s ~ target 300s
    const out = service.reconcile(
      {
        ...baseTracker,
        desiredFixIntervalS: 300,
        lastValidFrameAt: prev,
        fixCommandFailureCount: 2,
      },
      { deviceTime: next, speedKmh: 0, ignition: false, lat: 48, lng: 2 },
    );
    expect(out.nextCurrentFixIntervalS).toBe(305);
    expect(out.nextFailureCount).toBe(0);
    expect(out.nextFailing).toBe(false);
  });
});
