import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import type { PrismaService } from '../prisma/prisma.service';
import type { SystemActivityService } from '../system-activity/system-activity.service';
import { PartnerWritebackService } from './partner-writeback.service';

const FLEET = 'fleet-1';
const LINK = 'link-1';

const VEHICLE = {
  id: 'veh-1',
  plate: 'AA-123-BB',
  brand: 'Renault Trucks',
  model: 'Master',
  year: 2021,
  energy: 'DIESEL',
};

function make(opts: { vehicle?: any } = {}) {
  const writes = { vehicle: null as any, event: null as any };
  const prisma = {
    vehicle: {
      findFirst: jest.fn(async () => ('vehicle' in opts ? opts.vehicle : VEHICLE)),
      update: jest.fn(async ({ data }: any) => {
        writes.vehicle = data;
        return {};
      }),
    },
    partnerLinkEvent: {
      create: jest.fn(async ({ data }: any) => {
        writes.event = data;
        return {};
      }),
    },
    $transaction: jest.fn(async (ops: any[]) => Promise.all(ops)),
  } as unknown as PrismaService;
  const activity = { record: jest.fn() } as unknown as SystemActivityService;

  return { service: new PartnerWritebackService(prisma, activity), prisma, activity, writes };
}

const BASE_INPUT = {
  fleetId: FLEET,
  linkId: LINK,
  vehicleId: 'veh-1',
  field: 'brand',
  value: 'Renault',
  expectedValue: 'Renault Trucks',
  resolutionId: 'c-1',
};

describe('writeback — la seule écriture entrante, bornée', () => {
  it('applique la valeur, journalise dans le LIEN (visible du client) et dans l\'activité', async () => {
    const { service, writes, activity } = make();
    const res = await service.apply(BASE_INPUT);

    expect(res.status).toBe('APPLIED');
    expect(writes.vehicle).toEqual({ brand: 'Renault' });
    // Le client a autorisé ce scope : il doit VOIR chaque usage dans son journal.
    expect(writes.event).toMatchObject({
      linkId: LINK,
      action: 'writeback_applied',
      actorType: 'PARTNER',
      scope: 'VEHICLE_WRITEBACK',
    });
    expect(activity.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'partner_writeback_applied', target: 'AA-123-BB' }),
    );
  });

  it.each([
    ['plate', 'BB-999-ZZ'],
    ['lastOdometerKm', 120000],
    ['fleetId', 'fleet-autre'],
    ['currentDriverId', 'x'],
  ])('⚠️ ALLOWLIST : le champ %s est REFUSÉ — jamais la plaque, jamais le mesuré, jamais l\'opérationnel', async (field, value) => {
    const { service, writes } = make();
    await expect(service.apply({ ...BASE_INPUT, field, value })).rejects.toBeInstanceOf(BadRequestException);
    expect(writes.vehicle).toBeNull();
  });

  it('⚠️ SCOPÉ PAR LA FLOTTE du jeton : un id de véhicule d\'une autre flotte ⇒ introuvable', async () => {
    // Le service cherche where { id, fleetId } : le mock renvoie null comme le
    // ferait Prisma pour un véhicule hors flotte. Aucun écrit.
    const { service, writes } = make({ vehicle: null });
    await expect(service.apply(BASE_INPUT)).rejects.toBeInstanceOf(NotFoundException);
    expect(writes.vehicle).toBeNull();
  });

  it('CAS : la valeur a changé depuis la détection ⇒ 409, rien n\'est écrit', async () => {
    const { service, writes } = make({ vehicle: { ...VEHICLE, brand: 'MAN' } });
    await expect(service.apply(BASE_INPUT)).rejects.toBeInstanceOf(ConflictException);
    expect(writes.vehicle).toBeNull();
  });

  it('valeur déjà en place ⇒ ALREADY_APPLIED, idempotent, l\'audit ne gonfle pas', async () => {
    const { service, writes } = make({ vehicle: { ...VEHICLE, brand: 'Renault' } });
    const res = await service.apply(BASE_INPUT);
    expect(res.status).toBe('ALREADY_APPLIED');
    expect(writes.vehicle).toBeNull();
    expect(writes.event).toBeNull();
  });

  it('énergie inconnue ⇒ refus — le JSON du fil ne fait pas foi', async () => {
    const { service } = make();
    await expect(
      service.apply({ ...BASE_INPUT, field: 'energy', value: 'PLUTONIUM', expectedValue: 'DIESEL' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('année hors bornes ⇒ refus', async () => {
    const { service } = make();
    await expect(
      service.apply({ ...BASE_INPUT, field: 'year', value: 19999, expectedValue: 2021 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
