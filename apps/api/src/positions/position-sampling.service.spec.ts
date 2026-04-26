import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { PositionSamplingService } from './position-sampling.service';

const TRACKER_ID = '00000000-0000-0000-0000-000000000010';
const NOW = new Date('2026-04-26T12:00:00Z').getTime();

function makeTracker(overrides: Partial<{
  lastWriteAt: Date | null;
  lastSampledState: string | null;
  verboseUntil: Date | null;
}> = {}) {
  return {
    lastWriteAt: null,
    lastSampledState: null,
    verboseUntil: null,
    ...overrides,
  };
}

describe('PositionSamplingService.classify', () => {
  let service: PositionSamplingService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        PositionSamplingService,
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();
    service = module.get(PositionSamplingService);
  });

  it('returns MOVING when speed > 3 km/h', () => {
    const out = service.classify({
      speedKmh: 25,
      ignition: true,
      lat: 48.85, lng: 2.35, prevLat: 48.85, prevLng: 2.35,
    });
    expect(out.state).toBe('MOVING');
  });

  it('returns MOVING when haversine > 15m even at low speed (GPS jitter beyond)', () => {
    // 48.8500 -> 48.8503 ~ 33m
    const out = service.classify({
      speedKmh: 0,
      ignition: false,
      lat: 48.8503,
      lng: 2.3500,
      prevLat: 48.8500,
      prevLng: 2.3500,
    });
    expect(out.state).toBe('MOVING');
    expect(out.distanceM).toBeGreaterThan(15);
  });

  it('returns IDLE_ENGINE_ON when stopped with ignition true', () => {
    const out = service.classify({
      speedKmh: 0,
      ignition: true,
      lat: 48.85, lng: 2.35, prevLat: 48.85, prevLng: 2.35,
    });
    expect(out.state).toBe('IDLE_ENGINE_ON');
  });

  it('returns STOPPED when ignition is false', () => {
    const out = service.classify({
      speedKmh: 0,
      ignition: false,
      lat: 48.85, lng: 2.35, prevLat: 48.85, prevLng: 2.35,
    });
    expect(out.state).toBe('STOPPED');
  });

  it('handles missing previous coordinates (first frame)', () => {
    const out = service.classify({
      speedKmh: 5, ignition: true,
      lat: 48.85, lng: 2.35, prevLat: null, prevLng: null,
    });
    expect(out.state).toBe('MOVING');
    expect(out.distanceM).toBeNull();
  });

  it('returns STOPPED when GPS jitter < 15m and speed = 0', () => {
    // 48.8500 -> 48.85005 ~ 5m
    const out = service.classify({
      speedKmh: 0, ignition: false,
      lat: 48.85005, lng: 2.35, prevLat: 48.85, prevLng: 2.35,
    });
    expect(out.state).toBe('STOPPED');
    expect(out.distanceM).toBeLessThan(15);
  });
});

describe('PositionSamplingService.decide', () => {
  let service: PositionSamplingService;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      providers: [
        PositionSamplingService,
        { provide: PrismaService, useValue: {} },
      ],
    }).compile();
    service = module.get(PositionSamplingService);
  });

  it('forces INSERT when verbose mode is active', () => {
    const tracker = makeTracker({ verboseUntil: new Date(NOW + 60_000) });
    const out = service.decide(tracker, 'STOPPED', 0, true, NOW);
    expect(out.shouldInsert).toBe(true);
    expect(out.decision).toBe('INSERTED_VERBOSE');
  });

  it('forces INSERT when fleet has adaptive sampling disabled', () => {
    const tracker = makeTracker({ lastWriteAt: new Date(NOW - 1000) });
    const out = service.decide(tracker, 'STOPPED', 0, false, NOW);
    expect(out.shouldInsert).toBe(true);
    expect(out.decision).toBe('INSERTED');
    expect(out.reason).toMatch(/desactive/);
  });

  it('forces INSERT for the very first frame (no lastWriteAt)', () => {
    const tracker = makeTracker({ lastWriteAt: null });
    const out = service.decide(tracker, 'STOPPED', 0, true, NOW);
    expect(out.shouldInsert).toBe(true);
    expect(out.reason).toMatch(/premiere/);
  });

  it('forces INSERT on state transition (STOPPED -> MOVING)', () => {
    const tracker = makeTracker({
      lastWriteAt: new Date(NOW - 1000),
      lastSampledState: 'STOPPED',
    });
    const out = service.decide(tracker, 'MOVING', 5, true, NOW);
    expect(out.shouldInsert).toBe(true);
    expect(out.reason).toContain('STOPPED -> MOVING');
  });

  it('always INSERT when MOVING (even within throttle window)', () => {
    const tracker = makeTracker({
      lastWriteAt: new Date(NOW - 5_000),
      lastSampledState: 'MOVING',
    });
    const out = service.decide(tracker, 'MOVING', 30, true, NOW);
    expect(out.shouldInsert).toBe(true);
  });

  it('SKIP when STOPPED and last write < 5min ago', () => {
    const tracker = makeTracker({
      lastWriteAt: new Date(NOW - 60_000),
      lastSampledState: 'STOPPED',
    });
    const out = service.decide(tracker, 'STOPPED', 2, true, NOW);
    expect(out.shouldInsert).toBe(false);
    expect(out.decision).toBe('SKIPPED_THROTTLE');
  });

  it('INSERT when STOPPED and last write > 5min ago', () => {
    const tracker = makeTracker({
      lastWriteAt: new Date(NOW - 6 * 60_000),
      lastSampledState: 'STOPPED',
    });
    const out = service.decide(tracker, 'STOPPED', 2, true, NOW);
    expect(out.shouldInsert).toBe(true);
    expect(out.decision).toBe('INSERTED');
  });

  it('SKIP when IDLE_ENGINE_ON and last write < 90s ago', () => {
    const tracker = makeTracker({
      lastWriteAt: new Date(NOW - 30_000),
      lastSampledState: 'IDLE_ENGINE_ON',
    });
    const out = service.decide(tracker, 'IDLE_ENGINE_ON', 2, true, NOW);
    expect(out.shouldInsert).toBe(false);
  });

  it('INSERT when IDLE_ENGINE_ON and last write > 90s ago', () => {
    const tracker = makeTracker({
      lastWriteAt: new Date(NOW - 120_000),
      lastSampledState: 'IDLE_ENGINE_ON',
    });
    const out = service.decide(tracker, 'IDLE_ENGINE_ON', 2, true, NOW);
    expect(out.shouldInsert).toBe(true);
  });
});
