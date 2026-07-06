import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AgendaAgentSettingsService } from './agenda-agent-settings.service';

function makeUser(over: Record<string, unknown> = {}) {
  return { id: 'u1', role: UserRole.FLEET_ADMIN, fleetId: 'f1', ...over } as never;
}

function makePrisma(over: Record<string, unknown> = {}) {
  return {
    fleet: { findUnique: jest.fn().mockResolvedValue({ id: 'f1', name: 'CDEF', metier: 'CHILDREN_TRANSPORT' }) },
    agendaAgentSettings: {
      findUnique: jest.fn().mockResolvedValue(null),
      // upsert renvoie une ligne reflétant l'update (pour vérifier le mapping DTO).
      upsert: jest.fn().mockImplementation(({ update }: { update: Record<string, unknown> }) =>
        Promise.resolve({
          enabled: false, nightlyHour: 2, frequency: 'daily', autonomy: 'suggest',
          confidenceThreshold: 80, autoCompleteAfterReservation: false,
          triggerNightly: true, triggerIncident: true, triggerMaintenance: true,
          triggerReservation: false, lastRunAt: null, ...update,
        }),
      ),
    },
    ...over,
  } as never;
}

function makeAiUsage() {
  return { monthCostEur: jest.fn().mockResolvedValue(1.23) } as never;
}

describe('AgendaAgentSettingsService — ⚙️ Paramètres de l\'agenda (P2)', () => {
  it('get : super-admin SANS fleetId -> 400 (doit préciser la société)', async () => {
    const svc = new AgendaAgentSettingsService(makePrisma(), makeAiUsage());
    await expect(
      svc.get(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('get : non-super-admin visant une AUTRE société -> 403', async () => {
    const svc = new AgendaAgentSettingsService(makePrisma(), makeAiUsage());
    await expect(svc.get(makeUser({ fleetId: 'f1' }), 'fOTHER')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('get : renvoie les DÉFAUTS + métier + coût du mois quand jamais configuré', async () => {
    const svc = new AgendaAgentSettingsService(makePrisma(), makeAiUsage());
    const dto = await svc.get(makeUser());
    expect(dto).toMatchObject({
      fleetId: 'f1', fleetName: 'CDEF', enabled: false, nightlyHour: 2,
      frequency: 'daily', autonomy: 'suggest', confidenceThreshold: 80,
      metier: 'CHILDREN_TRANSPORT', monthCostEur: 1.23, lastRunAt: null,
    });
  });

  it('set : borne les champs et upsert avec l\'auteur', async () => {
    const prisma = makePrisma();
    const svc = new AgendaAgentSettingsService(prisma, makeAiUsage());
    await svc.set(makeUser(), { enabled: true, autonomy: 'auto_high_confidence', confidenceThreshold: 90, nightlyHour: 2 });
    const call = (prisma as unknown as { agendaAgentSettings: { upsert: jest.Mock } }).agendaAgentSettings.upsert.mock.calls[0][0];
    expect(call.update).toMatchObject({ enabled: true, autonomy: 'auto_high_confidence', confidenceThreshold: 90, updatedByUserId: 'u1' });
  });

  it('set : heure nocturne hors borne (0-23) -> 400', async () => {
    const svc = new AgendaAgentSettingsService(makePrisma(), makeAiUsage());
    await expect(svc.set(makeUser(), { nightlyHour: 30 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('set : autonomie invalide -> 400', async () => {
    const svc = new AgendaAgentSettingsService(makePrisma(), makeAiUsage());
    await expect(svc.set(makeUser(), { autonomy: 'wat' as never })).rejects.toBeInstanceOf(BadRequestException);
  });
});
