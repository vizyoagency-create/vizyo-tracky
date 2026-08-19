import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { AssistanceContextService } from './assistance-context.service';

/**
 * Assistance IA — CLOISONNEMENT.
 *
 * L'agent lit des données réelles (activité, erreurs, véhicules, trajets) pour répondre. Ce
 * fichier ne teste pas « est-ce que ça renvoie quelque chose » : il verrouille les propriétés
 * qui empêchent une fuite entre comptes et entre sociétés.
 *
 * La propriété centrale : **le modèle ne fournit jamais d'identifiant.** Il choisit des clés dans
 * une liste fermée ; tous les `userId` / `fleetId` / `vehicleId` viennent du serveur. Ces tests
 * vérifient donc surtout ce qui est ENVOYÉ à Prisma, pas ce qui en revient — c'est le filtre qui
 * protège, et c'est lui qu'une régression casserait en silence.
 */
describe('AssistanceContextService — cloisonnement', () => {
  const DEMANDEUR = 'user-demandeur';
  const AUTRE = 'user-autre-societe';

  function build(opts: {
    role?: UserRole;
    fleetId?: string | null;
    accessibles?: string[] | 'ALL';
    tripsView?: boolean;
  } = {}) {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          role: opts.role ?? UserRole.DRIVER,
          createdAt: new Date('2026-01-01'),
          isActive: true,
          fleet: { name: 'Ma societe', metier: 'GENERIC', aiEnabled: true },
        }),
      },
      userSession: { count: jest.fn().mockResolvedValue(3) },
      userActivity: { groupBy: jest.fn().mockResolvedValue([]) },
      errorLog: { findMany: jest.fn().mockResolvedValue([]) },
      vehicle: { findMany: jest.fn().mockResolvedValue([]) },
      trip: { findMany: jest.fn().mockResolvedValue([]) },
      tripAnalysis: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const vehicleAccess = {
      getAccessibleVehicleIds: jest.fn().mockResolvedValue(opts.accessibles ?? ['v1', 'v2']),
    };
    const permissions = {
      resolveGlobal: jest.fn().mockResolvedValue({ trips_view: opts.tripsView ?? true }),
    };
    const svc = new AssistanceContextService(prisma as never, vehicleAccess as never, permissions as never);
    const user: AuthUser = {
      id: DEMANDEUR,
      authUserId: 'auth-1',
      email: 'demandeur@exemple.fr',
      firstName: null,
      lastName: null,
      role: opts.role ?? UserRole.DRIVER,
      isOwner: false,
      fleetId: opts.fleetId === undefined ? 'fleet-a' : opts.fleetId,
      isActive: true,
      permissions: null,
    };
    return { svc, prisma, vehicleAccess, permissions, user };
  }

  // ─── La liste est fermée ───────────────────────────────────────────────────

  it('ignore une clé inventée par le modèle, sans lancer la moindre requête', async () => {
    const { svc, prisma, user } = build();
    const lots = await svc.build(user, ['tout', 'users', 'fleets', '../../etc/passwd']);
    expect(lots).toEqual([]);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
    expect(prisma.errorLog.findMany).not.toHaveBeenCalled();
  });

  it('ne construit que les lots demandés, une seule fois même si la clé est répétée', async () => {
    const { svc, user } = build();
    const lots = await svc.build(user, ['compte', 'compte', 'erreurs']);
    expect(lots.map((l) => l.key)).toEqual(['compte', 'erreurs']);
  });

  // ─── Aucun identifiant ne vient du modèle ──────────────────────────────────

  it('les erreurs sont filtrées sur le DEMANDEUR, pas sur un id venu de la question', async () => {
    const { svc, prisma, user } = build();
    await svc.build(user, ['erreurs']);
    const where = prisma.errorLog.findMany.mock.calls[0][0].where;
    expect(where.userId).toBe(DEMANDEUR);
    // La signature ne prend aucun identifiant : il n'y a rien à détourner. On le verrouille
    // ici pour qu'un futur paramètre « pratique » ne passe pas inaperçu en revue.
    expect(JSON.stringify(where)).not.toContain(AUTRE);
  });

  it('l\'activité est filtrée sur le DEMANDEUR', async () => {
    const { svc, prisma, user } = build();
    await svc.build(user, ['activite']);
    for (const call of prisma.userActivity.groupBy.mock.calls) {
      expect(call[0].where.userId).toBe(DEMANDEUR);
    }
    expect(prisma.userSession.count.mock.calls[0][0].where.userId).toBe(DEMANDEUR);
  });

  it('le compte lu est celui de la session, jamais un autre', async () => {
    const { svc, prisma, user } = build();
    await svc.build(user, ['compte']);
    expect(prisma.user.findUnique.mock.calls[0][0].where).toEqual({ id: DEMANDEUR });
  });

  // ─── Périmètre société : fail-closed ───────────────────────────────────────

  it('un non-super-admin SANS société ne voit aucun véhicule (fail-closed, pas « toutes »)', async () => {
    const { svc, prisma, user } = build({ fleetId: null });
    const [lot] = await svc.build(user, ['vehicules']);
    expect(prisma.vehicle.findMany).not.toHaveBeenCalled();
    expect(lot.data).toBeNull();
    expect(lot.refus).toBeTruthy();
  });

  it('un non-super-admin voit ses véhicules filtrés PAR SA SOCIÉTÉ et par ses accès', async () => {
    const { svc, prisma, user } = build({ accessibles: ['v1'] });
    await svc.build(user, ['vehicules']);
    const where = prisma.vehicle.findMany.mock.calls[0][0].where;
    expect(where.fleetId).toBe('fleet-a');
    expect(where.id).toEqual({ in: ['v1'] });
  });

  it('les trajets portent le filtre société ET la liste de véhicules accessibles', async () => {
    const { svc, prisma, user } = build({ accessibles: ['v1', 'v2'] });
    await svc.build(user, ['trajets']);
    const where = prisma.trip.findMany.mock.calls[0][0].where;
    expect(where.fleetId).toBe('fleet-a');
    expect(where.vehicleId).toEqual({ in: ['v1', 'v2'] });
  });

  it('aucun véhicule attribué = aucun trajet lu (et non « tous les trajets »)', async () => {
    const { svc, prisma, user } = build({ accessibles: [] });
    const [lot] = await svc.build(user, ['trajets']);
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
    expect(lot.refus).toBeTruthy();
  });

  // ─── Droits ────────────────────────────────────────────────────────────────

  it('sans le droit `trips_view`, les trajets ne sont pas lus DU TOUT', async () => {
    const { svc, prisma, user } = build({ tripsView: false });
    const [lot] = await svc.build(user, ['trajets']);
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
    expect(lot.data).toBeNull();
  });

  it('le droit est vérifié AVANT le périmètre : un compte sans droit ne lit pas par la bande', async () => {
    const { svc, vehicleAccess, user } = build({ tripsView: false });
    await svc.build(user, ['trajets']);
    // Si le périmètre était évalué en premier, un compte sans droit mais avec des véhicules
    // accessibles aurait déjà déclenché la résolution — et la garde suivante deviendrait
    // la seule barrière. On verrouille l'ordre.
    expect(vehicleAccess.getAccessibleVehicleIds).not.toHaveBeenCalled();
  });

  // ─── Un refus se DIT, il ne se devine pas ──────────────────────────────────

  it('un lot refusé porte sa raison en clair (sinon le modèle conclurait « rien à signaler »)', async () => {
    const { svc, user } = build({ tripsView: false });
    const [lot] = await svc.build(user, ['trajets']);
    expect(lot.refus).toMatch(/droit/i);
    expect(lot.volume).toBe(0);
  });

  it('un lot en ERREUR est refusé, jamais rendu comme un lot vide', async () => {
    const { svc, prisma, user } = build();
    prisma.errorLog.findMany.mockRejectedValue(new Error('base indisponible'));
    const [lot] = await svc.build(user, ['erreurs']);
    // « 0 erreur » et « je n'ai pas pu regarder » ne sont pas la même réponse : la première
    // rassure à tort. Le lot doit porter un refus pour que l'agent puisse le dire.
    expect(lot.data).toBeNull();
    expect(lot.refus).toBeTruthy();
  });

  // ─── Ce qui est exposé au modèle ───────────────────────────────────────────

  it('les messages d\'erreur sont tronqués (une pile d\'appel exposerait des chemins internes)', async () => {
    const { svc, prisma, user } = build();
    prisma.errorLog.findMany.mockResolvedValue([
      { createdAt: new Date(), source: 'frontend', level: 'ERROR', message: 'x'.repeat(5000) },
    ]);
    const [lot] = await svc.build(user, ['erreurs']);
    const messages = (lot.data as Array<{ message: string }>).map((e) => e.message);
    expect(messages[0].length).toBeLessThanOrEqual(200);
  });

  it('« limites connues » reste distinct de « aucun excès » sur un trajet sans analyse', async () => {
    const { svc, prisma, user } = build();
    prisma.trip.findMany.mockResolvedValue([
      {
        id: 't1', startedAt: new Date(), durationSeconds: 600, distanceKm: 4.2,
        maxSpeed: 78, segmentationSource: 'recompute', vehicle: { plate: 'AA-001-BB' },
      },
    ]);
    prisma.tripAnalysis.findMany.mockResolvedValue([]); // aucun trajet analysé
    const [lot] = await svc.build(user, ['trajets']);
    const t = (lot.data as Array<{ limitesConnues: boolean | null; scoreEco: number | null }>)[0];
    // `null` = « on ne sait pas », et surtout PAS `false` qui affirmerait l'absence de limites.
    expect(t.limitesConnues).toBeNull();
    expect(t.scoreEco).toBeNull();
  });
});
