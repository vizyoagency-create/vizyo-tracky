import { DestinatairesAvisService } from './destinataires-avis.service';

/**
 * VALIDER ET ÊTRE PRÉVENU ÉTAIENT LA MÊME CHOSE.
 *
 * Relevé le 2026-09-23 chez cdef31 : la mise en service exigeait d'ouvrir la validation à quatre
 * gestionnaires. `notifyFleetOfPendingRequest` écrivant à tous les porteurs de
 * `reservations_manage`, chaque demande de conducteur envoyait donc QUATRE courriels aux boîtes
 * du client — sans qu'aucun réglage ne puisse l'en empêcher.
 *
 * Ces tests verrouillent la séparation : le droit reste la permission, l'avis est un réglage.
 */
const compte = (over: Record<string, unknown> = {}) => ({
  id: 'u1',
  email: 'a@x.fr',
  role: 'FLEET_MANAGER',
  permissions: { reservations_manage: true },
  reservationNoticeEnabled: true,
  ...over,
});

const prismaAvec = (membres: Record<string, unknown>[]) =>
  ({ user: { findMany: jest.fn().mockResolvedValue(membres) } }) as never;

describe('DestinatairesAvisService', () => {
  it('ne retient que les comptes qui peuvent VALIDER', async () => {
    const svc = new DestinatairesAvisService(
      prismaAvec([
        compte({ id: 'oui', permissions: { reservations_manage: true } }),
        compte({ id: 'non', permissions: { reservations_manage: false } }),
      ]),
    );
    const r = await svc.possibles('f1');
    expect(r.map((c) => c.id)).toEqual(['oui']);
  });

  /**
   * ⚠️ LE PIÈGE QUI A DÉJÀ COÛTÉ. Une clé ABSENTE du JSON ne vaut pas `false` : elle vaut le
   * défaut du rôle. Lire le JSON seul ferait disparaître le fleet-admin, dont le JSON est
   * souvent vide — et c'est justement lui le destinataire naturel.
   */
  it('résout une clé ABSENTE par le défaut du rôle, pas par « false »', async () => {
    const svc = new DestinatairesAvisService(
      prismaAvec([
        compte({ id: 'admin', role: 'FLEET_ADMIN', permissions: {} }),
        compte({ id: 'manager', role: 'FLEET_MANAGER', permissions: {} }),
      ]),
    );
    const r = await svc.possibles('f1');
    // FLEET_ADMIN a `reservations_manage: true` par défaut ; FLEET_MANAGER ne l'a pas.
    expect(r.map((c) => c.id)).toEqual(['admin']);
  });

  it('sépare « peut valider » de « est prévenu »', async () => {
    const svc = new DestinatairesAvisService(
      prismaAvec([
        compte({ id: 'prevenu', reservationNoticeEnabled: true }),
        compte({ id: 'silencieux', reservationNoticeEnabled: false }),
      ]),
    );
    expect((await svc.possibles('f1')).map((c) => c.id)).toEqual(['prevenu', 'silencieux']);
    expect((await svc.notifies('f1')).map((c) => c.id)).toEqual(['prevenu']);
  });

  it('un compte silencieux garde le DROIT de valider — il figure dans les possibles', async () => {
    const svc = new DestinatairesAvisService(
      prismaAvec([compte({ id: 'silencieux', reservationNoticeEnabled: false })]),
    );
    expect(await svc.notifies('f1')).toEqual([]);
    expect((await svc.possibles('f1'))[0]).toMatchObject({ id: 'silencieux', notifie: false });
  });
});
