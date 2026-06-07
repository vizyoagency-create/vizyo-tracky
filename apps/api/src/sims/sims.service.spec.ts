import { BadRequestException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { UserRole } from '@prisma/client';
import { SIM_STATUS } from '@vizyo/tracky-shared';
import { PrismaService } from '../prisma/prisma.service';
import { SimsService } from './sims.service';
import { SimsSyncService } from './sims-sync.service';
import { WhereverSimClient } from './whereversim.client';

const FLEET_ID = '00000000-0000-0000-0000-000000000001';
const OTHER_FLEET = '00000000-0000-0000-0000-000000000099';
const SIM_ID = '00000000-0000-0000-0000-0000000000a1';
const TRACKER_ID = '00000000-0000-0000-0000-0000000000b1';
const USER_ID = '00000000-0000-0000-0000-0000000000c1';

const fleetAdmin = { userId: USER_ID, role: UserRole.FLEET_ADMIN, fleetId: FLEET_ID };
const superAdmin = { userId: USER_ID, role: UserRole.SUPER_ADMIN, fleetId: null };

const simRecord = (o: Record<string, unknown> = {}) => ({
  id: SIM_ID,
  iccid: '8934071000000000001',
  msisdn: '+33612345678',
  imsi: null,
  imei: null,
  provider: 'wherever-sim',
  providerId: 5,
  statusId: SIM_STATUS.ACTIVATED,
  statusLabel: 'Activée',
  apn: null,
  ipAddress: null,
  networkOperator: null,
  monthlyDataVolumeBytes: null,
  monthlyDataLimitBytes: null,
  prevMonthDataVolumeBytes: null,
  inSessionSince: null,
  activationAt: null,
  customField1: null,
  label: null,
  notes: null,
  fleetId: null,
  trackerId: null,
  fleet: null,
  tracker: null,
  externalSyncedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...o,
});

const trackerSel = (o: Record<string, unknown> = {}) => ({
  id: TRACKER_ID,
  imei: '123456789012345',
  simPhoneNumber: null,
  vehicle: { fleetId: FLEET_ID },
  sim: null,
  ...o,
});

describe('SimsService', () => {
  let service: SimsService;
  let prisma: any;
  let emit: jest.Mock;
  let client: { isConfigured: jest.Mock; updateSim: jest.Mock };
  let sync: { upsertRaw: jest.Mock; syncOne: jest.Mock; syncAll: jest.Mock };
  let txSim: { update: jest.Mock };
  let txTracker: { update: jest.Mock };

  beforeEach(async () => {
    txSim = { update: jest.fn().mockResolvedValue({}) };
    txTracker = { update: jest.fn().mockResolvedValue({}) };
    prisma = {
      sim: {
        findFirst: jest.fn().mockResolvedValue(simRecord()),
        findUnique: jest.fn().mockResolvedValue(simRecord()),
        findMany: jest.fn().mockResolvedValue([simRecord()]),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve(simRecord(data))),
        update: jest.fn().mockResolvedValue(simRecord()),
        delete: jest.fn().mockResolvedValue(undefined),
      },
      tracker: { findFirst: jest.fn().mockResolvedValue(trackerSel()), findUnique: jest.fn().mockResolvedValue(trackerSel()) },
      fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID }) },
      $transaction: jest.fn(async (cb: (tx: unknown) => unknown) => cb({ sim: txSim, tracker: txTracker })),
    };
    emit = jest.fn();
    client = { isConfigured: jest.fn().mockReturnValue(false), updateSim: jest.fn() };
    sync = { upsertRaw: jest.fn(), syncOne: jest.fn(), syncAll: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        SimsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventEmitter2, useValue: { emit } },
        { provide: WhereverSimClient, useValue: client },
        { provide: SimsSyncService, useValue: sync },
      ],
    }).compile();

    service = module.get(SimsService);
  });

  it('assigne une SIM : recopie le MSISDN sur le tracker, auto-alloue la flotte et emet tracker.sim-changed', async () => {
    prisma.sim.findFirst.mockResolvedValue(simRecord({ trackerId: null, fleetId: null, msisdn: '+33611112222' }));
    prisma.tracker.findFirst.mockResolvedValue(trackerSel({ simPhoneNumber: null }));

    await service.assign(SIM_ID, TRACKER_ID, fleetAdmin);

    expect(txSim.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { trackerId: TRACKER_ID, fleetId: FLEET_ID } }),
    );
    expect(txTracker.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { simPhoneNumber: '+33611112222' } }),
    );
    expect(emit).toHaveBeenCalledWith('tracker.sim-changed', expect.objectContaining({ trackerId: TRACKER_ID }));
  });

  it('refuse d\'assigner une SIM deja posee', async () => {
    prisma.sim.findFirst.mockResolvedValue(simRecord({ trackerId: '00000000-0000-0000-0000-0000000000ff' }));
    await expect(service.assign(SIM_ID, TRACKER_ID, fleetAdmin)).rejects.toThrow(BadRequestException);
  });

  it('refuse d\'assigner une SIM resiliee', async () => {
    prisma.sim.findFirst.mockResolvedValue(simRecord({ statusId: SIM_STATUS.RETIRED }));
    await expect(service.assign(SIM_ID, TRACKER_ID, fleetAdmin)).rejects.toThrow(/résiliée|supprimée/);
  });

  it('refuse d\'assigner si le tracker a deja une SIM', async () => {
    prisma.sim.findFirst.mockResolvedValue(simRecord({ trackerId: null }));
    prisma.tracker.findFirst.mockResolvedValue(trackerSel({ sim: { id: 'x', iccid: '8934070000000000000' } }));
    await expect(service.assign(SIM_ID, TRACKER_ID, fleetAdmin)).rejects.toThrow(BadRequestException);
  });

  it('detache une SIM et vide le n° du tracker s\'il vaut le MSISDN', async () => {
    prisma.sim.findFirst.mockResolvedValue(simRecord({ trackerId: TRACKER_ID, msisdn: '+33611112222' }));
    prisma.tracker.findUnique.mockResolvedValue({ id: TRACKER_ID, imei: '123456789012345', simPhoneNumber: '+33611112222' });

    await service.unassign(SIM_ID, fleetAdmin);

    expect(txSim.update).toHaveBeenCalledWith(expect.objectContaining({ data: { trackerId: null } }));
    expect(txTracker.update).toHaveBeenCalledWith(expect.objectContaining({ data: { simPhoneNumber: null } }));
    expect(emit).toHaveBeenCalledWith('tracker.sim-changed', expect.objectContaining({ trackerId: TRACKER_ID }));
  });

  it('detache une SIM sans toucher au n° si le tracker porte un autre numero', async () => {
    prisma.sim.findFirst.mockResolvedValue(simRecord({ trackerId: TRACKER_ID, msisdn: '+33611112222' }));
    prisma.tracker.findUnique.mockResolvedValue({ id: TRACKER_ID, imei: '123456789012345', simPhoneNumber: '+33699998888' });

    await service.unassign(SIM_ID, fleetAdmin);

    expect(txSim.update).toHaveBeenCalledWith(expect.objectContaining({ data: { trackerId: null } }));
    expect(txTracker.update).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it('scope la liste a la flotte pour un FLEET_ADMIN', async () => {
    await service.list(fleetAdmin);
    expect(prisma.sim.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ fleetId: FLEET_ID }) }),
    );
  });

  it('changer le statut appelle WhereverSIM updateSim puis upsert le cache', async () => {
    const raw = { iccid: '8934071000000000001', statusid: SIM_STATUS.SUSPENDED } as never;
    client.updateSim.mockResolvedValue(raw);
    await service.setStatus(SIM_ID, SIM_STATUS.SUSPENDED);
    expect(client.updateSim).toHaveBeenCalledWith({ iccid: '8934071000000000001', statusid: SIM_STATUS.SUSPENDED });
    expect(sync.upsertRaw).toHaveBeenCalledWith(raw);
  });

  it('import par lot : cree les valides, ignore doublons et ICCID invalides', async () => {
    const raw = [
      '8934071000000000001 +33600000001 Lot A',
      '8934071000000000001', // doublon dans la liste
      'XX-invalide',
      '8934071000000000002',
    ].join('\n');

    const result = await service.bulkCreate(raw);
    expect(result.created.length).toBe(2);
    expect(result.skipped.length).toBe(2);
    expect(result.skipped.some((s) => s.reason.includes('Doublon'))).toBe(true);
    expect(result.skipped.some((s) => s.reason.includes('invalide'))).toBe(true);
  });

  it('verifie que superAdmin voit tout (scope vide)', async () => {
    await service.list(superAdmin);
    expect(prisma.sim.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.not.objectContaining({ fleetId: expect.anything() }) }),
    );
  });
});
