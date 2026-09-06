import { BadRequestException } from '@nestjs/common';
import { TripsController } from './trips.controller';
import { TripsService } from './trips.service';

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * FILTRE CONDUCTEUR DES TRAJETS (F13, seconde moitié) — « montre-moi SES trajets »
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le récapitulatif « par conducteur ou groupe » répondait à « combien a roulé tel
 * conducteur ». Le geste suivant n'existait pas : `Trip.driverId` et son index sont là
 * depuis toujours, mais aucune route ne les exposait.
 *
 * Ce que ces tests verrouillent, dans l'ordre d'importance :
 *
 *  1. **`none` devient `null`, jamais la chaîne.** `where.driverId = 'none'` chercherait un
 *     conducteur dont l'identifiant serait littéralement « none » : zéro ligne, un écran vide
 *     et parfaitement plausible. Or c'est LE filtre utile du client — 1 905 trajets sur 1 956
 *     chez « mh cars » n'ont aucun conducteur (mesuré le 2026-09-05).
 *
 *  2. **Absent = aucun filtre**, et surtout pas `driverId: null` : ce dernier ne rendrait que
 *     les trajets orphelins, c'est-à-dire l'inverse de « pas de filtre ».
 *
 *  3. **`buildPeriodWhere` applique la MÊME règle**, donc `dailySummary` (d'où viennent les
 *     indicateurs) et `periodCharts` suivent d'un coup. Filtrer la liste sans filtrer les
 *     agrégats mettrait, sur le même écran, un compteur qui compte toute la flotte au-dessus
 *     d'un tableau qui n'en montre qu'une personne — le défaut que cette page a déjà payé.
 *
 *  4. **Le cloisonnement ne bouge pas** : périmètre véhicule, mode vie privée et fail-closed
 *     d'un non-super sans flotte restent exactement ce qu'ils étaient. La vie privée est
 *     nommée parce qu'elle est la borne qu'on oublie de regarder — cf. le test « s'AJOUTE aux
 *     bornes existantes ».
 */

const CONDUCTEUR = '3f1c9a2e-5b7d-4c8e-9a1f-2d3e4b5c6a7b';
const AUTRE_FLOTTE = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
/** La société de l'appelant, pour les tests du contrôleur en fin de fichier. */
const FLOTTE = 'ffffffff-0000-4000-8000-000000000001';

function build() {
  const appels: { where?: Record<string, unknown> }[] = [];
  const prisma = {
    trip: {
      findMany: jest.fn(async (args: { where?: Record<string, unknown> }) => {
        appels.push(args);
        return [];
      }),
    },
  };
  const svc = new TripsService(prisma as never, {} as never, {} as never, {} as never);
  (svc as unknown as { ready: boolean }).ready = true;
  const superAdmin = { userId: 'u', role: 'SUPER_ADMIN' as never, fleetId: null };
  /** Le `where` de la dernière requête envoyée à Prisma. */
  const dernierWhere = () => appels[appels.length - 1]!.where!;
  return { svc, appels, superAdmin, dernierWhere };
}

describe('TripsService — filtre conducteur de la liste (GET /trips)', () => {
  it('filtre sur un conducteur : son identifiant descend dans le where', async () => {
    const { svc, superAdmin, dernierWhere } = build();
    await svc.list(superAdmin, { driverId: CONDUCTEUR });

    expect(dernierWhere()['driverId']).toBe(CONDUCTEUR);
  });

  /**
   * ⚠️ LE TEST QUI COMPTE. `none` est un mot-clé de l'API, pas un identifiant : il doit
   * devenir `null` dans le where (`driverId IS NULL`). Laisser passer la chaîne rendrait
   * zéro trajet sous un libellé « Sans conducteur » — un écran vide qui a l'air d'une
   * réponse, exactement là où le client attend ses 1 905 trajets à corriger.
   */
  it('« none » devient driverId: null — les trajets SANS conducteur, jamais la chaîne', async () => {
    const { svc, superAdmin, dernierWhere } = build();
    await svc.list(superAdmin, { driverId: 'none' });

    const where = dernierWhere();
    expect(where['driverId']).toBeNull();
    expect(where['driverId']).not.toBe('none');
  });

  it('paramètre absent : AUCUNE clé driverId — pas même null', async () => {
    const { svc, superAdmin, dernierWhere } = build();
    await svc.list(superAdmin, {});

    // `driverId: null` ne rendrait que les orphelins : ce serait un filtre, pas son absence.
    expect(dernierWhere()).not.toHaveProperty('driverId');
  });

  it('chaîne vide ou blancs : traités comme « absent », pas comme un filtre', async () => {
    const { svc, superAdmin, appels } = build();
    await svc.list(superAdmin, { driverId: '' });
    await svc.list(superAdmin, { driverId: '   ' });

    expect(appels[0]!.where).not.toHaveProperty('driverId');
    expect(appels[1]!.where).not.toHaveProperty('driverId');
  });

  /**
   * La valeur finit dans un `where` Prisma : une chaîne libre serait une valeur non bornée
   * injectée dans la requête. Le DTO valide déjà la liste, le service reste la barrière que
   * TOUTES les routes traversent (`daily-summary`, `period-charts` et `reports/stats` lisent
   * des `@Query()` bruts, sans DTO).
   */
  it('refuse toute valeur qui n’est ni un UUID ni « none »', async () => {
    const { svc, superAdmin } = build();

    for (const valeur of ['null', 'NONE ou autre', "' OR 1=1 --", 'driver:abc', '12345']) {
      await expect(svc.list(superAdmin, { driverId: valeur })).rejects.toBeInstanceOf(BadRequestException);
    }
  });

  /**
   * 🔒 Anti-IDOR : aucune lecture de contrôle n'est faite sur le conducteur, et c'est
   * délibéré. Les trajets restent bornés par la flotte et par le périmètre véhicule — un
   * identifiant d'une autre société ne peut donc rendre que zéro ligne. Ce test fige que les
   * TROIS bornes survivent au nouveau filtre.
   *
   * ⚠️ LA TROISIÈME EST CELLE QU'ON OUBLIE, ET ELLE EST DÉJÀ TOMBÉE UNE FOIS. Le mode vie
   * privée (RGPD) masque les trajets d'un véhicule actuellement en mode privé
   * (`trips.service.list`, `NOT: { vehicle: { privacyModeEnabled: true } }`). Le 2026-09-05,
   * ce dépôt a découvert des véhicules privés qui abondaient des lignes d'imputation. Tant
   * que ce test ne regardait que `fleetId`, `vehicleId` et `driverId`, on pouvait retirer le
   * `NOT` du `where` que ce test vient justement d'inspecter : les trois assertions passaient,
   * sous un intitulé qui promet le contraire.
   */
  it('le filtre conducteur s’AJOUTE aux bornes existantes, il n’en remplace aucune', async () => {
    const { svc, dernierWhere } = build();
    const viewer = {
      userId: 'u',
      role: 'VIEWER' as never,
      fleetId: 'fleet-1',
      accessibleVehicleIds: ['v1', 'v2'],
    };
    await svc.list(viewer, { driverId: AUTRE_FLOTTE });

    const where = dernierWhere();
    expect(where['fleetId']).toBe('fleet-1');
    expect(where['vehicleId']).toEqual({ in: ['v1', 'v2'] });
    expect(where['driverId']).toBe(AUTRE_FLOTTE);
    expect(where['NOT']).toEqual({ vehicle: { privacyModeEnabled: true } });
  });

  it('fail-closed intact : un non-super sans flotte ne voit rien, même avec un filtre conducteur', async () => {
    const { svc, appels } = build();
    const orphelin = { userId: 'u', role: 'FLEET_MANAGER' as never, fleetId: null };

    const res = await svc.list(orphelin, { driverId: CONDUCTEUR });

    expect(res).toEqual({ items: [], nextCursor: null });
    expect(appels).toHaveLength(0); // aucune requête n'est même partie
  });
});

/**
 * `dailySummary` et `periodCharts` partagent `buildPeriodWhere`. C'est tout l'intérêt d'y
 * avoir mis la règle : les deux suivent d'un coup, et il devient impossible d'en filtrer un
 * et pas l'autre.
 */
describe('TripsService — le MÊME filtre borne les agrégats de période', () => {
  it('dailySummary : le conducteur descend dans le where des indicateurs', async () => {
    const { svc, superAdmin, dernierWhere } = build();
    await svc.dailySummary(superAdmin, { driverId: CONDUCTEUR });

    expect(dernierWhere()['driverId']).toBe(CONDUCTEUR);
  });

  it('dailySummary : « none » y devient null aussi', async () => {
    const { svc, superAdmin, dernierWhere } = build();
    await svc.dailySummary(superAdmin, { driverId: 'none' });

    expect(dernierWhere()['driverId']).toBeNull();
  });

  it('periodCharts : même règle — les courbes ne décrivent pas un autre périmètre que le tableau', async () => {
    const { svc, superAdmin, dernierWhere } = build();
    await svc.periodCharts(superAdmin, { driverId: CONDUCTEUR });

    expect(dernierWhere()['driverId']).toBe(CONDUCTEUR);
  });

  it('sans paramètre, les deux agrégats restent SANS filtre conducteur (comportement historique)', async () => {
    const { svc, superAdmin, appels } = build();
    await svc.dailySummary(superAdmin, {});
    await svc.periodCharts(superAdmin, {});

    expect(appels[0]!.where).not.toHaveProperty('driverId');
    expect(appels[1]!.where).not.toHaveProperty('driverId');
  });

  /**
   * La liste et les agrégats doivent produire EXACTEMENT la même clause. Deux expressions
   * écrites séparément auraient fini par diverger — et l'écart entre les deux périmètres est
   * précisément ce qui rendait les incohérences de cette page indéchiffrables.
   */
  it('liste et agrégats posent la même clause pour le même paramètre', async () => {
    for (const valeur of [CONDUCTEUR, 'none']) {
      const { svc, superAdmin, appels } = build();
      await svc.list(superAdmin, { driverId: valeur });
      await svc.dailySummary(superAdmin, { driverId: valeur });
      await svc.periodCharts(superAdmin, { driverId: valeur });

      const [liste, resume, courbes] = appels.map((a) => a.where!['driverId']);
      expect(resume).toEqual(liste);
      expect(courbes).toEqual(liste);
    }
  });

  it('les agrégats refusent aussi une valeur libre (ils lisent un @Query brut, sans DTO)', async () => {
    const { svc, superAdmin } = build();

    await expect(svc.dailySummary(superAdmin, { driverId: 'tous' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.periodCharts(superAdmin, { driverId: 'tous' })).rejects.toBeInstanceOf(BadRequestException);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE FIL ENTRE LA REQUÊTE ET LE SERVICE — CE QUE LES TESTS CI-DESSUS NE VOIENT PAS
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Tout ce qui précède appelle `TripsService` EN DIRECT. La règle est donc éprouvée, mais pas
 * le CÂBLAGE : retirer `driverId` des deux objets passés par `trips.controller.ts` à
 * `dailySummary` et `periodCharts` ne faisait rougir aucun test du dépôt. Le client envoyait
 * bien le paramètre, le service savait l'appliquer, et le fil entre les deux n'avait aucune
 * garde — ni `tsc` (ni `noUnusedParameters` ni `strict` complet), ni lint (aucune config
 * eslint côté api) ne signalent un `@Query()` devenu mort.
 *
 * Ce que ça coûterait : des INDICATEURS et des COURBES décrivant toute la flotte au-dessus
 * d'un tableau filtré sur une personne. Et contrairement à un écran manifestement faux, des
 * courbes ont l'air justes — c'est la forme la plus chère du défaut « le compteur annonce 622
 * et le tableau en affiche 100 ».
 *
 * Les deux cas filtrés et le cas sans filtre exigent des valeurs DIFFÉRENTES de la MÊME clé :
 * aucune assertion ne peut être satisfaite par sa voisine.
 */
describe('TripsController — le paramètre de la requête atteint vraiment le service', () => {
  function construireCtrl() {
    const dailySummary = jest.fn().mockResolvedValue([]);
    const periodCharts = jest.fn().mockResolvedValue({});
    const ctrl = new TripsController(
      { dailySummary, periodCharts } as never,
      { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') } as never,
      {} as never,
    );
    return { ctrl, dailySummary, periodCharts };
  }

  const REQ = {
    user: { id: 'u1', role: 'FLEET_ADMIN', fleetId: FLOTTE },
  } as never;

  const FROM = '2026-06-01';
  const TO = '2026-07-01';

  /** Le second argument (le bloc de critères) de la dernière invocation du service. */
  const criteres = (appel: jest.Mock): Record<string, unknown> =>
    appel.mock.calls[0]![1] as Record<string, unknown>;

  it('daily-summary transmet le conducteur', async () => {
    const { ctrl, dailySummary } = construireCtrl();

    await ctrl.dailySummary(REQ, undefined, undefined, FROM, TO, FLOTTE, CONDUCTEUR);

    expect(criteres(dailySummary)['driverId']).toBe(CONDUCTEUR);
  });

  it('period-charts transmet le conducteur — les courbes ne décrivent pas un autre périmètre que le tableau', async () => {
    const { ctrl, periodCharts } = construireCtrl();

    await ctrl.periodCharts(REQ, undefined, undefined, FROM, TO, FLOTTE, CONDUCTEUR);

    expect(criteres(periodCharts)['driverId']).toBe(CONDUCTEUR);
  });

  it('« none » traverse tel quel : la traduction en `null` appartient au service', async () => {
    const { ctrl, dailySummary } = construireCtrl();

    await ctrl.dailySummary(REQ, undefined, undefined, FROM, TO, FLOTTE, 'none');

    expect(criteres(dailySummary)['driverId']).toBe('none');
  });

  it('sans filtre : la clé vaut undefined, jamais null', async () => {
    const { ctrl, dailySummary, periodCharts } = construireCtrl();

    await ctrl.dailySummary(REQ, undefined, undefined, FROM, TO, FLOTTE);
    await ctrl.periodCharts(REQ, undefined, undefined, FROM, TO, FLOTTE);

    // `null` ne rendrait que les trajets orphelins : ce serait un filtre, pas son absence.
    expect(criteres(dailySummary)['driverId']).toBeUndefined();
    expect(criteres(periodCharts)['driverId']).toBeUndefined();
  });
});
