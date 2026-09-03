/**
 * Traçabilité des exports — un échec doit laisser une trace, comme une réussite.
 *
 * ⚠️ Pourquoi ce test existe : `recordExport` n'était appelé qu'APRÈS l'envoi du fichier.
 * Un export refusé (droits, période invalide, base indisponible) n'inscrivait donc rien :
 * le client voyait un bandeau rouge, l'espace admin ne voyait rien du tout, et une société
 * incapable de sortir ses rapports depuis trois jours restait invisible.
 *
 * On vérifie aussi que la société est renseignée : un journal sans flotte échappe au filtre
 * par société du Journal Système, donc à toute recherche.
 */
import { UserRole } from '@prisma/client';
import { ReportsController } from './reports.controller';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';

const FLEET_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function requete(): AuthenticatedRequest {
  return {
    user: {
      id: 'user-1', authUserId: 'auth-1', email: 'chef@societe.fr',
      firstName: 'Ada', lastName: 'Lovelace', role: UserRole.FLEET_ADMIN,
      fleetId: FLEET_ID, isActive: true, isOwner: false, permissions: null,
    },
  } as unknown as AuthenticatedRequest;
}

/** Réponse Express minimale : on ne teste pas le transport, seulement le journal. */
function reponse() {
  return { setHeader: jest.fn(), send: jest.fn() } as never;
}

function construire(opts: { csvEchoue?: boolean } = {}) {
  const record = jest.fn();
  const csv = {
    trips: opts.csvEchoue
      ? jest.fn().mockRejectedValue(new Error('base indisponible'))
      : jest.fn().mockResolvedValue({ filename: 'tracky-trips.csv', contentType: 'text/csv', body: 'a;b' }),
  } as never;
  const prisma = {
    fleet: { findFirst: jest.fn().mockResolvedValue({ id: FLEET_ID }) },
    vehicle: { findUnique: jest.fn().mockResolvedValue({ fleetId: FLEET_ID }), findMany: jest.fn().mockResolvedValue([]) },
    trip: { findUnique: jest.fn().mockResolvedValue({ vehicle: { fleetId: FLEET_ID } }) },
  } as never;
  const vehicleAccess = { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') } as never;
  const controller = new ReportsController(
    {} as never, {} as never, csv, {} as never, {} as never, {} as never,
    prisma, vehicleAccess, { record } as never,
  );
  return { controller, record };
}

describe('Exports — journal des échecs', () => {
  it('un export CSV en échec inscrit une trace FAILURE avec la raison et la société', async () => {
    const { controller, record } = construire({ csvEchoue: true });

    await expect(
      controller.csvDownload(requete(), reponse(), 'trips', FLEET_ID, '2026-08-01', '2026-09-01'),
    ).rejects.toThrow('base indisponible');

    expect(record).toHaveBeenCalledTimes(1);
    const trace = record.mock.calls[0]![0] as Record<string, unknown>;
    expect(trace['category']).toBe('EXPORT');
    expect(trace['action']).toBe('export_csv_trips');
    expect(trace['status']).toBe('FAILURE');
    expect(trace['fleetId']).toBe(FLEET_ID);
    expect(String(trace['target'])).toContain('base indisponible');
  });

  it('un type de CSV inconnu est refusé ET journalisé — pas seulement rejeté', async () => {
    const { controller, record } = construire();

    await expect(
      controller.csvDownload(requete(), reponse(), 'inconnu', FLEET_ID, '2026-08-01', '2026-09-01'),
    ).rejects.toThrow();

    expect(record).toHaveBeenCalledTimes(1);
    expect((record.mock.calls[0]![0] as Record<string, unknown>)['status']).toBe('FAILURE');
  });

  it('un export réussi reste journalisé en SUCCESS, avec le nom du fichier', async () => {
    const { controller, record } = construire();

    await controller.csvDownload(requete(), reponse(), 'trips', FLEET_ID, '2026-08-01', '2026-09-01');

    expect(record).toHaveBeenCalledTimes(1);
    const trace = record.mock.calls[0]![0] as Record<string, unknown>;
    expect(trace['status']).toBe('SUCCESS');
    expect(trace['target']).toBe('tracky-trips.csv');
    expect(trace['fleetId']).toBe(FLEET_ID);
  });
});
