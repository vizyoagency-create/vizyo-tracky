import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { AgendaAgentSettingsService } from './agenda-agent-settings.service';

function makeUser(over: Record<string, unknown> = {}) {
  return { id: 'u1', role: UserRole.FLEET_ADMIN, fleetId: 'f1', ...over } as never;
}

/**
 * Qui peut valider / qui est prevenu. INERTE dans cette suite : elle porte sur les REGLAGES de
 * l'agent (heure, frequence, autonomie, seuil), pas sur la liste des destinataires — laquelle a
 * ses propres tests. Un double vide est donc l'etat juste.
 */
const makeDestinataires = () => ({ possibles: jest.fn().mockResolvedValue([]), notifies: jest.fn().mockResolvedValue([]) } as never);

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
    const svc = new AgendaAgentSettingsService(makePrisma(), makeAiUsage(), makeDestinataires());
    await expect(
      svc.get(makeUser({ role: UserRole.SUPER_ADMIN, fleetId: null })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('get : non-super-admin visant une AUTRE société -> 403', async () => {
    const svc = new AgendaAgentSettingsService(makePrisma(), makeAiUsage(), makeDestinataires());
    await expect(svc.get(makeUser({ fleetId: 'f1' }), 'fOTHER')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('get : renvoie les DÉFAUTS + métier + coût du mois quand jamais configuré', async () => {
    const svc = new AgendaAgentSettingsService(makePrisma(), makeAiUsage(), makeDestinataires());
    const dto = await svc.get(makeUser());
    expect(dto).toMatchObject({
      fleetId: 'f1', fleetName: 'CDEF', enabled: false, nightlyHour: 2,
      frequency: 'daily', autonomy: 'suggest', confidenceThreshold: 80,
      metier: 'CHILDREN_TRANSPORT', monthCostEur: 1.23, lastRunAt: null,
    });
  });

  it('set : borne les champs et upsert avec l\'auteur', async () => {
    const prisma = makePrisma();
    const svc = new AgendaAgentSettingsService(prisma, makeAiUsage(), makeDestinataires());
    await svc.set(makeUser(), { enabled: true, autonomy: 'auto_high_confidence', confidenceThreshold: 90, nightlyHour: 2 });
    const call = (prisma as unknown as { agendaAgentSettings: { upsert: jest.Mock } }).agendaAgentSettings.upsert.mock.calls[0][0];
    expect(call.update).toMatchObject({ enabled: true, autonomy: 'auto_high_confidence', confidenceThreshold: 90, updatedByUserId: 'u1' });
  });

  it('set : heure nocturne hors borne (0-23) -> 400', async () => {
    const svc = new AgendaAgentSettingsService(makePrisma(), makeAiUsage(), makeDestinataires());
    await expect(svc.set(makeUser(), { nightlyHour: 30 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('set : autonomie invalide -> 400', async () => {
    const svc = new AgendaAgentSettingsService(makePrisma(), makeAiUsage(), makeDestinataires());
    await expect(svc.set(makeUser(), { autonomy: 'wat' as never })).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * ON NE COUPE PAS LE DERNIER DESTINATAIRE.
 *
 * Une demande de conducteur qui n'atteint personne reste en plan sans que quiconque le sache —
 * le même raisonnement que l'interrupteur des alertes d'exploitation, qui refuse de fermer ses
 * deux canaux. Couper volontairement TOUT le monde se fait en retirant `reservations_manage`,
 * un geste qui dit ce qu'il fait.
 */
describe('AgendaAgentSettingsService — destinataires de l’avis', () => {
  const cible = { id: 'u2', fleetId: 'f1', email: 'b@x.fr' };
  const prismaAvecCible = () =>
    ({
      user: { findUnique: jest.fn().mockResolvedValue(cible), update: jest.fn().mockResolvedValue({}) },
    }) as never;

  const destinataires = (comptes: { id: string; notifie: boolean }[]) =>
    ({
      possibles: jest.fn().mockResolvedValue(
        comptes.map((c) => ({ id: c.id, email: `${c.id}@x.fr`, role: 'FLEET_MANAGER', notifie: c.notifie })),
      ),
      notifies: jest.fn(),
    }) as never;

  it('refuse de couper le dernier destinataire, et dit pourquoi', async () => {
    const svc = new AgendaAgentSettingsService(
      prismaAvecCible(),
      makeAiUsage(),
      destinataires([{ id: 'u2', notifie: true }]),
    );
    await expect(svc.reglerAvis(makeUser(), { userId: 'u2', notifie: false })).rejects.toThrow(
      /dernier destinataire/i,
    );
  });

  it('laisse couper dès qu’il en reste un autre', async () => {
    const prisma = prismaAvecCible();
    const svc = new AgendaAgentSettingsService(
      prisma,
      makeAiUsage(),
      destinataires([
        { id: 'u2', notifie: true },
        { id: 'u3', notifie: true },
      ]),
    );
    await svc.reglerAvis(makeUser(), { userId: 'u2', notifie: false });
    expect((prisma as unknown as { user: { update: jest.Mock } }).user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reservationNoticeEnabled: false } }),
    );
  });

  /** ⚠️ Rallumer n'est JAMAIS refusé : le garde ne protège que du sens qui rend muet. */
  it('n’oppose aucun garde à la réactivation', async () => {
    const prisma = prismaAvecCible();
    const svc = new AgendaAgentSettingsService(
      prisma,
      makeAiUsage(),
      destinataires([{ id: 'u2', notifie: false }]),
    );
    await svc.reglerAvis(makeUser(), { userId: 'u2', notifie: true });
    expect((prisma as unknown as { user: { update: jest.Mock } }).user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { reservationNoticeEnabled: true } }),
    );
  });
});
