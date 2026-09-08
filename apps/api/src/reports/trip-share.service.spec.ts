import { GoneException, NotFoundException, BadRequestException } from '@nestjs/common';
import { TRIP_SHARE_MAX_ACTIFS_PAR_TRAJET } from '@vizyo/tracky-shared';
import { TripShareService } from './trip-share.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE PARTAGE PUBLIC D'UN TRAJET — CE QUI PROTÈGE UN ACCÈS SANS AUTHENTIFICATION
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Ce service ouvre des URL que N'IMPORTE QUI peut ouvrir. Il n'y a pas de mot de passe à
 * casser : il n'y a qu'un token, une horloge, et ce fichier.
 *
 * ⚠️ CHAQUE TEST ICI VERROUILLE UNE DÉCISION DE SÉCURITÉ, pas un affichage. Les régressions
 * qu'ils attrapent ne se voient pas à l'écran — un lien qui survit à son expiration, un `404`
 * devenu `403` qui permet d'énumérer, un token qui apparaît dans une liste — et se découvrent
 * quand quelqu'un signale avoir reçu ce qu'il n'aurait pas dû voir.
 */

const FLEET = 'aaaaaaaa-0000-4000-8000-000000000001';
const AUTRE_FLEET = 'bbbbbbbb-0000-4000-8000-000000000002';
const TRIP = 'cccccccc-0000-4000-8000-000000000003';
const USER = { id: 'u1', email: 'gestion@societe.fr', role: 'FLEET_ADMIN', fleetId: FLEET } as never;

interface Options {
  fleetIdDuTrajet?: string | null;
  viePrivee?: boolean;
  actifs?: number;
  lien?: Record<string, unknown> | null;
  perimetre?: string[] | 'ALL';
}

function service(o: Options = {}) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const cree = jest.fn(async ({ data }: any) => ({
    id: 'share-1', tripId: TRIP, fleetId: FLEET, token: data.token,
    duration: data.duration, expiresAt: data.expiresAt, createdAt: new Date('2026-09-07T10:00:00Z'),
    openCount: 0, firstOpenedAt: null, lastOpenedAt: null, lastOpenedFrom: null, revokedAt: null,
    createdBy: { firstName: 'Ada', lastName: 'Lovelace', email: 'ada@societe.fr' },
  }));
  const update = jest.fn().mockResolvedValue({});
  const prisma: any = {
    trip: {
      findUnique: jest.fn().mockResolvedValue(
        'fleetIdDuTrajet' in o && o.fleetIdDuTrajet === null
          ? null
          : {
              id: TRIP,
              fleetId: o.fleetIdDuTrajet ?? FLEET,
              vehicleId: 'v1',
              vehicle: { plate: 'AB-123-CD', privacyModeEnabled: !!o.viePrivee },
            },
      ),
    },
    tripShareLink: {
      count: jest.fn().mockResolvedValue(o.actifs ?? 0),
      create: cree,
      update,
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(o.lien ?? null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    position: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const config: any = { get: () => 'https://app-tracky.vizyoagency.com' };
  const activity: any = { record: jest.fn() };
  const acces: any = { getAccessibleVehicleIds: jest.fn().mockResolvedValue(o.perimetre ?? 'ALL') };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return { svc: new TripShareService(prisma, config, activity, acces), prisma, cree, update, activity };
}

/** Un lien vivant, tel que la base le rendrait. */
const lienVivant = (over: Record<string, unknown> = {}) => ({
  id: 'share-1',
  expiresAt: new Date(Date.now() + 3_600_000),
  revokedAt: null,
  trip: {
    startedAt: new Date('2026-09-06T08:00:00Z'),
    endedAt: new Date('2026-09-06T09:00:00Z'),
    durationSeconds: 3600, movingSeconds: 3000, distanceKm: 42.5, maxSpeed: 118,
    trackerId: 't1',
    vehicle: { plate: 'AB-123-CD', privacyModeEnabled: false },
  },
  ...over,
});

describe('Partage de trajet — la création', () => {
  it('rend une URL publique, hors de l’application', async () => {
    const { svc } = service();

    const r = await svc.creer(USER, TRIP, 'HOUR_24');

    // ⚠️ LE DÉFAUT D'ORIGINE : le bouton copiait `/reports?…&trip=…`, une adresse INTERNE.
    // Envoyée au conducteur concerné, elle affichait un écran de connexion.
    expect(r.url).toBe(`https://app-tracky.vizyoagency.com/t/${r.token}`);
    expect(r.url).not.toContain('/reports');
  });

  it('le token fait 22 caractères et ne contient rien du trajet', async () => {
    const { svc } = service();

    const r = await svc.creer(USER, TRIP, 'HOUR_24');

    expect(r.token).toHaveLength(22);
    // Un token dérivé de l'identifiant donnerait accès à TOUS les trajets dès qu'on comprend
    // la dérivation.
    expect(r.token).not.toContain(TRIP.slice(0, 8));
  });

  it('24 h par défaut — la durée demandée, et pas la plus longue', async () => {
    const { svc, cree } = service();

    await svc.creer(USER, TRIP, 'HOUR_24');

    const { expiresAt } = cree.mock.calls[0]![0].data;
    const heures = (expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(heures).toBeGreaterThan(23.9);
    expect(heures).toBeLessThan(24.1);
  });

  it('sept jours au maximum, une heure au minimum', async () => {
    for (const [duree, heuresAttendues] of [['HOUR_1', 1], ['DAY_7', 168]] as const) {
      const { svc, cree } = service();
      await svc.creer(USER, duree === 'HOUR_1' ? TRIP : TRIP, duree);
      const { expiresAt } = cree.mock.calls[0]![0].data;
      expect((expiresAt.getTime() - Date.now()) / 3_600_000).toBeCloseTo(heuresAttendues, 0);
    }
  });

  /**
   * ⚠️ LE MODE VIE PRIVÉE INTERDIT LE PARTAGE. Ce mode existe pour qu'un trajet ne soit PAS
   * regardé ; en publier le tracé sur une URL sans authentification le viderait de son sens,
   * et par le chemin le plus difficile à rattraper — un lien déjà envoyé.
   */
  it('🔴 un véhicule en mode vie privée ne se partage pas', async () => {
    const { svc } = service({ viePrivee: true });

    await expect(svc.creer(USER, TRIP, 'HOUR_24')).rejects.toBeInstanceOf(BadRequestException);
  });

  /**
   * ⚠️ LE PLAFOND REND L'ÉCRAN DE SURVEILLANCE UTILE. Sans lui, un trajet finit avec quinze
   * liens ouverts dont personne ne sait à qui ils ont été envoyés ; avec lui, re-partager
   * oblige à révoquer — donc à REGARDER la liste.
   */
  it('trois liens vivants au maximum par trajet', async () => {
    const { svc } = service({ actifs: TRIP_SHARE_MAX_ACTIFS_PAR_TRAJET });

    await expect(svc.creer(USER, TRIP, 'HOUR_24')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('le plafond ne compte QUE les liens vivants', async () => {
    const { svc, prisma } = service();

    await svc.creer(USER, TRIP, 'HOUR_24');

    const where = prisma.tripShareLink.count.mock.calls[0]![0].where;
    expect(where.revokedAt).toBeNull();
    expect(where.expiresAt.gt).toBeInstanceOf(Date);
  });

  it('⚠️ le trajet d’une AUTRE société est introuvable, pas interdit', async () => {
    // `404` et non `403` : distinguer permettrait d'énumérer les trajets des autres clients.
    const { svc } = service({ fleetIdDuTrajet: AUTRE_FLEET });

    await expect(svc.creer(USER, TRIP, 'HOUR_24')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('⚠️ un véhicule hors du périmètre de l’utilisateur, de même', async () => {
    // Le périmètre passe par `VehicleAccessService` : c'est lui qui résout les accès par
    // GROUPE. Un contrôle qui l'ignorerait laisserait partager un véhicule qu'on ne peut
    // même pas regarder.
    const { svc } = service({ perimetre: ['v2', 'v3'] });

    await expect(svc.creer(USER, TRIP, 'HOUR_24')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('l’ouverture d’un accès public est TRACÉE dans l’activité système', async () => {
    // Ce n'est pas une consultation, c'est une décision : elle doit se retrouver des mois
    // plus tard, y compris si le lien a été révoqué et sa ligne purgée depuis.
    const { svc, activity } = service();

    await svc.creer(USER, TRIP, 'HOUR_24');

    expect(activity.record).toHaveBeenCalledTimes(1);
    expect(activity.record.mock.calls[0]![0].action).toBe('trip_share_created');
  });
});

describe('Partage de trajet — la consultation publique', () => {
  it('sert le trajet quand le lien est vivant', async () => {
    const { svc } = service({ lien: lienVivant() });

    const r = await svc.consulterPublic('unTokenQuelconque22ca');

    expect(r.plate).toBe('AB-123-CD');
    expect(r.distanceKm).toBe(42.5);
  });

  /**
   * ⚠️ QUATRE CAUSES, UN SEUL `410`. Inexistant, expiré, révoqué, ou véhicule passé en mode
   * vie privée depuis le partage : le destinataire reçoit exactement la même réponse.
   * Distinguer « ce token n'existe pas » de « ce token a expiré » permet d'énumérer — et
   * « ce token a existé » est déjà une information.
   */
  it('🔴 les quatre causes rendent le même 410', async () => {
    const cas: Record<string, Record<string, unknown> | null> = {
      inexistant: null,
      expire: lienVivant({ expiresAt: new Date(Date.now() - 1000) }),
      revoque: lienVivant({ revokedAt: new Date() }),
      viePrivee: lienVivant({
        trip: { ...lienVivant().trip, vehicle: { plate: 'AB-123-CD', privacyModeEnabled: true } },
      }),
    };

    for (const [nom, lien] of Object.entries(cas)) {
      const { svc } = service({ lien });
      await expect(svc.consulterPublic('t')).rejects.toBeInstanceOf(GoneException);
      // Et le MÊME message : un texte différent trahirait la cause aussi sûrement qu'un code.
      await expect(svc.consulterPublic('t')).rejects.toThrow(/n'est plus valide/);
      expect(nom).toBeTruthy();
    }
  });

  /**
   * ⚠️ LA VIE PRIVÉE EST REVÉRIFIÉE À CHAQUE OUVERTURE, pas seulement à la création. Un
   * gestionnaire qui bascule un véhicule en vie privée doit couper les liens DÉJÀ envoyés —
   * sinon le réglage ne vaut que pour l'avenir, ce qui n'est pas ce qu'il promet.
   */
  it('un véhicule basculé en vie privée APRÈS le partage coupe le lien', async () => {
    const { svc } = service({
      lien: lienVivant({
        trip: { ...lienVivant().trip, vehicle: { plate: 'AB-123-CD', privacyModeEnabled: true } },
      }),
    });

    await expect(svc.consulterPublic('t')).rejects.toBeInstanceOf(GoneException);
  });

  /**
   * ⚠️ LA LISTE EST LE CONTRAT : ce que le DTO n'écrit pas ne sort pas. Le destinataire n'a
   * pas de compte et n'a pas à savoir quelle société l'emploie, ni qui conduisait.
   */
  it('ne divulgue ni la société, ni le conducteur, ni le moindre identifiant interne', async () => {
    const { svc } = service({ lien: lienVivant() });

    const r = await svc.consulterPublic('t');
    const champs = Object.keys(r).sort();

    expect(champs).toEqual([
      'avgSpeedKmh', 'distanceKm', 'durationSeconds', 'endedAt', 'expiresAt',
      'maxSpeedKmh', 'path', 'plate', 'speedsKmh', 'startedAt',
    ]);
  });

  /**
   * ── LE TRACÉ EST COLORÉ PAR LA VITESSE, comme le rejeu de l'application ──────────────
   *
   * Le destinataire voyait un trait vert uni ; le gestionnaire, un rejeu coloré par bande
   * de vitesse. `speedsKmh` porte la vitesse du point de MÊME INDEX que `path` — entière,
   * en km/h — et rien d'autre : pas d'horodatage, pas de contact, pas de boîtier.
   */
  it('🔴 le tracé porte une vitesse entière par point, alignée sur `path`', async () => {
    const { svc, prisma } = service({ lien: lienVivant() });
    prisma.position.findMany.mockResolvedValue([
      { lat: 43.6, lng: 1.4, speedKmh: 12.4 },
      { lat: 43.61, lng: 1.41, speedKmh: 88.6 },
      { lat: 43.62, lng: 1.42, speedKmh: null },
    ]);

    const r = await svc.consulterPublic('t');

    expect(r.path).toEqual([[1.4, 43.6], [1.41, 43.61], [1.42, 43.62]]);
    // Arrondie : un destinataire n'a que faire de 88,6. Absente : 0, jamais « undefined ».
    expect(r.speedsKmh).toEqual([12, 89, 0]);
  });

  /**
   * ── LA GÉOMÉTRIE VIENT DE LA POLYLIGNE RECALÉE, LES VITESSES DES RELEVÉS ────────────────
   *
   * Constaté en production le 2026-09-08 : les positions stockées sont creuses (une trame
   * toutes les 20 à 100 s à 100 km/h, jusqu'à 2,5 km sans rien). Tracer les positions coupe
   * les virages. Quand le trajet porte un tracé recalé sur les routes, c'est lui qu'on sert,
   * et chaque sommet reçoit la vitesse du relevé le plus proche.
   */
  it('🔴 le tracé public suit la polyligne recalée quand elle existe, avec les vitesses des relevés', async () => {
    const recale = [
      { lat: 43.600, lng: 1.400 }, { lat: 43.601, lng: 1.401 }, { lat: 43.602, lng: 1.402 }, { lat: 43.603, lng: 1.403 },
    ];
    const { svc, prisma } = service({
      lien: lienVivant({ trip: { ...lienVivant().trip, polyline: JSON.stringify(recale.slice(0, 2)), polylineMatched: JSON.stringify(recale) } }),
    });
    // Deux relevés seulement, aux extrémités : 20 km/h au départ, 80 à l'arrivée.
    prisma.position.findMany.mockResolvedValue([
      { lat: 43.600, lng: 1.400, speedKmh: 20 },
      { lat: 43.603, lng: 1.403, speedKmh: 80 },
    ]);

    const r = await svc.consulterPublic('t');

    expect(r.path).toEqual([[1.400, 43.600], [1.401, 43.601], [1.402, 43.602], [1.403, 43.603]]);
    expect(r.speedsKmh).toEqual([20, 20, 80, 80]);
  });

  it('sans tracé recalé, la polyligne brute sert de géométrie ; sans polyligne, les positions', async () => {
    const brute = [{ lat: 43.600, lng: 1.400 }, { lat: 43.605, lng: 1.405 }];
    const { svc, prisma } = service({
      lien: lienVivant({ trip: { ...lienVivant().trip, polyline: JSON.stringify(brute), polylineMatched: null } }),
    });
    prisma.position.findMany.mockResolvedValue([{ lat: 43.600, lng: 1.400, speedKmh: 33 }]);

    const r = await svc.consulterPublic('t');

    expect(r.path).toEqual([[1.400, 43.600], [1.405, 43.605]]);
    expect(r.speedsKmh).toEqual([33, 33]);
  });

  /**
   * ⚠️ LA DÉCIMATION DOIT DÉCIMER LES DEUX LISTES DU MÊME PAS. Une vitesse décalée d'un
   * index peindrait l'autoroute en vert et la ville en rouge — un tracé faux, avec l'air
   * d'être précis.
   */
  it('🔴 la décimation à 1 500 points garde les vitesses alignées, dernier point compris', async () => {
    const { svc, prisma } = service({ lien: lienVivant() });
    const positions = Array.from({ length: 4000 }, (_, i) => ({
      lat: 43 + i / 1e4, lng: 1 + i / 1e4, speedKmh: i % 200,
    }));
    prisma.position.findMany.mockResolvedValue(positions);

    const r = await svc.consulterPublic('t');

    expect(r.path.length).toBeLessThanOrEqual(1_501);
    expect(r.speedsKmh.length).toBe(r.path.length);
    // Chaque vitesse est celle du point de même index — vérifié sur tout le tracé.
    for (let i = 0; i < r.path.length; i++) {
      const src = positions.find((p) => p.lng === r.path[i]![0] && p.lat === r.path[i]![1])!;
      expect(r.speedsKmh[i]).toBe(src.speedKmh);
    }
    // Le dernier point est toujours servi, avec SA vitesse.
    const dernier = positions[positions.length - 1]!;
    expect(r.path[r.path.length - 1]).toEqual([dernier.lng, dernier.lat]);
    expect(r.speedsKmh[r.speedsKmh.length - 1]).toBe(dernier.speedKmh);
  });

  it('l’échéance est servie : le destinataire doit savoir quand le lien meurt', async () => {
    const { svc } = service({ lien: lienVivant() });

    const r = await svc.consulterPublic('t');

    expect(r.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  /**
   * ⚠️ LA VITESSE MOYENNE EST CELLE DU PRODUIT : distance ÷ temps ROULANT. Un destinataire
   * qui compare ce chiffre à celui que le gestionnaire lui a lu au téléphone doit lire le
   * même nombre — sinon c'est le produit qui a l'air de se contredire.
   */
  it('la vitesse moyenne est distance ÷ temps roulant, comme partout', async () => {
    const { svc } = service({ lien: lienVivant() });

    const r = await svc.consulterPublic('t');

    // 42,5 km ÷ 3000 s roulants = 51 km/h (et non 42,5 sur l'heure totale).
    expect(r.avgSpeedKmh).toBe(51);
  });

  it('l’ouverture est comptée — c’est ce qui rend la révocation éclairée', async () => {
    const { svc, prisma } = service({ lien: lienVivant() });

    await svc.consulterPublic('t', '92.184.1.2');
    await new Promise((r) => setImmediate(r));

    const data = prisma.tripShareLink.update.mock.calls[0]![0].data;
    expect(data.openCount).toEqual({ increment: 1 });
    // ⚠️ TRONQUÉE : distinguer deux destinataires, pas identifier une personne qui n'a ni
    // compte ni consentement (RGPD).
    expect(data.lastOpenedFrom).toBe('92.184.x.x');
  });
});

describe('Partage de trajet — la révocation', () => {
  it('coupe le lien, et le trace', async () => {
    const { svc, prisma, activity } = service({
      lien: { id: 'share-1', fleetId: FLEET, tripId: TRIP, revokedAt: null, trip: { vehicleId: 'v1', vehicle: { plate: 'AB-123-CD' } } },
    });

    await svc.revoquer(USER, 'share-1');

    expect(prisma.tripShareLink.update.mock.calls[0]![0].data.revokedAt).toBeInstanceOf(Date);
    expect(activity.record.mock.calls[0]![0].action).toBe('trip_share_revoked');
  });

  it('révoquer deux fois n’est pas une erreur : l’état voulu est le même', async () => {
    const { svc, prisma } = service({
      lien: { id: 'share-1', fleetId: FLEET, tripId: TRIP, revokedAt: new Date(), trip: { vehicleId: 'v1', vehicle: { plate: 'AB' } } },
    });

    await expect(svc.revoquer(USER, 'share-1')).resolves.toBeUndefined();
    expect(prisma.tripShareLink.update).not.toHaveBeenCalled();
  });

  it('⚠️ on ne révoque pas le lien d’une autre société', async () => {
    const { svc } = service({
      lien: { id: 'share-1', fleetId: AUTRE_FLEET, tripId: TRIP, revokedAt: null, trip: { vehicleId: 'v1', vehicle: { plate: 'AB' } } },
    });

    await expect(svc.revoquer(USER, 'share-1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
