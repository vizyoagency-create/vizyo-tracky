import { UserRole } from '@prisma/client';
import { TripsService } from './trips.service';

/**
 * ── AGRÉGAT DES GRAPHIQUES DE PÉRIODE ────────────────────────────────────────────────
 *
 * ⚠️ Constat du 2026-08-03 : « Vitesses max » et « Fréquentation » se calculaient côté
 * client depuis la liste AFFICHÉE des trajets, bornée à 100. Sur 30 jours et 2 738
 * trajets, la fréquentation ne couvrait qu'environ une journée — elle affichait ZÉRO
 * trajet le mardi quand le résumé journalier de la même page en comptait 132.
 *
 * Ces tests verrouillent les deux propriétés qui rendent l'agrégat serveur utile :
 * il couvre TOUTE la période, et il compte les heures dans le BON fuseau.
 */
describe('TripsService.periodCharts', () => {
  /** Construit le service avec un Prisma minimal — on teste l'agrégation, pas Prisma. */
  function setup(trips: Array<{ startedAt: Date; maxSpeed: number }>) {
    const findMany = jest.fn().mockResolvedValue(trips);
    const prisma = { trip: { findMany } } as never;
    // Les autres dépendances ne sont pas sollicitées par `periodCharts` : les passer
    // vides garde le test sur son sujet — l'agrégation — plutôt que sur le câblage.
    const service = new TripsService(prisma, {} as never, {} as never, {} as never);
    return { service, findMany };
  }

  const ADMIN = { userId: 'u1', role: UserRole.FLEET_ADMIN, fleetId: 'f1' } as never;

  it('couvre TOUTE la période — aucun plafond, contrairement à la liste du tableau', async () => {
    // 500 trajets : cinq fois le plafond de 100 qui bornait l'ancien calcul client.
    const trips = Array.from({ length: 500 }, (_, i) => ({
      startedAt: new Date('2026-07-15T10:00:00Z'),
      maxSpeed: 50 + (i % 40),
    }));
    const { service, findMany } = setup(trips);

    const res = await service.periodCharts(ADMIN, { from: '2026-07-01', to: '2026-07-31' });

    expect(res.speeds.length).toBe(500);
    // Aucune borne ne doit être passée à Prisma : c'est ce qui distingue cet agrégat de
    // `list()`, et l'oubli de cette différence est précisément ce qui a produit le bug.
    expect(findMany.mock.calls[0][0].take).toBeUndefined();
  });

  describe('fuseau horaire — la question posée est « à quelle heure roule-t-on ? »', () => {
    it('compte en heure de PARIS, pas en UTC (été : +2 h)', async () => {
      // 15 juillet 2026, 23h30 UTC = 16 juillet 01h30 à Paris.
      // En UTC on compterait mercredi 23 h ; à Paris, c'est JEUDI 1 h.
      const { service } = setup([{ startedAt: new Date('2026-07-15T23:30:00Z'), maxSpeed: 80 }]);
      const res = await service.periodCharts(ADMIN, {});

      // lundi = 0 → jeudi = 3
      expect(res.heatmap[3]![1]).toBe(1);
      // ⚠️ Si cette assertion tombe, le calcul est reparti en UTC : la grille entière
      // serait décalée d'une à deux heures, et resterait parfaitement plausible.
      expect(res.heatmap[2]![23]).toBe(0);
    });

    it('compte en heure de PARIS en hiver aussi (+1 h)', async () => {
      // 15 janvier 2026, 23h30 UTC = 16 janvier 00h30 à Paris (vendredi).
      const { service } = setup([{ startedAt: new Date('2026-01-15T23:30:00Z'), maxSpeed: 80 }]);
      const res = await service.periodCharts(ADMIN, {});
      expect(res.heatmap[4]![0]).toBe(1);
    });

    it('lundi est bien l’indice 0 — convention FR/ISO, comme à l’écran', async () => {
      // 6 juillet 2026 est un lundi. 12h00 UTC = 14h00 à Paris.
      const { service } = setup([{ startedAt: new Date('2026-07-06T12:00:00Z'), maxSpeed: 60 }]);
      const res = await service.periodCharts(ADMIN, {});
      expect(res.heatmap[0]![14]).toBe(1);
    });

    it('la grille fait toujours 7 × 24, même sans aucun trajet', async () => {
      const { service } = setup([]);
      const res = await service.periodCharts(ADMIN, {});
      expect(res.heatmap.length).toBe(7);
      expect(res.heatmap.every((r) => r.length === 24)).toBe(true);
      expect(res.speeds).toEqual([]);
    });
  });

  describe('cloisonnement — le même filtre que le résumé journalier', () => {
    it('un non-super-admin SANS flotte ne voit rien, et la base n’est pas interrogée', async () => {
      const { service, findMany } = setup([{ startedAt: new Date(), maxSpeed: 90 }]);
      const orphelin = { userId: 'u9', role: UserRole.FLEET_MANAGER, fleetId: null } as never;

      const res = await service.periodCharts(orphelin, {});

      // ⚠️ Fail-CLOSED : sans flotte, une requête sans filtre ramènerait les trajets de
      // TOUS les clients. Le fait que Prisma ne soit pas appelé est la garantie forte.
      expect(res.speeds).toEqual([]);
      expect(findMany).not.toHaveBeenCalled();
    });

    it('un fleet-admin est borné à SA flotte', async () => {
      const { service, findMany } = setup([]);
      await service.periodCharts(ADMIN, {});
      expect(findMany.mock.calls[0][0].where.fleetId).toBe('f1');
    });

    it('exclut les véhicules en mode vie privée (RGPD)', async () => {
      const { service, findMany } = setup([]);
      await service.periodCharts(ADMIN, {});
      expect(findMany.mock.calls[0][0].where.NOT).toEqual({ vehicle: { privacyModeEnabled: true } });
    });

    it('applique les bornes de période — en jours civils de Paris, pas en minuit UTC', async () => {
      const { service, findMany } = setup([]);
      await service.periodCharts(ADMIN, { from: '2026-07-01', to: '2026-07-31' });
      const startedAt = findMany.mock.calls[0][0].where.startedAt;
      // « 2026-07-01 » = minuit à Paris = 22:00Z la veille (heure d'été). L'ancienne lecture
      // (minuit UTC = 02:00 à Paris) excluait les départs entre minuit et deux heures.
      expect(startedAt.gte).toEqual(new Date('2026-06-30T22:00:00.000Z'));
      // Borne haute EXCLUSIVE (`lt`) : l'écran envoie le lendemain comme `to`, et un trajet
      // parti à minuit pile appartenait sinon à deux périodes voisines à la fois.
      expect(startedAt.lt).toEqual(new Date('2026-07-30T22:00:00.000Z'));
      expect(startedAt.lte).toBeUndefined();
    });
  });

  it('plafonne les vitesses aberrantes, comme le résumé journalier', async () => {
    const { service } = setup([
      { startedAt: new Date('2026-07-06T12:00:00Z'), maxSpeed: 99999 },
      { startedAt: new Date('2026-07-06T12:00:00Z'), maxSpeed: -20 },
    ]);
    const res = await service.periodCharts(ADMIN, {});
    expect(res.speeds[0]).toBeLessThan(400);
    expect(res.speeds[1]).toBe(0);
  });
});
