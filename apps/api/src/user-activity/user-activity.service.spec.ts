import 'reflect-metadata';
import { UserRole } from '@prisma/client';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { OwnerVisibilityService } from '../common/owner-visibility.service';
import { UserActivityController } from './user-activity.controller';
import { UserActivityService } from './user-activity.service';

function makePrisma() {
  const activitiesCreated: any[][] = [];
  const sessionUpdates: any[] = [];
  return {
    _activitiesCreated: activitiesCreated,
    _sessionUpdates: sessionUpdates,
    userSession: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({
        id: 'sess-1',
        currentRoute: null,
        status: 'ACTIVE',
        startedAt: new Date(),
        lastSeenAt: new Date(),
        ...data,
      })),
      update: jest.fn(async ({ data }: any) => {
        sessionUpdates.push(data);
        return {};
      }),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    userActivity: {
      createMany: jest.fn(async ({ data }: any) => {
        activitiesCreated.push(data);
        return { count: data.length };
      }),
      findMany: jest.fn().mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    engineControlCommand: { findMany: jest.fn().mockResolvedValue([]) },
    // `user.findMany` sert (a) à résoudre les noms [] et (b) à lister les rôles ÉLEVÉS
    // (requête `where.OR`) → on renvoie 2 ids élevés SEULEMENT pour cette requête.
    user: {
      findMany: jest.fn(async (args: any) => (args?.where?.OR ? [{ id: 'super1' }, { id: 'owner1' }] : [])),
    },
  };
}

const USER = { id: 'u1', fleetId: 'f1', role: 'VIEWER' } as any;
// Owner plateforme — mock du service d'invisibilité (aucun owner en contexte de test).
const OWNER_VIS = { isMasked: () => false, getOwnerIds: async () => [], userIdExclusion: async () => ({}) } as any;

describe('UserActivityService', () => {
  it('crée une session + persiste les events + met à jour la présence', async () => {
    const prisma = makePrisma();
    const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
    await svc.ingestBatch(
      USER,
      {
        events: [
          { type: 'SESSION_START' },
          // Le HEARTBEAT porte la route COURANTE (source de currentRoute).
          { type: 'HEARTBEAT', route: '/map', status: 'ACTIVE' },
          // Le PAGE_VIEW porte la route QUITTÉE + sa durée (analytics).
          { type: 'PAGE_VIEW', route: '/dashboard', routeLabel: 'Tableau de bord', durationMs: 5000 },
        ],
        deviceType: 'desktop',
      },
      { userAgent: 'jest' },
    );

    expect(prisma.userSession.create).toHaveBeenCalledTimes(1);
    expect(prisma._activitiesCreated[0]).toHaveLength(3);
    const upd = prisma._sessionUpdates[0];
    expect(upd.currentRoute).toBe('/map');
    expect(upd.status).toBe('ACTIVE');
    expect(upd.endedAt).toBeUndefined();
  });

  it('positionne endedAt sur SESSION_END', async () => {
    const prisma = makePrisma();
    const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
    await svc.ingestBatch(USER, { events: [{ type: 'SESSION_END' }] });
    expect(prisma._sessionUpdates[0].endedAt).toBeInstanceOf(Date);
  });

  it('ignore les events de type inconnu (entrée non fiable)', async () => {
    const prisma = makePrisma();
    const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
    await svc.ingestBatch(USER, { events: [{ type: 'HACK' }] });
    expect(prisma.userSession.create).not.toHaveBeenCalled();
    expect(prisma.userActivity.createMany).not.toHaveBeenCalled();
  });

  it('réutilise une session ouverte récente au lieu d\'en créer une', async () => {
    const prisma = makePrisma();
    prisma.userSession.findFirst.mockResolvedValue({
      id: 'sess-existing',
      currentRoute: '/dashboard',
      status: 'ACTIVE',
      startedAt: new Date(),
      lastSeenAt: new Date(),
    });
    const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
    await svc.ingestBatch(USER, { events: [{ type: 'PAGE_VIEW', route: '/vehicles' }] });
    expect(prisma.userSession.create).not.toHaveBeenCalled();
    expect(prisma._activitiesCreated[0][0].sessionId).toBe('sess-existing');
  });

  it('getOnline mappe, résout le libellé et dédupe par utilisateur', async () => {
    const prisma = makePrisma();
    const now = Date.now();
    prisma.userSession.findMany.mockResolvedValue([
      {
        userId: 'u1',
        fleetId: 'f1',
        status: 'ACTIVE',
        currentRoute: '/map',
        deviceType: 'desktop',
        startedAt: new Date(now - 120_000),
        lastSeenAt: new Date(now - 5_000),
        user: { firstName: 'Amir', lastName: 'B', role: 'FLEET_ADMIN' },
      },
      {
        userId: 'u1', // même user, 2e onglet
        fleetId: 'f1',
        status: 'IDLE',
        currentRoute: '/vehicles',
        deviceType: 'mobile',
        startedAt: new Date(now),
        lastSeenAt: new Date(now),
        user: { firstName: 'Amir', lastName: 'B', role: 'FLEET_ADMIN' },
      },
    ]);
    const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
    const online = await svc.getOnline();
    expect(online).toHaveLength(1);
    expect(online[0].name).toBe('Amir B');
    expect(online[0].currentRouteLabel).toBe('Carte live');
  });

  // ── Vue FLEET-ADMIN (scope) : bornée flotte + exclusion des rôles élevés ──────────────
  describe('scope fleet-admin', () => {
    it('getEngineCommands(scope) borne à la flotte via tracker→vehicle ET exclut les rôles élevés', async () => {
      const prisma = makePrisma();
      const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
      await svc.getEngineCommands({}, USER, { fleetId: 'f1' });
      const where = prisma.engineControlCommand.findMany.mock.calls[0][0].where;
      expect(where.tracker).toEqual({ vehicle: { fleetId: 'f1' } });
      expect(where.requestedBy).toEqual({ notIn: ['super1', 'owner1'] });
    });

    it('getOnline(scope) filtre fleetId ET exclut les userId élevés', async () => {
      const prisma = makePrisma();
      const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
      await svc.getOnline(USER, { fleetId: 'f1' });
      const where = prisma.userSession.findMany.mock.calls[0][0].where;
      expect(where.fleetId).toBe('f1');
      expect(where.userId).toEqual({ notIn: ['super1', 'owner1'] });
    });

    it('getFeed(scope) ajoute le filtre flotte ET l\'exclusion des rôles élevés au AND', async () => {
      const prisma = makePrisma();
      const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
      await svc.getFeed({}, USER, { fleetId: 'f1' });
      const and = prisma.userActivity.findMany.mock.calls[0][0].where.AND;
      expect(and).toEqual(expect.arrayContaining([{ fleetId: 'f1' }]));
      expect(and).toEqual(expect.arrayContaining([{ userId: { notIn: ['super1', 'owner1'] } }]));
    });

    it('SANS scope (vue super-admin) : aucun filtre flotte ni exclusion de rôle ajouté', async () => {
      const prisma = makePrisma();
      const svc = new UserActivityService(prisma as any, { record: jest.fn() } as any, OWNER_VIS);
      await svc.getEngineCommands({}, { id: 'sa', role: 'SUPER_ADMIN' } as any);
      const where = prisma.engineControlCommand.findMany.mock.calls[0][0].where;
      expect(where.tracker).toBeUndefined();
      // OWNER_VIS.isMasked = false en test → pas d'exclusion owner non plus.
      expect(where.requestedBy).toBeUndefined();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 29/09 — fil « Agenda » d'une société (GET /api/fleet-admin/activity/agenda).
// Base EN MÉMOIRE : le `where` Prisma réellement construit est rejoué sur des lignes, trié
// (createdAt, id) desc, tronqué à `take`, et réduit au `select` — comme le ferait Prisma. On
// prouve donc le résultat (bornage, auteurs, pagination), pas seulement la forme de la requête.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const FLEET_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const FLEET_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const PEOPLE = {
  superAdmin: {
    id: '5a5a5a5a-0000-4000-8000-00000000005a',
    firstName: 'Sabrina',
    lastName: 'Superadmin',
    email: 'sabrina.superadmin@vizyo.example',
    role: 'SUPER_ADMIN',
    isOwner: false,
    fleetId: null,
  },
  owner: {
    id: '0e0e0e0e-0000-4000-8000-00000000000e',
    firstName: 'Olivier',
    lastName: 'Proprietaire',
    email: 'olivier.proprietaire@vizyo.example',
    role: 'SUPER_ADMIN',
    isOwner: true,
    fleetId: null,
  },
  clientAdmin: {
    id: 'c1c1c1c1-0000-4000-8000-0000000000c1',
    firstName: 'Claire',
    lastName: 'Martin',
    email: 'claire@client-a.example',
    role: 'FLEET_ADMIN',
    isOwner: false,
    fleetId: FLEET_A,
  },
  otherFleetUser: {
    id: 'b0b0b0b0-0000-4000-8000-0000000000b0',
    firstName: 'Bruno',
    lastName: 'Autresociete',
    email: 'bruno@client-b.example',
    role: 'FLEET_ADMIN',
    isOwner: false,
    fleetId: FLEET_B,
  },
};

const T0 = Date.parse('2026-09-28T08:00:00.000Z');
const at = (min: number) => new Date(T0 + min * 60_000);
const rid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** Journal métier : lignes de deux sociétés, catégories d'agenda et autres. */
function journal() {
  return [
    // Société A
    { id: rid(1), createdAt: at(10), fleetId: FLEET_A, category: 'RESERVATION', action: 'reservation_validee', status: 'SUCCESS', actor: 'utilisateur', target: 'AB-123-CD', detail: 'Validée pour le 30/09 à 10:00', triggeredByUserId: PEOPLE.superAdmin.id, meta: { reservationId: 'r-1', by: PEOPLE.superAdmin.id, email: PEOPLE.superAdmin.email } },
    { id: rid(2), createdAt: at(9), fleetId: FLEET_A, category: 'AGENDA', action: 'incident_signale', status: 'SUCCESS', actor: 'utilisateur', target: 'EF-456-GH', detail: 'Pare-brise fissuré', triggeredByUserId: PEOPLE.owner.id, meta: { by: PEOPLE.owner.id } },
    { id: rid(3), createdAt: at(8), fleetId: FLEET_A, category: 'RESERVATION', action: 'public_booking_submitted', status: 'SUCCESS', actor: 'client', target: null, detail: 'Demande publique : 1 véhicule(s)', triggeredByUserId: null, meta: { linkId: 'l-1' } },
    { id: rid(4), createdAt: at(7), fleetId: FLEET_A, category: 'AI', action: 'agenda_agent_run', status: 'SUCCESS', actor: 'system', target: null, detail: 'Agent agenda (cron) : 1 réservé(s)', triggeredByUserId: null, meta: null },
    { id: rid(5), createdAt: at(6), fleetId: FLEET_A, category: 'AGENDA', action: 'proposition_ecartee', status: 'SUCCESS', actor: 'system', target: 'AB-123-CD', detail: null, triggeredByUserId: null, meta: null },
    // Deux lignes au MÊME instant : la coupe de page tombe entre elles.
    { id: rid(7), createdAt: at(5), fleetId: FLEET_A, category: 'RESERVATION', action: 'reservation_creee', status: 'SUCCESS', actor: 'utilisateur', target: 'IJ-789-KL', detail: 'Du 01/10 08:00 au 01/10 18:00', triggeredByUserId: PEOPLE.clientAdmin.id, meta: { reservationId: 'r-7' } },
    { id: rid(6), createdAt: at(5), fleetId: FLEET_A, category: 'AGENDA', action: 'action_future_inconnue', status: 'SUCCESS', actor: null, target: null, detail: null, triggeredByUserId: null, meta: null },
    // Hors fil Agenda (société A) : jamais rendues.
    { id: rid(8), createdAt: at(11), fleetId: FLEET_A, category: 'EMAIL', action: 'email_sent', status: 'SUCCESS', actor: 'system', target: 'c***@client-a.example', detail: 'Réservation validée', triggeredByUserId: null, meta: null },
    { id: rid(9), createdAt: at(12), fleetId: FLEET_A, category: 'AI', action: 'ai_call', status: 'SUCCESS', actor: 'system', target: null, detail: null, triggeredByUserId: null, meta: null },
    { id: rid(10), createdAt: at(13), fleetId: FLEET_A, category: 'MUTATION', action: 'POST /agenda/reservations', status: 'SUCCESS', actor: 'Claire Martin', target: null, detail: null, triggeredByUserId: PEOPLE.clientAdmin.id, meta: null },
    // Société B : jamais visible depuis A.
    { id: rid(11), createdAt: at(14), fleetId: FLEET_B, category: 'RESERVATION', action: 'reservation_validee', status: 'SUCCESS', actor: 'utilisateur', target: 'ZZ-999-ZZ', detail: 'Chez B', triggeredByUserId: PEOPLE.otherFleetUser.id, meta: null },
    { id: rid(12), createdAt: at(4), fleetId: FLEET_B, category: 'AGENDA', action: 'evenement_cree', status: 'SUCCESS', actor: 'utilisateur', target: 'YY-888-YY', detail: null, triggeredByUserId: null, meta: null },
  ];
}

/** Rejoue le sous-ensemble du langage `where` Prisma utilisé par le service. */
function matches(row: Record<string, any>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'AND') return (cond as any[]).every((w) => matches(row, w));
    if (key === 'OR') return (cond as any[]).some((w) => matches(row, w));
    const v = row[key];
    if (cond instanceof Date) return v instanceof Date && v.getTime() === cond.getTime();
    if (cond && typeof cond === 'object') {
      if ('in' in cond && !cond.in.includes(v)) return false;
      // SQL : `NULL NOT IN (…)` n'est pas vrai — une ligne sans auteur ne passe un `notIn` que par un OR explicite.
      if ('notIn' in cond && (v === null || v === undefined || cond.notIn.includes(v))) return false;
      if ('lt' in cond && !(v < cond.lt)) return false;
      if ('lte' in cond && !(v <= cond.lte)) return false;
      if ('gte' in cond && !(v >= cond.gte)) return false;
      return true;
    }
    return v === cond;
  });
}

function pick(row: Record<string, any>, select?: Record<string, boolean>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]]));
}

function makeAgendaPrisma(opts: { rows?: any[]; users?: any[]; elevatedIds?: string[] } = {}) {
  const rows = opts.rows ?? journal();
  const users = opts.users ?? Object.values(PEOPLE);
  const elevatedIds =
    opts.elevatedIds ?? users.filter((u) => u.role === 'SUPER_ADMIN' || u.isOwner).map((u) => u.id);
  return {
    systemActivityLog: {
      findMany: jest.fn(async (args: any) =>
        rows
          .filter((r) => matches(r, args.where ?? {}))
          .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))
          .slice(0, args.take ?? rows.length)
          .map((r) => pick(r, args.select)),
      ),
    },
    user: {
      findMany: jest.fn(async (args: any) => {
        // Liste des comptes ÉLEVÉS (getElevatedUserIds) : requête `where.OR`.
        if (args?.where?.OR) return elevatedIds.map((id) => ({ id }));
        // Liste des owners (OwnerVisibilityService.getOwners) : requête `where.isOwner`.
        if (args?.where?.isOwner === true) return users.filter((u) => u.isOwner).map((u) => pick(u, args.select));
        const ids: string[] = args?.where?.id?.in ?? [];
        return users.filter((u) => ids.includes(u.id)).map((u) => pick(u, args.select));
      }),
    },
  };
}

/** Le VRAI OwnerVisibilityService (sur la même base en mémoire) : le fragment d'exclusion testé est celui de la prod. */
function agendaService(prisma: any) {
  return new UserActivityService(prisma, { record: jest.fn() } as any, new OwnerVisibilityService(prisma));
}

describe('UserActivityService.getAgendaFeed — fil Agenda d’une société', () => {
  it('where : bornée à la société ET aux catégories du fil (RESERVATION, AGENDA, passages de l’agent)', async () => {
    const prisma = makeAgendaPrisma();
    await agendaService(prisma).getAgendaFeed({}, { fleetId: FLEET_A });
    const args = prisma.systemActivityLog.findMany.mock.calls[0][0];
    expect(args.where.AND).toEqual(
      expect.arrayContaining([
        { fleetId: FLEET_A },
        {
          OR: [
            { category: { in: ['RESERVATION', 'AGENDA'] } },
            { category: 'AI', action: 'agenda_agent_run' },
          ],
        },
      ]),
    );
    expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    expect(args.select.meta).toBeUndefined(); // `meta` n'est jamais lu
  });

  it('rend les lignes d’agenda de la société, dans l’ordre, avec libellé et auteur calculés', async () => {
    const out = await agendaService(makeAgendaPrisma()).getAgendaFeed({}, { fleetId: FLEET_A });
    expect(out.map((l) => [l.id, l.actionLabel, l.actorName, l.actorKind, l.vehiclePlate])).toEqual([
      [rid(1), 'Réservation validée', 'Équipe Tracky', 'team', 'AB-123-CD'],
      [rid(2), 'Incident signalé', 'Équipe Tracky', 'team', 'EF-456-GH'],
      [rid(3), 'Demande reçue par le lien public', 'Demande publique', 'public', null],
      [rid(4), "Passage de l'agent", "Agent de l'agenda", 'agent', null],
      [rid(5), "Proposition de l'agent écartée", "Agent de l'agenda", 'agent', 'AB-123-CD'],
      [rid(7), 'Réservation créée', 'Claire Martin', 'user', 'IJ-789-KL'],
      // Action inconnue du dictionnaire : son code ; sans auteur ni acteur connu : « Tracky ».
      [rid(6), 'action_future_inconnue', 'Tracky', 'system', null],
    ]);
    expect(out[0]).toMatchObject({
      at: at(10).toISOString(),
      category: 'RESERVATION',
      action: 'reservation_validee',
      status: 'SUCCESS',
      detail: 'Validée pour le 30/09 à 10:00',
    });
  });

  it('owner caché : un geste de super-admin / du propriétaire → « Équipe Tracky », sans id, nom ni e-mail', async () => {
    const prisma = makeAgendaPrisma();
    const out = await agendaService(prisma).getAgendaFeed({}, { fleetId: FLEET_A });
    const json = JSON.stringify(out);
    for (const p of [PEOPLE.superAdmin, PEOPLE.owner]) {
      expect(json).not.toContain(p.id);
      expect(json).not.toContain(p.firstName);
      expect(json).not.toContain(p.lastName);
      expect(json).not.toContain(p.email);
    }
    // Aucun identifiant d'utilisateur, ni `actor`, ni `meta` dans la réponse — même pour un client.
    expect(json).not.toContain(PEOPLE.clientAdmin.id);
    for (const line of out) {
      expect(Object.keys(line).sort()).toEqual(
        ['action', 'actionLabel', 'actorKind', 'actorName', 'at', 'category', 'detail', 'id', 'status', 'vehiclePlate'].sort(),
      );
    }
    // Les comptes élevés ne sont même pas chargés par nom.
    const nameQueries = prisma.user.findMany.mock.calls.filter((c: any[]) => c[0]?.where?.id?.in);
    for (const c of nameQueries) {
      expect(c[0].where.id.in).not.toContain(PEOPLE.superAdmin.id);
      expect(c[0].where.id.in).not.toContain(PEOPLE.owner.id);
    }
  });

  it('un compte promu super-admin encore absent du cache des comptes élevés reste « Équipe Tracky »', async () => {
    const prisma = makeAgendaPrisma({ elevatedIds: [] }); // cache périmé : personne d'élevé
    const out = await agendaService(prisma).getAgendaFeed({}, { fleetId: FLEET_A });
    expect(out.find((l) => l.id === rid(1))).toMatchObject({ actorName: 'Équipe Tracky', actorKind: 'team' });
    expect(out.find((l) => l.id === rid(2))).toMatchObject({ actorName: 'Équipe Tracky', actorKind: 'team' });
    expect(JSON.stringify(out)).not.toContain(PEOPLE.superAdmin.lastName);
    expect(JSON.stringify(out)).not.toContain(PEOPLE.owner.lastName);
  });

  it('aucune ligne d’une autre société (ni l’inverse), aucune ligne hors fil Agenda', async () => {
    const svc = agendaService(makeAgendaPrisma());
    const a = await svc.getAgendaFeed({ limit: 200 }, { fleetId: FLEET_A });
    expect(a.map((l) => l.id)).not.toEqual(expect.arrayContaining([rid(11)]));
    expect(a.map((l) => l.id)).not.toContain(rid(12));
    // EMAIL, appel IA quelconque, MUTATION : hors fil.
    for (const id of [rid(8), rid(9), rid(10)]) expect(a.map((l) => l.id)).not.toContain(id);
    expect(JSON.stringify(a)).not.toContain('ZZ-999-ZZ');
    expect(JSON.stringify(a)).not.toContain(PEOPLE.otherFleetUser.lastName);

    const b = await agendaService(makeAgendaPrisma()).getAgendaFeed({}, { fleetId: FLEET_B });
    expect(b.map((l) => l.id)).toEqual([rid(11), rid(12)]);
    expect(b[0]).toMatchObject({ actorName: 'Bruno Autresociete', actorKind: 'user' });
  });

  it('un auteur rattaché à une AUTRE société n’est pas nommé', async () => {
    const rows = [
      { ...journal()[5], triggeredByUserId: PEOPLE.otherFleetUser.id }, // ligne de A, auteur de B
    ];
    const out = await agendaService(makeAgendaPrisma({ rows })).getAgendaFeed({}, { fleetId: FLEET_A });
    expect(out[0]).toMatchObject({ actorName: 'Utilisateur', actorKind: 'user' });
    expect(JSON.stringify(out)).not.toContain('Bruno');
  });

  it('pagination (before + beforeId) : ni trou ni doublon, même quand la coupe tombe sur un instant partagé', async () => {
    const prisma = makeAgendaPrisma();
    const svc = agendaService(prisma);
    const all = (await svc.getAgendaFeed({ limit: 200 }, { fleetId: FLEET_A })).map((l) => l.id);
    expect(all).toHaveLength(7);

    const seen: string[] = [];
    let before: string | undefined;
    let beforeId: string | undefined;
    for (let page = 0; page < 10; page++) {
      const lot = await svc.getAgendaFeed({ limit: 3, before, beforeId }, { fleetId: FLEET_A });
      if (lot.length === 0) break;
      expect(lot.length).toBeLessThanOrEqual(3);
      seen.push(...lot.map((l) => l.id));
      before = lot[lot.length - 1].at;
      beforeId = lot[lot.length - 1].id;
    }
    // Page 2 se termine sur rid(7) (08:05) ; page 3 doit rendre rid(6), du MÊME instant.
    expect(seen).toEqual(all);
  });

  it('limit : 50 par défaut, plafonné à 200', async () => {
    const prisma = makeAgendaPrisma();
    const svc = agendaService(prisma);
    await svc.getAgendaFeed({}, { fleetId: FLEET_A });
    await svc.getAgendaFeed({ limit: 5000 }, { fleetId: FLEET_A });
    expect(prisma.systemActivityLog.findMany.mock.calls[0][0].take).toBe(50);
    expect(prisma.systemActivityLog.findMany.mock.calls[1][0].take).toBe(200);
  });

  it('category : RESERVATION seules ; AGENDA = le reste de l’agenda, passages de l’agent compris ; inconnue = tout le fil', async () => {
    const svc = agendaService(makeAgendaPrisma());
    const r = await svc.getAgendaFeed({ category: 'RESERVATION' }, { fleetId: FLEET_A });
    expect(r.map((l) => l.id)).toEqual([rid(1), rid(3), rid(7)]);
    const g = await svc.getAgendaFeed({ category: 'AGENDA' }, { fleetId: FLEET_A });
    expect(g.map((l) => l.id)).toEqual([rid(2), rid(4), rid(5), rid(6)]);
    // Une catégorie étrangère n'élargit jamais le fil (pas d'e-mails ni d'appels IA).
    const x = await svc.getAgendaFeed({ category: 'EMAIL' }, { fleetId: FLEET_A });
    expect(x).toHaveLength(7);
  });

  it('société mal formée : liste vide, aucune requête', async () => {
    const prisma = makeAgendaPrisma();
    const out = await agendaService(prisma).getAgendaFeed({}, { fleetId: 'ALL' });
    expect(out).toEqual([]);
    expect(prisma.systemActivityLog.findMany).not.toHaveBeenCalled();
  });
});

describe('UserActivityService.getAgendaFeed — owner caché selon le LECTEUR', () => {
  const VIEWER_SUPER = { id: PEOPLE.superAdmin.id, role: UserRole.SUPER_ADMIN, isOwner: false };
  const VIEWER_OWNER = { id: PEOPLE.owner.id, role: UserRole.SUPER_ADMIN, isOwner: true };
  const VIEWER_CLIENT = { id: PEOPLE.clientAdmin.id, role: UserRole.FLEET_ADMIN, isOwner: false };

  it('super-admin non-owner : le geste de l’owner est ABSENT ; celui d’un autre super-admin et les lignes sans auteur restent', async () => {
    const prisma = makeAgendaPrisma();
    const out = await agendaService(prisma).getAgendaFeed({ limit: 200 }, { fleetId: FLEET_A }, VIEWER_SUPER);
    expect(out.map((l) => l.id)).toEqual([rid(1), rid(3), rid(4), rid(5), rid(7), rid(6)]);
    expect(out.find((l) => l.id === rid(1))).toMatchObject({ actorName: 'Équipe Tracky', actorKind: 'team' });
    expect(JSON.stringify(out)).not.toContain('Pare-brise fissuré');
    // L'exclusion est une clause du `where` (pas un filtre après coup) et conserve les NULL.
    const args = prisma.systemActivityLog.findMany.mock.calls[0][0];
    expect(args.where.AND).toContainEqual({
      OR: [{ triggeredByUserId: null }, { triggeredByUserId: { notIn: [PEOPLE.owner.id] } }],
    });
  });

  it('super-admin non-owner : pagination pleine, sans trou ni doublon (l’exclusion ne raccourcit aucune page)', async () => {
    const svc = agendaService(makeAgendaPrisma());
    const all = (await svc.getAgendaFeed({ limit: 200 }, { fleetId: FLEET_A }, VIEWER_SUPER)).map((l) => l.id);
    expect(all).toHaveLength(6);
    const pages: string[][] = [];
    let before: string | undefined;
    let beforeId: string | undefined;
    for (let page = 0; page < 10; page++) {
      const lot = await svc.getAgendaFeed({ limit: 3, before, beforeId }, { fleetId: FLEET_A }, VIEWER_SUPER);
      if (lot.length === 0) break;
      pages.push(lot.map((l) => l.id));
      before = lot[lot.length - 1].at;
      beforeId = lot[lot.length - 1].id;
    }
    expect(pages.map((p) => p.length)).toEqual([3, 3]);
    expect(pages.flat()).toEqual(all);
  });

  it('l’owner lui-même voit tout, son propre geste compris (« Équipe Tracky »)', async () => {
    const prisma = makeAgendaPrisma();
    const out = await agendaService(prisma).getAgendaFeed({ limit: 200 }, { fleetId: FLEET_A }, VIEWER_OWNER);
    expect(out).toHaveLength(7);
    expect(out.find((l) => l.id === rid(2))).toMatchObject({ actorName: 'Équipe Tracky', actorKind: 'team' });
    const args = prisma.systemActivityLog.findMany.mock.calls[0][0];
    expect(JSON.stringify(args.where)).not.toContain('triggeredByUserId');
  });

  it('administrateur de flotte : le geste de l’owner reste visible, sous « Équipe Tracky » (voulu par le lot)', async () => {
    const prisma = makeAgendaPrisma();
    const out = await agendaService(prisma).getAgendaFeed({ limit: 200 }, { fleetId: FLEET_A }, VIEWER_CLIENT);
    expect(out).toHaveLength(7);
    expect(out.find((l) => l.id === rid(2))).toMatchObject({ actorName: 'Équipe Tracky', actorKind: 'team' });
    expect(JSON.stringify(out)).not.toContain(PEOPLE.owner.lastName);
    const args = prisma.systemActivityLog.findMany.mock.calls[0][0];
    expect(JSON.stringify(args.where)).not.toContain('triggeredByUserId');
  });
});

describe('Route GET fleet-admin/activity/agenda — périmètre', () => {
  function controller() {
    const svc = { getAgendaFeed: jest.fn().mockResolvedValue([]) };
    const ctrl = new UserActivityController(svc as any, {} as any, { getFeed: jest.fn() } as any);
    return { ctrl, svc };
  }
  const req = (user: Record<string, unknown>) => ({ user }) as any;

  it('rôles : FLEET_ADMIN et SUPER_ADMIN, RolesGuard câblé', () => {
    const handler = UserActivityController.prototype.fleetAgenda;
    expect(Reflect.getMetadata(ROLES_KEY, handler)).toEqual([UserRole.FLEET_ADMIN, UserRole.SUPER_ADMIN]);
    expect(Reflect.getMetadata('__guards__', handler)).toContain(RolesGuard);
  });

  it('un administrateur de flotte est borné à SA société : ?fleetId est ignoré', async () => {
    const { ctrl, svc } = controller();
    const user = { role: UserRole.FLEET_ADMIN, fleetId: FLEET_A, isOwner: false };
    await ctrl.fleetAgenda(req(user), undefined, undefined, undefined, undefined, FLEET_B);
    // Le lecteur est transmis : c'est lui qui décide si les gestes de l'owner sont exclus.
    expect(svc.getAgendaFeed).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }), { fleetId: FLEET_A }, user);
  });

  it('un super-admin passe ?fleetId ; sans ?fleetId il n’obtient rien', async () => {
    const { ctrl, svc } = controller();
    const user = { role: UserRole.SUPER_ADMIN, fleetId: null, isOwner: false };
    await ctrl.fleetAgenda(req(user), '20', '2026-09-28T08:05:00.000Z', rid(7), 'RESERVATION', FLEET_B);
    expect(svc.getAgendaFeed).toHaveBeenCalledWith(
      { limit: 20, before: '2026-09-28T08:05:00.000Z', beforeId: rid(7), category: 'RESERVATION' },
      { fleetId: FLEET_B },
      user,
    );
    svc.getAgendaFeed.mockClear();
    const out = await ctrl.fleetAgenda(req({ role: UserRole.SUPER_ADMIN, fleetId: null }));
    expect(out).toEqual([]);
    expect(svc.getAgendaFeed).not.toHaveBeenCalled();
  });

  it('un administrateur de flotte sans société n’obtient rien', async () => {
    const { ctrl, svc } = controller();
    const out = await ctrl.fleetAgenda(req({ role: UserRole.FLEET_ADMIN, fleetId: null }), undefined, undefined, undefined, undefined, FLEET_B);
    expect(out).toEqual([]);
    expect(svc.getAgendaFeed).not.toHaveBeenCalled();
  });
});
