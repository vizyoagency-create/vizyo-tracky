/**
 * ══ LES DEUX ROUTES DE NOTATION LISENT LA MÊME LISTE DE PORTÉES ═══════════════════════
 *
 * La 4ᵉ portée (`attribution`, « conducteur, sinon groupe ») avait été ajoutée à `/scores`
 * sans l'être à `/scores/:scope/:id` : la fiche de détail d'une ligne de ce classement aurait
 * silencieusement répondu la note VÉHICULE d'un identifiant qui n'en est pas un. Depuis, une
 * seule fonction (`parseScope`) tranche pour les deux routes.
 */
import { UserRole } from '@prisma/client';
import { parseScope, PORTEES_NOTATION, TripAnalysisController } from './trip-analysis.controller';

describe('Portées de notation — /scores et /scores/:scope/:id', () => {
  const scores = { scores: jest.fn().mockResolvedValue({}), entityScore: jest.fn().mockResolvedValue({}) };
  const controller = new TripAnalysisController({} as never, {} as never, scores as never, {} as never, {} as never, {} as never);
  const req = { user: { id: 'u', role: UserRole.FLEET_ADMIN, fleetId: 'f1' } } as never;

  beforeEach(() => jest.clearAllMocks());

  it('accepte « attribution » sur les DEUX routes', async () => {
    await controller.getScores(req, 'attribution');
    expect(scores.scores.mock.calls[0][1]).toBe('attribution');

    await controller.getEntityScore(req, 'attribution', 'group:g1');
    expect(scores.entityScore.mock.calls[0][1]).toBe('attribution');
    expect(scores.entityScore.mock.calls[0][2]).toBe('group:g1');
  });

  it('retombe sur « vehicle » pour une portée inconnue ou absente', async () => {
    expect(parseScope('conducteur')).toBe('vehicle');
    expect(parseScope(undefined)).toBe('vehicle');
    expect(parseScope('')).toBe('vehicle');
    await controller.getScores(req);
    expect(scores.scores.mock.calls[0][1]).toBe('vehicle');
  });

  it('accepte exactement les portées du contrat partagé', () => {
    expect(PORTEES_NOTATION).toEqual(['vehicle', 'driver', 'group', 'attribution']);
    for (const p of PORTEES_NOTATION) expect(parseScope(p)).toBe(p);
  });
});
