import type { PrismaService } from '../prisma/prisma.service';
import type { AuthUser } from '../auth/types/auth-user';
import { GpsDiagnosticService } from './gps-diagnostic.service';

/**
 * Ce que ces tests protegent : deux comportements qui ne se voient PAS a la relecture, et dont
 * l'un s'est deja trompe une premiere fois.
 *
 *  1. L'ordre. Postgres range les NULL en DERNIER sur un tri ascendant. Ecrire
 *     `orderBy: { traiteAt: 'asc' }` — ce qui se lit tres bien — enterrerait les diagnostics NON
 *     TRAITES sous l'archive. L'ecran s'ouvrirait sur ce qui est deja regle.
 *  2. La note. Une reouverture n'envoie pas de note ; ecraser par `null` detruirait sans retour
 *     ce qu'un humain avait constate sur place.
 */

const ligne = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'z1',
  createdAt: new Date('2026-08-20T10:00:00Z'),
  updatedAt: new Date('2026-08-20T10:00:00Z'),
  lat: 43.5979,
  lng: 1.43,
  placeLabel: 'Toulouse',
  fleetId: 'f1',
  vehicules: ['AA-111-AA', 'BB-222-BB'],
  episodes: 2,
  etalementM: 2,
  constat: 'constat',
  recommandation: 'recommandation',
  traiteAt: null as Date | null,
  traiteParUserId: null as string | null,
  note: null as string | null,
  ...over,
});

function fabrique() {
  const findMany = jest.fn().mockResolvedValue([ligne()]);
  const findUnique = jest.fn().mockResolvedValue(ligne());
  const update = jest.fn().mockResolvedValue(ligne());
  const prisma = {
    gpsZoneDiagnostic: { findMany, findUnique, update },
    fleet: { findMany: jest.fn().mockResolvedValue([{ id: 'f1', name: 'Societe A' }]) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'u1', email: 'admin@vizyo.fr' }]) },
  } as unknown as PrismaService;
  return { service: new GpsDiagnosticService(prisma), findMany, findUnique, update };
}

const utilisateur = { id: 'u1', email: 'admin@vizyo.fr' } as unknown as AuthUser;

describe('GpsDiagnosticService', () => {
  it('demande explicitement les NULL en tete, sinon les non traites passent sous l archive', async () => {
    const { service, findMany } = fabrique();
    await service.liste();
    expect(findMany.mock.calls[0][0].orderBy[0]).toEqual({
      traiteAt: { sort: 'asc', nulls: 'first' },
    });
  });

  it('ne renvoie que les non traites par defaut', async () => {
    const { service, findMany } = fabrique();
    await service.liste();
    expect(findMany.mock.calls[0][0].where).toEqual({ traiteAt: null });
  });

  it('inclut l archive quand on le demande, et filtre par societe quand on la precise', async () => {
    const { service, findMany } = fabrique();
    await service.liste('f1', true);
    expect(findMany.mock.calls[0][0].where).toEqual({ fleetId: 'f1' });
  });

  it('n ecrase PAS la note quand la reouverture n en fournit pas', async () => {
    const { service, update } = fabrique();
    await service.traiter(utilisateur, 'z1', { traite: false });
    expect(update.mock.calls[0][0].data).toEqual({ traiteAt: null, traiteParUserId: null });
  });

  it('enregistre la note et le relecteur quand on marque traite', async () => {
    const { service, update } = fabrique();
    await service.traiter(utilisateur, 'z1', { note: '  parking couvert  ' });
    const data = update.mock.calls[0][0].data;
    expect(data.note).toBe('parking couvert');
    expect(data.traiteParUserId).toBe('u1');
    expect(data.traiteAt).toBeInstanceOf(Date);
  });

  it('une note vide vaut absence de note, pas une chaine vide en base', async () => {
    const { service, update } = fabrique();
    await service.traiter(utilisateur, 'z1', { note: '   ' });
    expect(update.mock.calls[0][0].data.note).toBeNull();
  });

  it('resout le nom de societe et l email du relecteur', async () => {
    const { service, findMany } = fabrique();
    findMany.mockResolvedValue([
      ligne({ traiteAt: new Date('2026-08-20T12:00:00Z'), traiteParUserId: 'u1', note: 'vu' }),
    ]);
    const [dto] = await service.liste(undefined, true);
    expect(dto.fleetName).toBe('Societe A');
    expect(dto.traiteParEmail).toBe('admin@vizyo.fr');
    expect(dto.traiteAt).toBe('2026-08-20T12:00:00.000Z');
  });

  it('refuse de traiter un diagnostic qui n existe pas', async () => {
    const { service, findUnique } = fabrique();
    findUnique.mockResolvedValue(null);
    await expect(service.traiter(utilisateur, 'inconnu', {})).rejects.toThrow('introuvable');
  });
});
