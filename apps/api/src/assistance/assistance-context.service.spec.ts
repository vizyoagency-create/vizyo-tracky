import { UserRole } from '@prisma/client';
import type { AuthUser } from '../auth/types/auth-user';
import { AssistanceContextService } from './assistance-context.service';

/**
 * Assistance IA — CLOISONNEMENT.
 *
 * L'agent lit des données réelles (activité, erreurs, véhicules, trajets, agenda, scores) pour
 * répondre. Ce fichier ne teste pas « est-ce que ça renvoie quelque chose » : il verrouille les
 * propriétés qui empêchent une fuite entre comptes et entre sociétés.
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
    agendaView?: boolean;
    missionsView?: boolean;
    reportsView?: boolean;
    driversView?: boolean;
    rows?: unknown[];
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
      vehicleEvent: { findMany: jest.fn().mockResolvedValue([]) },
      mission: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const vehicleAccess = {
      getAccessibleVehicleIds: jest.fn().mockResolvedValue(opts.accessibles ?? ['v1', 'v2']),
    };
    const permissions = {
      resolveGlobal: jest.fn().mockResolvedValue({
        trips_view: opts.tripsView ?? true,
        agenda_view: opts.agendaView ?? true,
        missions_view: opts.missionsView ?? true,
        reports_view: opts.reportsView ?? true,
        drivers_view: opts.driversView ?? true,
      }),
    };
    /**
     * Le classement n'est pas recalculé par l'assistance : elle appelle le service de l'écran
     * « Scores de conduite ». La doublure rend donc la forme de SON dto, et les tests portent
     * sur les gardes et sur ce qui est transmis au modèle — pas sur l'arithmétique de la note,
     * qui a ses propres tests là où elle est écrite.
     */
    const ligne = (over: Partial<Record<string, unknown>> = {}) => ({
      id: 'x', label: 'Qui', sublabel: null, color: null,
      score: 80, grade: 'B', tripCount: 4, totalTripCount: 5, oldFormulaTripCount: 0,
      distanceKm: 120.4, speedingTrips: 1, speedingTripRefs: [], harshCount: 2,
      fuelLiters: 9, co2Kg: 21, ...over,
    });
    const drivingScores = {
      scores: jest.fn().mockResolvedValue({
        scope: 'driver', from: '', to: '', rows: opts.rows ?? [ligne()],
        overallScore: 77, overallGrade: 'B', totalTrips: 5, rankedCount: 1,
      }),
    };
    const svc = new AssistanceContextService(
      prisma as never, vehicleAccess as never, permissions as never, drivingScores as never,
    );
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
    return { svc, prisma, vehicleAccess, permissions, drivingScores, user, ligne };
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

  // ═══ AGENDA (01/10/2026) ═══════════════════════════════════════════════════
  //
  // L'assistant ignorait que les missions existaient : il décrivait l'agenda d'avant la refonte
  // du 28/09. Le lot `agenda` le rattrape — et ouvre du même coup une lecture qui dépasse le
  // strict périmètre personnel. D'où ces verrous.

  it('🔒 le VEILLEUR DE NUIT n\'obtient PAS l\'agenda, et rien n\'est lu', async () => {
    const { svc, prisma, user } = build({
      role: UserRole.NIGHT_WATCHMAN, agendaView: false, missionsView: false,
    });
    const [lot] = await svc.build(user, ['agenda']);
    // Ses deux droits sont à `false` dans la matrice réelle — décision du client, pas un oubli.
    expect(prisma.mission.findMany).not.toHaveBeenCalled();
    expect(prisma.vehicleEvent.findMany).not.toHaveBeenCalled();
    expect(lot.data).toBeNull();
    expect(lot.refus).toMatch(/droit/i);
  });

  it('l\'agenda vérifie les droits AVANT le périmètre, comme les trajets', async () => {
    const { svc, vehicleAccess, user } = build({ agendaView: false, missionsView: false });
    await svc.build(user, ['agenda']);
    expect(vehicleAccess.getAccessibleVehicleIds).not.toHaveBeenCalled();
  });

  // ── Les deux moitiés de l'agenda sont INDÉPENDANTES ───────────────────────

  it('🔑 `missions_view` SANS `agenda_view` (le défaut du FLEET_MANAGER) sert les missions', async () => {
    const { svc, prisma, user } = build({
      role: UserRole.FLEET_MANAGER, agendaView: false, missionsView: true,
    });
    prisma.mission.findMany.mockResolvedValue([
      {
        ref: 'M-1', status: 'PLANNED', startAt: new Date(), endAt: new Date(),
        originLabel: 'A', destLabel: 'B', vehicle: { plate: 'AA-001-BB' },
      },
    ]);
    const [lot] = await svc.build(user, ['agenda']);
    const data = lot.data as { missions: unknown[]; evenements: unknown[]; nonConsulte: string[] };
    // Le rôle qui POSSÈDE les missions a `agenda_view: false` par défaut. Tout gater derrière
    // `agenda_view` lui aurait refusé ses propres missions — le contraire du but de ce lot.
    expect(data.missions).toHaveLength(1);
    expect(prisma.vehicleEvent.findMany).not.toHaveBeenCalled();
    expect(data.evenements).toEqual([]);
    // Et le modèle SAIT qu'il n'a pas vu le calendrier : sinon il conclurait « aucun entretien ».
    expect(data.nonConsulte.join(' ')).toMatch(/agenda_view/);
  });

  it('🔑 `agenda_view` SANS `missions_view` ne sert AUCUNE mission', async () => {
    const { svc, prisma, user } = build({ agendaView: true, missionsView: false });
    const [lot] = await svc.build(user, ['agenda']);
    const data = lot.data as { missions: unknown[]; nonConsulte: string[] };
    // L'inverse du cas précédent : l'assistant ne doit pas donner par la bande ce que l'écran cache.
    expect(prisma.mission.findMany).not.toHaveBeenCalled();
    expect(data.missions).toEqual([]);
    expect(data.nonConsulte.join(' ')).toMatch(/missions_view/);
  });

  it('avec les deux droits, rien n\'est signalé comme non consulté', async () => {
    const { svc, user } = build();
    const [lot] = await svc.build(user, ['agenda']);
    expect((lot.data as { nonConsulte?: string[] }).nonConsulte).toBeUndefined();
  });

  it('missions ET évènements portent le filtre société ET les véhicules accessibles', async () => {
    const { svc, prisma, user } = build({ accessibles: ['v1', 'v2'] });
    await svc.build(user, ['agenda']);
    for (const appel of [prisma.mission.findMany, prisma.vehicleEvent.findMany]) {
      const where = appel.mock.calls[0][0].where;
      expect(where.fleetId).toBe('fleet-a');
      expect(where.vehicleId).toEqual({ in: ['v1', 'v2'] });
    }
  });

  it('aucun véhicule attribué = aucun agenda lu (et non « tout l\'agenda »)', async () => {
    const { svc, prisma, user } = build({ accessibles: [] });
    const [lot] = await svc.build(user, ['agenda']);
    expect(prisma.mission.findMany).not.toHaveBeenCalled();
    expect(lot.refus).toBeTruthy();
  });

  it('les missions arrivent bien au modèle — c\'est la régression corrigée', async () => {
    const { svc, prisma, user } = build();
    prisma.mission.findMany.mockResolvedValue([
      {
        ref: 'M-2026-014', status: 'PLANNED',
        startAt: new Date('2026-10-02T08:00:00Z'), endAt: new Date('2026-10-02T11:00:00Z'),
        originLabel: 'Toulouse', destLabel: 'Albi', vehicle: { plate: 'AA-001-BB' },
      },
    ]);
    const [lot] = await svc.build(user, ['agenda']);
    const data = lot.data as { missions: Array<{ reference: string; vers: string }> };
    expect(data.missions[0].reference).toBe('M-2026-014');
    expect(data.missions[0].vers).toBe('Albi');
    expect(lot.volume).toBe(1);
  });

  it('🔒 l\'agenda ne DEMANDE ni description libre ni conducteur', async () => {
    const { svc, prisma, user } = build();
    await svc.build(user, ['agenda']);
    // Un champ de texte libre porte ce que l'utilisateur y a mis — parfois le nom d'un mineur
    // placé, chez un client comme CDEF31. On verrouille le `select` lui-même : si un jour
    // quelqu'un ajoute `description: true` « pour mieux répondre », ce test tombe.
    for (const appel of [prisma.mission.findMany, prisma.vehicleEvent.findMany]) {
      const select = JSON.stringify(appel.mock.calls[0][0].select);
      expect(select).not.toContain('description');
      expect(select).not.toContain('notes');
      expect(select).not.toContain('driver');
    }
  });

  // ═══ SCORES DE CONDUITE (01/10/2026) ═══════════════════════════════════════
  //
  // « Qui a le meilleur score ? » est la question qui a motivé ce lot — et c'est le SEUL qui
  // compare des personnes entre elles. Il est donc gardé par le droit exact de l'écran
  // « Scores de conduite », et les NOMS sortent seulement avec `drivers_view` en plus.

  it('🔒 le VEILLEUR DE NUIT n\'obtient PAS le classement, et rien n\'est calculé', async () => {
    const { svc, drivingScores, user } = build({
      role: UserRole.NIGHT_WATCHMAN, reportsView: false, tripsView: false,
    });
    const [lot] = await svc.build(user, ['scores']);
    // Le refus tombe avant tout calcul : rien n'est lu, donc rien ne peut fuir — ni par la
    // réponse, ni par un journal, ni par une erreur qui recopierait la ligne.
    expect(drivingScores.scores).not.toHaveBeenCalled();
    expect(lot.data).toBeNull();
    expect(lot.refus).toMatch(/droit/i);
  });

  it('🔒 `trips_view` SANS `reports_view` (le défaut du DÉPÔT) ne donne pas le classement', async () => {
    const { svc, drivingScores, user } = build({
      role: UserRole.DEPOT, tripsView: true, reportsView: false,
    });
    const [lot] = await svc.build(user, ['scores']);
    // Un compte dépôt n'atteint le classement par aucun écran (`/scores` exige `reports_view`).
    // L'assistance n'a pas à être la porte la plus large de l'application.
    expect(drivingScores.scores).not.toHaveBeenCalled();
    expect(lot.refus).toBeTruthy();
  });

  it('🔒 `reports_view` SANS `trips_view` ne donne pas le classement non plus', async () => {
    const { svc, drivingScores, user } = build({ tripsView: false, reportsView: true });
    const [lot] = await svc.build(user, ['scores']);
    // L'autre moitié de la même porte : la route qui sert les données exige `trips_view`.
    expect(drivingScores.scores).not.toHaveBeenCalled();
    expect(lot.refus).toBeTruthy();
  });

  it('le classement n\'est PAS recalculé : c\'est le service de l\'écran qui répond', async () => {
    const { svc, prisma, drivingScores, user } = build();
    await svc.build(user, ['scores']);
    expect(drivingScores.scores).toHaveBeenCalledTimes(1);
    // Une moyenne refaite ici perdrait `gpsPoints > 0` — les analyses vides valent 100/100 et
    // mettraient les véhicules les plus mal suivis sur le podium. Aucune agrégation à part.
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
    expect(prisma.tripAnalysis.findMany).not.toHaveBeenCalled();
  });

  it('le périmètre est celui du demandeur : aucun fleetId n\'est forcé', async () => {
    const { svc, drivingScores, user } = build();
    await svc.build(user, ['scores']);
    const [userPasse, portee, , , fleetId] = drivingScores.scores.mock.calls[0];
    // Le service borne lui-même sur l'`AuthUser` (anti-IDOR). Le 5ᵉ paramètre ne sert qu'au
    // SUPER_ADMIN pour CHOISIR une société : le passer ici serait réintroduire un identifiant.
    expect(userPasse).toBe(user);
    expect(portee).toBe('driver');
    expect(fleetId).toBeUndefined();
  });

  it('🔒 sans le droit « conducteurs », le classement se demande PAR VÉHICULE', async () => {
    const { svc, drivingScores, user } = build({ driversView: false });
    const [lot] = await svc.build(user, ['scores']);
    // On ne masque pas des lignes nominatives : on ne les demande pas. Un classement de
    // « conducteur 1, conducteur 2 » n'aurait renseigné personne.
    expect(drivingScores.scores.mock.calls[0][1]).toBe('vehicle');
    expect((lot.data as { nomsDesConducteurs: string }).nomsDesConducteurs).toMatch(/masqu/i);
  });

  it('répond « qui est le meilleur » : trié, noté, avec la moyenne de la flotte', async () => {
    const { svc, user, ligne, drivingScores } = build();
    drivingScores.scores.mockResolvedValue({
      scope: 'driver', from: '', to: '',
      rows: [ligne({ label: 'Paul Martin', score: 91, grade: 'A' }), ligne({ label: 'Marie Dupont', score: 62, grade: 'C' })],
      overallScore: 77, overallGrade: 'B', totalTrips: 9, rankedCount: 2,
    });
    const [lot] = await svc.build(user, ['scores']);
    const data = lot.data as {
      classement: Array<{ rang: number; qui: string; note: string }>;
      moyenneFlotte: number; noteMoyenneFlotte: string;
    };
    // Le service rend déjà le classement du meilleur au moins bon : l'agent lit la 1re ligne.
    expect(data.classement[0]).toMatchObject({ rang: 1, qui: 'Paul Martin', note: 'A' });
    expect(data.classement[1].qui).toBe('Marie Dupont');
    // Sans la moyenne, « 62 » ne se situe pas : l'agent ne peut pas dire si c'est bas.
    expect(data.moyenneFlotte).toBe(77);
    expect(data.noteMoyenneFlotte).toBe('B');
  });

  it('les trajets NOTÉS et les trajets RÉELS sont servis ENSEMBLE', async () => {
    const { svc, user, ligne, drivingScores } = build();
    drivingScores.scores.mockResolvedValue({
      scope: 'driver', from: '', to: '',
      rows: [ligne({ label: 'Trop beau', score: 100, grade: 'A', tripCount: 1, totalTripCount: 75 })],
      overallScore: 70, overallGrade: 'B', totalTrips: 75, rankedCount: 1,
    });
    const [lot] = await svc.build(user, ['scores']);
    const l = (lot.data as { classement: Array<{ trajetsNotes: number; trajetsReels: number }> }).classement[0];
    // Un 100/100 sur 1 trajet noté parmi 75 ne vaut pas un 100/100 sur 70 : sans les deux
    // nombres, l'agent présenterait une note portant sur 1,3 % de l'activité comme un fait.
    expect(l).toMatchObject({ trajetsNotes: 1, trajetsReels: 75 });
  });

  it('aucun trajet analysé = refus explicite, jamais un score inventé', async () => {
    const { svc, user, drivingScores } = build({ driversView: false });
    drivingScores.scores.mockResolvedValue({
      scope: 'vehicle', from: '', to: '', rows: [],
      overallScore: null, overallGrade: null, totalTrips: 0, rankedCount: 0,
    });
    const [lot] = await svc.build(user, ['scores']);
    expect(lot.data).toBeNull();
    expect(lot.refus).toMatch(/analys/i);
  });

  it('un classement par conducteur VIDE se replie sur les véhicules', async () => {
    const { svc, user, ligne, drivingScores } = build();
    drivingScores.scores
      .mockResolvedValueOnce({ scope: 'driver', from: '', to: '', rows: [], overallScore: null, overallGrade: null, totalTrips: 0, rankedCount: 0 })
      .mockResolvedValueOnce({ scope: 'vehicle', from: '', to: '', rows: [ligne({ label: 'AA-001-BB' })], overallScore: 80, overallGrade: 'B', totalTrips: 5, rankedCount: 1 });
    const [lot] = await svc.build(user, ['scores']);
    // Beaucoup de trajets n'ont aucun conducteur renseigné. Répondre « aucun score » alors que
    // la flotte roule serait faux ; on répond par plaque, et on dit que c'est par plaque.
    expect(drivingScores.scores.mock.calls.map((c: unknown[]) => c[1])).toEqual(['driver', 'vehicle']);
    expect((lot.data as { portee: string }).portee).toMatch(/véhicule/);
  });

  it('une note assise sur d\'anciennes analyses porte sa réserve', async () => {
    const { svc, user, ligne, drivingScores } = build();
    drivingScores.scores.mockResolvedValue({
      scope: 'driver', from: '', to: '',
      rows: [ligne({ tripCount: 10, oldFormulaTripCount: 8 })],
      overallScore: 70, overallGrade: 'B', totalTrips: 10, rankedCount: 1,
    });
    const [lot] = await svc.build(user, ['scores']);
    // On dit sur QUOI la note est calculée ; on ne déclare pas la note fausse.
    expect((lot.data as { reserve?: string }).reserve).toMatch(/8/);
  });

  it('le sens du score est rappelé — un nombre seul se lit à l\'envers', async () => {
    const { svc, user } = build();
    const [lot] = await svc.build(user, ['scores']);
    const data = lot.data as { lecture: string };
    expect(data.lecture).toMatch(/plus haut/i);
    expect(data.lecture).toMatch(/85/); // le seuil du A, celui du produit
  });
});
