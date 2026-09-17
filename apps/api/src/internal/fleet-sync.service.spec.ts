import { ConflictException, NotFoundException } from '@nestjs/common';
import { FleetSyncService } from './fleet-sync.service';

/**
 * ══ LOT D — LA SYNCHRONISATION VIZYO MANAGER → TRACKY ══════════════════════════════════════════
 *
 * Manager est la source de vérité ; Tracky reflète. Ce qu'on verrouille : ce qui change et ce qui
 * ne change pas (idempotence), le `clientId` jamais réécrit, l'admin marqué « piloté par Manager »,
 * l'archivage qui suspend la flotte ENTIÈRE et ferme les liens, l'effacement qui exige l'archive et
 * le nom retapé, et qui dissocie les boîtiers sans les détruire.
 */
const FLEET = 'aaaaaaaa-0000-4000-8000-000000000001';

function flotte(over: Record<string, unknown> = {}) {
  // `managedByManagerAt` posé : la flotte a déjà été synchronisée (un `null` de Manager efface).
  return { id: FLEET, name: 'Transports Legrand', clientId: null, contactPhone: null, weeklyReportEmail: null, archivedAt: null, managedByManagerAt: new Date('2026-09-17T10:00:00Z'), ...over };
}
function admin(over: Record<string, unknown> = {}) {
  return { id: 'u-admin', email: 'marc@legrand.fr', firstName: 'Transports Legrand', lastName: null, phone: null, authUserId: 'auth-1', ...over };
}

function service(o: { flotte?: Record<string, unknown> | null; admin?: Record<string, unknown> | null; emailPris?: boolean } = {}) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const positions = [{ id: 'p1' }, { id: 'p2' }];
  const prisma: any = {
    fleet: {
      findUnique: jest.fn().mockResolvedValue(o.flotte === null ? null : flotte(o.flotte ?? {})),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(o.admin === null ? null : admin(o.admin ?? {})),
      findUnique: jest.fn().mockResolvedValue(o.emailPris ? { id: 'u-autre' } : null),
      findMany: jest.fn().mockResolvedValue([{ id: 'u1', email: 'marc@legrand.fr', authUserId: 'auth-1' }, { id: 'u2', email: 'b@legrand.fr', authUserId: null }]),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 2 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    installationBookingLink: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    installationBooking: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    position: {
      findMany: jest.fn().mockResolvedValueOnce(positions).mockResolvedValue([]),
      deleteMany: jest.fn().mockResolvedValue({ count: 2 }),
    },
    sim: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    alertRule: { deleteMany: jest.fn().mockResolvedValue({ count: 3 }) },
    trip: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    mission: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    missionRequest: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    trackerCommand: { deleteMany: jest.fn().mockResolvedValue({ count: 4 }) },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const accountSync = { applyStatus: jest.fn().mockResolvedValue(true) };
  const authClient = { removeUserFromApp: jest.fn().mockResolvedValue(undefined) };
  const activity = { record: jest.fn() };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const svc = new FleetSyncService(prisma, accountSync as never, authClient as never, activity as never);
  return { svc, prisma, accountSync, authClient, activity };
}

describe('FleetSyncService — PATCH : ce qui a changé dans Manager', () => {
  it('nom, contact, e-mail de notification : la flotte et son admin sont mis à jour, l’admin marqué « piloté par Manager »', async () => {
    const { svc, prisma, activity } = service();
    const r = await svc.patch(FLEET, {
      name: ' Legrand Transports ', contact: { firstName: 'Marc', lastName: 'Legrand', phone: '06 12 34 56 78' }, notificationEmail: 'Compta@Legrand.fr',
    });
    expect(prisma.fleet.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ name: 'Legrand Transports', contactPhone: '+33612345678', weeklyReportEmail: 'compta@legrand.fr', managedByManagerAt: expect.any(Date) }),
    }));
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u-admin' },
      data: { managedByManager: true, firstName: 'Marc', lastName: 'Legrand', phone: '+33612345678' },
    });
    expect(r.changed.sort()).toEqual(['admin.firstName', 'admin.lastName', 'admin.phone', 'contactPhone', 'name', 'notificationEmail']);
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ category: 'INTERNAL', action: 'fleet_synced', actor: 'vizyo-manager' }));
  });

  it('IDEMPOTENT : rejouer le même état ne change rien (changed vide, journal « déjà à jour »)', async () => {
    const { svc, prisma, activity } = service({ flotte: { name: 'Legrand', contactPhone: '+33612345678' }, admin: { firstName: 'Marc', lastName: 'Legrand', phone: '+33612345678' } });
    const r = await svc.patch(FLEET, { name: 'Legrand', contact: { firstName: 'Marc', lastName: 'Legrand', phone: '+33612345678' } });
    expect(r.changed).toEqual([]);
    expect(prisma.fleet.update.mock.calls[0][0].data).toEqual({ managedByManagerAt: expect.any(Date) });
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ detail: 'Synchronisation reçue : déjà à jour' }));
  });

  it('le `clientId` se POSE (adoption) mais ne se RÉÉCRIT jamais → 409 si différent', async () => {
    const { svc, prisma } = service();
    await svc.patch(FLEET, { clientId: 'cli-1' });
    expect(prisma.fleet.update.mock.calls[0][0].data).toEqual(expect.objectContaining({ clientId: 'cli-1' }));
    const autre = service({ flotte: { clientId: 'cli-1' } });
    await expect(autre.svc.patch(FLEET, { clientId: 'cli-2' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('le nouvel e-mail de connexion de l’admin est refusé s’il est déjà pris par un autre compte', async () => {
    const { svc } = service({ emailPris: true });
    await expect(svc.patch(FLEET, { adminEmail: 'autre@legrand.fr' })).rejects.toThrow(/déjà utilisé/);
  });

  it('PREMIÈRE synchro d’une flotte d’avant le lot D : les `null` de Manager n’effacent pas ce que Tracky sait', async () => {
    const { svc, prisma } = service({ flotte: { managedByManagerAt: null }, admin: { firstName: 'Joost', lastName: 'Hendriks', phone: '+33600000001' } });
    const r = await svc.put(FLEET, { name: 'Transports Legrand', clientId: 'cli-1', contact: { firstName: null, lastName: null, phone: null }, notificationEmail: null });
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u-admin' }, data: { managedByManager: true } });
    expect(prisma.fleet.update.mock.calls[0][0].data).toEqual({ managedByManagerAt: expect.any(Date), clientId: 'cli-1' });
    expect(r.changed).toEqual(['clientId']);
    // Deuxième poussée (flotte désormais synchronisée) : Manager est la vérité, `null` efface.
    const deja = service({ admin: { firstName: 'Joost', lastName: 'Hendriks', phone: '+33600000001' } });
    await deja.svc.patch(FLEET, { contact: { firstName: null, lastName: null, phone: null } });
    expect(deja.prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u-admin' }, data: { managedByManager: true, firstName: null, lastName: null, phone: null } });
  });

  it('un téléphone illisible → 409 ; une flotte inconnue → 404', async () => {
    await expect(service().svc.patch(FLEET, { contact: { phone: 'abc' } })).rejects.toBeInstanceOf(ConflictException);
    await expect(service({ flotte: null }).svc.patch(FLEET, { name: 'X' })).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('FleetSyncService — PUT : l’état complet, et le statut de la flotte ENTIÈRE (C11)', () => {
  it('réactiver une société ARCHIVÉE → 409 (désarchiver d’abord) ; la suspendre reste possible', async () => {
    const { svc, prisma } = service({ flotte: { archivedAt: new Date() } });
    await expect(svc.put(FLEET, { name: 'Transports Legrand', clientId: 'cli-1', isActive: true })).rejects.toThrow(/archivée/);
    await svc.put(FLEET, { name: 'Transports Legrand', clientId: 'cli-1', isActive: false });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { fleetId: FLEET }, data: { isActive: false } });
  });

  it('`isActive: false` suspend tous les membres, Vizyo Auth aligné compte par compte', async () => {
    const { svc, prisma, accountSync } = service();
    const r = await svc.put(FLEET, { name: 'Transports Legrand', clientId: 'cli-1', isActive: false });
    expect(prisma.user.updateMany).toHaveBeenCalledWith({ where: { fleetId: FLEET }, data: { isActive: false } });
    expect(accountSync.applyStatus).toHaveBeenCalledWith('auth-1', false, 'fleet_resync:marc@legrand.fr');
    expect(r.changed).toContain('suspended');
    expect(r.authFailures).toBe(0);
  });

  it('`archived: true` archive (et prime sur `isActive`) ; `archived: false` désarchive — idempotent', async () => {
    const { svc, prisma } = service();
    const r = await svc.put(FLEET, { name: 'Transports Legrand', clientId: 'cli-1', isActive: true, archived: true });
    expect(prisma.fleet.update).toHaveBeenCalledWith({ where: { id: FLEET }, data: { archivedAt: expect.any(Date), archivedBy: 'vizyo-manager' } });
    expect(r.changed).toContain('archived');
    expect(r.changed).not.toContain('active');
    // Une flotte déjà archivée : rejouer `archived: true` ne change rien.
    const deja = service({ flotte: { archivedAt: new Date() } });
    const r2 = await deja.svc.put(FLEET, { name: 'Transports Legrand', clientId: 'cli-1', archived: true });
    expect(r2.changed).not.toContain('archived');
  });

  it('la liste des flottes non reliées porte `id` et `adminEmail` (le contrat lu par Manager)', async () => {
    const { svc, prisma } = service();
    prisma.fleet.findMany.mockResolvedValue([{ id: FLEET, name: 'Legrand', createdAt: new Date(), _count: { vehicles: 3, users: 2 }, users: [{ email: 'marc@legrand.fr', firstName: 'Marc', lastName: null }] }]);
    const [f] = await svc.unlinked();
    expect(f).toEqual(expect.objectContaining({ id: FLEET, fleetId: FLEET, name: 'Legrand', adminEmail: 'marc@legrand.fr', vehicles: 3 }));
  });
});

describe('FleetSyncService — archiver, désarchiver (Q12)', () => {
  it('archiver : date + auteur posés, liens de réservation fermés, membres suspendus, journal', async () => {
    const { svc, prisma, accountSync, activity } = service();
    const r = await svc.archive(FLEET, { by: 'Youness (Manager)' });
    expect(prisma.fleet.update).toHaveBeenCalledWith({ where: { id: FLEET }, data: { archivedAt: expect.any(Date), archivedBy: 'Youness (Manager)' } });
    expect(prisma.installationBookingLink.updateMany).toHaveBeenCalledWith({ where: { fleetId: FLEET, active: true }, data: { active: false } });
    expect(accountSync.applyStatus).toHaveBeenCalledTimes(2);
    expect(r).toEqual({ status: 'archived', authFailures: 0, alreadyArchived: false });
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'fleet_archived', actor: 'Youness (Manager)' }));
  });

  it('archiver deux fois est sans effet ; désarchiver réactive les membres', async () => {
    const deja = service({ flotte: { archivedAt: new Date() } });
    await expect(deja.svc.archive(FLEET, {})).resolves.toEqual(expect.objectContaining({ alreadyArchived: true }));
    expect(deja.prisma.fleet.update).not.toHaveBeenCalled();
    const r = await deja.svc.unarchive(FLEET, {});
    expect(deja.prisma.fleet.update).toHaveBeenCalledWith({ where: { id: FLEET }, data: { archivedAt: null, archivedBy: null } });
    expect(deja.prisma.user.updateMany).toHaveBeenCalledWith({ where: { fleetId: FLEET }, data: { isActive: true } });
    expect(r.wasArchived).toBe(true);
  });
});

describe('FleetSyncService — effacer définitivement (§ 8.4)', () => {
  const archivee = { archivedAt: new Date(), users: [{ authUserId: 'auth-1', email: 'marc@legrand.fr' }, { authUserId: null, email: 'b@legrand.fr' }], vehicles: [{ id: 'v1', tracker: { id: 't1' } }, { id: 'v2', tracker: null }] };

  it('refusé tant que la société n’est pas archivée (avec ou sans nom), ou si le nom retapé ne correspond pas', async () => {
    await expect(service({ flotte: { archivedAt: null, users: [], vehicles: [] } }).svc.destroy(FLEET, { confirmName: 'Transports Legrand' })).rejects.toThrow(/archivez/);
    await expect(service({ flotte: { archivedAt: null, users: [], vehicles: [] } }).svc.destroy(FLEET, {})).rejects.toThrow(/archivez/);
    await expect(service({ flotte: archivee }).svc.destroy(FLEET, { confirmName: 'Autre' })).rejects.toThrow(/nom retapé/);
  });

  it('sans corps (contrat de `deleteClient()` de Manager) : l’archive suffit', async () => {
    const { svc, prisma } = service({ flotte: archivee });
    const r = await svc.destroy(FLEET, {});
    expect(prisma.fleet.delete).toHaveBeenCalledWith({ where: { id: FLEET } });
    expect(r.status).toBe('deleted');
  });

  it('efface positions (par lots), tables dénormalisées, dissocie les SIM, supprime la flotte, retire les comptes de Vizyo Auth, journalise', async () => {
    const { svc, prisma, authClient, activity } = service({ flotte: archivee });
    const r = await svc.destroy(FLEET, { confirmName: 'Transports Legrand', by: 'op' });
    expect(prisma.position.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { trackerId: { in: ['t1'] } } }));
    expect(prisma.position.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ['p1', 'p2'] } } });
    expect(prisma.alertRule.deleteMany).toHaveBeenCalledWith({ where: { fleetId: FLEET } });
    // Les trois relations Restrict partent AVANT la flotte : missions (→ véhicule), commandes de boîtier (→ utilisateur).
    expect(prisma.mission.deleteMany).toHaveBeenCalledWith({ where: { fleetId: FLEET } });
    expect(prisma.trackerCommand.deleteMany).toHaveBeenCalledWith({ where: { requestedBy: { in: ['u1', 'u2'] } } });
    expect(prisma.sim.updateMany).toHaveBeenCalledWith({ where: { fleetId: FLEET }, data: { fleetId: null } });
    // Les demandes et les COMPTES partent explicitement (SetNull sinon : un compte orphelin encore actif — recette prod du 17/09).
    expect(prisma.installationBooking.deleteMany).toHaveBeenCalledWith({ where: { fleetId: FLEET } });
    expect(prisma.user.deleteMany).toHaveBeenCalledWith({ where: { fleetId: FLEET } });
    expect(prisma.fleet.delete).toHaveBeenCalledWith({ where: { id: FLEET } });
    // Un seul compte a un authUserId : un seul retrait Auth ; le boîtier n'est jamais détruit (aucun tracker.delete).
    expect(authClient.removeUserFromApp).toHaveBeenCalledTimes(1);
    expect(prisma.tracker).toBeUndefined();
    expect(r.deleted).toEqual(expect.objectContaining({ positions: 2, alertRule: 3, mission: 1, trackerCommand: 4, fleet: 1, users: 2, vehicles: 2 }));
    expect(activity.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'fleet_destroyed', fleetId: null }));
  });
});
