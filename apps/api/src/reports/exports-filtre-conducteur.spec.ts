/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LES EXPORTS SUIVENT LE FILTRE CONDUCTEUR (F13, seconde moitié)
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * ── LE DÉFAUT QUE CES TESTS FIGENT ─────────────────────────────────────────────────────────
 *
 * L'écran Rapports se filtre sur une personne : le tableau, le résumé journalier, les
 * graphiques et la synthèse suivent. Les EXPORTS, eux, ne suivaient rien. Un gestionnaire
 * filtré sur un conducteur qui cliquait « CSV trajets » recevait TOUS les trajets de la
 * société ; son PDF et son Excel décrivaient une autre population que son écran.
 *
 * C'est le défaut le plus cher de ce produit — un fichier qui contredit l'écran qui l'a
 * produit — et il se paie deux fois : le fichier part par courriel, ressort d'un classeur des
 * mois plus tard, et personne ne peut plus le rapprocher de l'écran d'origine.
 *
 * ── LE JEU D'ESSAI ─────────────────────────────────────────────────────────────────────────
 *
 * DEUX conducteurs se partagent UN véhicule. C'est le seul jeu qui prouve quelque chose : un
 * filtre qui ne saurait que retirer des véhicules entiers passerait à côté, puisque le
 * véhicule reste dans le périmètre dans les deux cas. Un troisième trajet, sans conducteur,
 * tient le mot-clé `none` — le cas de 1 905 trajets sur 1 956 mesuré chez « mh cars ».
 *
 * ── CE QUI EST VERROUILLÉ ──────────────────────────────────────────────────────────────────
 *
 *  1. le CSV trajets filtré ne contient QUE les lignes du conducteur demandé ;
 *  2. `none` rend les trajets SANS conducteur, et sans filtre RIEN ne change (la clé
 *     `driverId` n'est même pas écrite — posée à `null`, elle rendrait les seuls orphelins) ;
 *  3. le PDF (GET et POST) est CALCULÉ avec le filtre, et le DIT — un document filtré et muet
 *     est le même piège, déplacé dans un fichier qui survivra à l'écran ;
 *  4. l'Excel (véhicule et périmètre) borne ses trajets et nomme la personne ;
 *  5. les types de CSV SANS conducteur sont REFUSÉS, avec la raison ;
 *  6. une valeur qui n'est ni un UUID ni `none` est refusée par les quatre routes — même
 *     règle que la liste et la synthèse, jamais une seconde écriture.
 */
import { BadRequestException, ValidationPipe } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import { resolveDriverScope } from '../common/driver-scope';
import { parisDayStart } from '../common/utils/datetime';
import { ReportCsvService } from './report-csv.service';
import { ReportExcelService } from './report-excel.service';
import { ReportPdfService } from './report-pdf.service';
import { ReportsController } from './reports.controller';
import type { FleetStatsReport } from './reports-stats.service';
import type { AuthenticatedRequest } from '../auth/guards/jwt-auth.guard';
import type { AuthUser } from '../auth/types/auth-user';

const FLEET_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
/** UUID : le filtre les exige (cf. `common/driver-scope`), un « d1 » serait refusé. */
const D1 = '11111111-1111-4111-8111-111111111111';
const D2 = '22222222-2222-4222-8222-222222222222';
const VEH = 'bbbbbbbb-0000-4000-8000-000000000009';

const FROM = '2026-06-01';
const TO = '2026-07-01';

const NOMS: Record<string, { firstName: string; lastName: string }> = {
  [D1]: { firstName: 'Sohaib', lastName: 'Hamanni' },
  [D2]: { firstName: 'Amine', lastName: 'Berrada' },
};

/**
 * UN SEUL VÉHICULE, DEUX CONDUCTEURS, ET UN TRAJET ORPHELIN.
 *
 * ⚠️ C'est le point de tout ce fichier : filtrer sur D1 doit amputer le véhicule sans le
 * faire disparaître. Un jeu où chaque conducteur aurait son propre véhicule laisserait passer
 * un filtre qui ne saurait raisonner que par véhicule.
 */
const TRAJETS = [
  { id: 't1', driverId: D1, distanceKm: 120, startedAt: new Date('2026-06-02T08:00:00.000Z') },
  { id: 't2', driverId: D2, distanceKm: 80, startedAt: new Date('2026-06-03T08:00:00.000Z') },
  { id: 't3', driverId: null, distanceKm: 30, startedAt: new Date('2026-06-04T08:00:00.000Z') },
];

// ---------------------------------------------------------------------------------------
// 1) CSV « trajets » — le seul export CSV qui PEUT suivre un conducteur
// ---------------------------------------------------------------------------------------

/**
 * Le simulacre HONORE le filtre : il lit `where.driverId` et ne rend que les lignes
 * correspondantes. Un faux qui rendrait toujours les mêmes trois trajets ne prouverait rien
 * du contenu du fichier — seulement qu'une clé a été écrite quelque part.
 *
 * Posé au niveau du FICHIER parce que deux blocs s'en servent : celui qui appelle le service
 * en direct, et celui qui le monte dans le contrôleur pour suivre le nom du fichier jusqu'à
 * l'en-tête HTTP.
 */
function makePrisma() {
  const capture: { where?: Record<string, unknown> } = {};
  return {
    capture,
    prisma: {
      trip: {
        findMany: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
          capture.where = where;
          const attendu = where['driverId'];
          const lignes = TRAJETS
            .filter((t) => attendu === undefined || t.driverId === attendu)
            .map((t) => ({
              id: t.id,
              vehicle: { plate: 'AA-111-AA', groups: [] },
              notesUpdatedBy: null,
              driver: t.driverId ? { id: t.driverId, ...NOMS[t.driverId]! } : null,
              startedAt: t.startedAt,
              endedAt: new Date(t.startedAt.getTime() + 3_600_000),
              durationSeconds: 3600,
              distanceKm: t.distanceKm,
              maxSpeed: 90,
              avgSpeed: 45,
              positionCount: 100,
              startLat: 43.6, startLng: 1.44, endLat: 43.7, endLng: 1.5,
              driverId: t.driverId,
              driverSource: t.driverId ? 'MANUAL' : null,
              notes: null,
              notesUpdatedAt: null,
            }));
          return Promise.resolve(lignes);
        }),
      },
    } as never,
  };
}

/** Les identifiants de trajet présents dans le corps du CSV. */
function idsDuCsv(body: string): string[] {
  return TRAJETS.filter((t) => body.includes(t.id)).map((t) => t.id);
}

describe('ReportCsvService.trips — le filtre conducteur descend dans le where', () => {
  it('filtré sur un conducteur : SEULES ses lignes sortent, même véhicule partagé', async () => {
    const { prisma, capture } = makePrisma();

    const res = await new ReportCsvService(prisma).trips(
      FLEET_ID, parisDayStart(FROM), parisDayStart(TO), 'ALL', D1,
    );

    expect(capture.where!['driverId']).toBe(D1);
    expect(idsDuCsv(res.body)).toEqual(['t1']);
    // Le trajet de l'AUTRE conducteur du MÊME véhicule ne se glisse pas dedans.
    expect(res.body).not.toContain('Berrada');
    expect(res.body).toContain('Hamanni');
  });

  it('« none » : les trajets SANS conducteur, et rien d’autre', async () => {
    const { prisma, capture } = makePrisma();

    const res = await new ReportCsvService(prisma).trips(
      FLEET_ID, parisDayStart(FROM), parisDayStart(TO), 'ALL', null,
    );

    // ⚠️ `null` EST un filtre : la clé doit être écrite, et à `null`.
    expect(capture.where).toHaveProperty('driverId', null);
    expect(idsDuCsv(res.body)).toEqual(['t3']);
  });

  it('sans filtre : la clé driverId n’est PAS écrite (pas même à null)', async () => {
    const { prisma, capture } = makePrisma();

    const res = await new ReportCsvService(prisma).trips(
      FLEET_ID, parisDayStart(FROM), parisDayStart(TO), 'ALL',
    );

    /**
     * ⚠️ LE PIÈGE EXACT DE CE LOT. Écrire `where.driverId = null` quand aucun filtre n'est
     * demandé ne rendrait que les trajets orphelins — chez « mh cars », 1 905 sur 1 956 : le
     * CSV aurait l'air plein, et il manquerait tous les trajets attribués.
     */
    expect(capture.where).not.toHaveProperty('driverId');
    expect(idsDuCsv(res.body)).toEqual(['t1', 't2', 't3']);
  });

  it('le filtre conducteur n’efface pas le périmètre véhicule : les deux tiennent ensemble', async () => {
    const { prisma, capture } = makePrisma();

    await new ReportCsvService(prisma).trips(
      FLEET_ID, parisDayStart(FROM), parisDayStart(TO), [VEH], D1,
    );

    expect(capture.where!['vehicleId']).toEqual({ in: [VEH] });
    expect(capture.where!['driverId']).toBe(D1);
    expect(capture.where!['fleetId']).toBe(FLEET_ID);
    /**
     * ⚠️ LA TROISIÈME BORNE, CELLE QUI EST DÉJÀ TOMBÉE UNE FOIS. Le mode vie privée (RGPD)
     * exclut les trajets d'un véhicule actuellement en mode privé. Le 2026-09-05, ce même
     * dépôt a découvert des véhicules privés qui abondaient des lignes d'imputation : le
     * garde protégeait la création d'une ligne, pas son abondement. Aucune spec ne figeait ce
     * `NOT` dans le `where` du CSV ; l'y retirer laissait passer les trois assertions
     * ci-dessus, dans le test qui s'intitule pourtant « n'efface pas le périmètre ».
     */
    expect(capture.where!['NOT']).toEqual({ vehicle: { privacyModeEnabled: true } });
  });

  /**
   * ══ LE NOM DU FICHIER, SEUL ENDROIT OÙ UN CSV PEUT DIRE SON FILTRE ═════════════════════
   *
   * Le PDF écrit le conducteur sous le nom de la société, l'Excel dans le titre de sa feuille.
   * Le CSV n'a que son nom : une ligne de prose au-dessus des colonnes serait lue comme
   * l'en-tête. Sans marque, deux exports de la même période s'appellent pareil — et sous
   * « none » ils sont INDISCERNABLES, puisque `driver_id` et `driver_name` sont vides sur
   * toutes les lignes des deux (1 905 trajets sur 1 956 chez « mh cars »). Le navigateur
   * suffixe « (1) », le fichier part par courriel, et rien ne dit qu'il est amputé.
   */
  describe('le NOM du fichier porte le filtre — sinon deux exports différents s’appellent pareil', () => {
    /** Le nom rendu pour une portée donnée, sur le jeu d'essai de ce fichier. */
    async function nomPour(driverScope?: string | null): Promise<string> {
      const { prisma } = makePrisma();
      const res = await new ReportCsvService(prisma).trips(
        FLEET_ID, parisDayStart(FROM), parisDayStart(TO), 'ALL', driverScope,
      );
      return res.filename;
    }

    it('sans filtre : le nom d’avant, au caractère près', async () => {
      // Le contrat historique. La marque ne doit exister QUE quand un filtre est posé —
      // renommer les exports non filtrés casserait les classements de qui archive au mois.
      expect(await nomPour()).toBe('tracky-trips-2026-06-01_2026-06-30.csv');
    });

    it('« none » : le nom annonce les trajets sans conducteur', async () => {
      expect(await nomPour(null)).toBe('tracky-trips-2026-06-01_2026-06-30-sans-conducteur.csv');
    });

    it('conducteur nommé : le nom porte son identifiant, la colonne driver_name porte son nom', async () => {
      const nom = await nomPour(D1);

      expect(nom).toContain('-conducteur-');
      // Huit caractères de l'identifiant : assez pour distinguer deux exports, sans faire
      // voyager un nom propre dans l'intitulé d'une pièce jointe (le corps le porte déjà).
      expect(nom).toContain(D1.slice(0, 8));
      expect(nom).not.toContain('Hamanni');
    });

    /**
     * ⚠️ LE TEST QUI COMPTE VRAIMENT. Peu importe la forme du suffixe : ce qui ne doit jamais
     * revenir, c'est DEUX populations différentes sous le MÊME nom.
     */
    it('les trois portées rendent trois noms DIFFÉRENTS', async () => {
      const noms = [await nomPour(), await nomPour(null), await nomPour(D1)];

      expect(new Set(noms).size).toBe(3);
    });

    /**
     * ⚠️ LES DEUX MARQUES DOIVENT TENIR ENSEMBLE. `wrap` signale un export tronqué (plafond
     * mémoire atteint) en réécrivant `.csv` en `-PARTIEL.csv`. La marque conducteur doit donc
     * rester DEVANT l'extension : posée après (« …csv-sans-conducteur »), elle ferait taire la
     * troncature, et un fichier amputé DEUX fois — par le filtre, puis par le plafond —
     * arriverait sous un nom qui n'en dit rien. C'est le seul point où les deux règles de
     * nommage se croisent, et aucune des deux ne connaît l'autre.
     *
     * Le seuil (50 000 lignes) n'est pas réglable : ce test coûte donc quelques secondes.
     * ⚠️ NE PAS RÉDUIRE LE JEU POUR L'ACCÉLÉRER — sous le seuil, il ne teste plus rien et
     * reste vert.
     */
    it('export TRONQUÉ et filtré : les deux marques, et « -PARTIEL » en dernier', async () => {
      const lignes = Array.from({ length: 50_000 }, (_, i) => ({
        id: `t${i}`,
        vehicle: { plate: 'AA-111-AA', groups: [] },
        notesUpdatedBy: null,
        driver: null,
        startedAt: new Date('2026-06-02T08:00:00.000Z'),
        endedAt: null,
        durationSeconds: 3600,
        distanceKm: 12,
        maxSpeed: 90, avgSpeed: 45, positionCount: 100,
        startLat: 43.6, startLng: 1.44, endLat: 43.7, endLng: 1.5,
        driverId: null, driverSource: null, notes: null, notesUpdatedAt: null,
      }));
      const prisma = { trip: { findMany: jest.fn().mockResolvedValue(lignes) } } as never;

      const res = await new ReportCsvService(prisma).trips(
        FLEET_ID, parisDayStart(FROM), parisDayStart(TO), 'ALL', null,
      );

      expect(res.filename).toBe('tracky-trips-2026-06-01_2026-06-30-sans-conducteur-PARTIEL.csv');
    }, 60_000);
  });
});

// ---------------------------------------------------------------------------------------
// 2) Le contrôleur — les quatre routes d'export
// ---------------------------------------------------------------------------------------

function requete(role: UserRole = UserRole.FLEET_ADMIN): AuthenticatedRequest {
  return {
    user: {
      id: 'user-1', authUserId: 'auth-1', email: 'chef@societe.fr',
      firstName: 'Ada', lastName: 'Lovelace', role,
      fleetId: FLEET_ID, isActive: true, isOwner: false, permissions: null,
    } as AuthUser,
  } as unknown as AuthenticatedRequest;
}

/** Réponse Express minimale : on ne teste pas le transport, seulement ce qui est calculé. */
function reponse() {
  return { setHeader: jest.fn(), send: jest.fn() } as never;
}

const RAPPORT: FleetStatsReport = {
  fleet: { id: FLEET_ID, name: 'Société test' },
  period: { from: '2026-06-01T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z', days: 30 },
  vehicles: {
    total: 1, activeDuringPeriod: 1, exploited: 1, dormant: 0, withoutTracker: 0,
    dormantVehicles: [], idleVehicles: [], idleTotal: 0, hiddenByPrivacy: 0,
  },
  trips: {
    count: 1, totalKm: 120, totalDurationHours: 2, avgKmPerVehicle: 120,
    avgKmBasisVehicles: 1, avgKmBasisKm: 120, avgSpeedKmh: 60, maxSpeedKmh: 90,
    speedingCount: 0, worstOverKmh: 0,
  },
  alerts: { total: 4, byType: [{ type: 'OVERSPEED', count: 4 }], bySeverity: [{ severity: 'WARNING', count: 4 }] },
  consumption: {
    estimatedLiters: 10, estimatedCostEur: 18, fuelPriceEurL: 1.8,
    observedPriceEurL: null, estimatedCostAtObservedEur: null,
    observedSampleCount: 0, estimatedCo2Kg: 0, idleSecondsTotal: 0,
  },
  topVehicles: [],
  recentTrips: [],
};

/**
 * @param csvReel monte le VRAI `ReportCsvService` à la place des simulacres. À n'utiliser que
 *   pour les tests qui portent sur ce que le service PRODUIT (son nom de fichier) : partout
 *   ailleurs, le simulacre dit mieux ce que le contrôleur lui a TRANSMIS.
 */
function construire(csvReel?: ReportCsvService) {
  const record = jest.fn();
  const compute = jest.fn().mockResolvedValue(RAPPORT);
  const pdfGenerate = jest.fn().mockResolvedValue(Buffer.from('%PDF-1.4'));
  const csvTrips = jest.fn().mockResolvedValue({ filename: 'tracky-trips.csv', contentType: 'text/csv', body: 'a;b' });
  const csvAlerts = jest.fn().mockResolvedValue({ filename: 'tracky-alerts.csv', contentType: 'text/csv', body: 'a;b' });
  const csvPositions = jest.fn().mockResolvedValue({ filename: 'tracky-positions.csv', contentType: 'text/csv', body: 'a;b' });
  const csvCommands = jest.fn().mockResolvedValue({ filename: 'tracky-commands.csv', contentType: 'text/csv', body: 'a;b' });
  const excelGenerate = jest.fn().mockResolvedValue({ buffer: Buffer.from('xlsx'), filename: 'tracky-veh.xlsx' });
  const excelScope = jest.fn().mockResolvedValue({ buffer: Buffer.from('xlsx'), filename: 'tracky-parc.xlsx' });

  const prisma = {
    fleet: { findFirst: jest.fn().mockResolvedValue({ id: FLEET_ID }) },
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({ fleetId: FLEET_ID }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    trip: { findUnique: jest.fn().mockResolvedValue({ vehicle: { fleetId: FLEET_ID } }) },
    // Le nom du conducteur, cherché DANS la société du rapport.
    driver: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { id: string; fleetId: string } }) =>
        Promise.resolve(where.fleetId === FLEET_ID && NOMS[where.id] ? NOMS[where.id] : null),
      ),
    },
  } as never;

  const controller = new ReportsController(
    { compute } as never,
    { generate: pdfGenerate } as never,
    csvReel ?? ({ trips: csvTrips, alerts: csvAlerts, positions: csvPositions, commands: csvCommands } as never),
    { generate: excelGenerate, generateScope: excelScope } as never,
    {} as never,
    {} as never,
    prisma,
    { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') } as never,
    { record } as never,
  );

  return { controller, compute, pdfGenerate, csvTrips, csvAlerts, csvPositions, csvCommands, excelGenerate, excelScope, record };
}

/** Le bloc `filters` (5e argument) passé à `ReportsStatsService.compute`. */
function filtresDuCalcul(compute: jest.Mock): Record<string, unknown> {
  return (compute.mock.calls[0]![4] ?? {}) as Record<string, unknown>;
}

/** Les options passées à `ReportPdfService.generate`. */
function optionsDuPdf(pdfGenerate: jest.Mock): Record<string, unknown> {
  return (pdfGenerate.mock.calls[0]![1] ?? {}) as Record<string, unknown>;
}

describe('GET /reports/pdf — le raccourci sans modale suit le filtre, lui aussi', () => {
  it('le rapport est CALCULÉ avec le conducteur, et le document le DIT', async () => {
    const { controller, compute, pdfGenerate } = construire();

    await controller.pdfDownload(requete(), reponse(), FLEET_ID, FROM, TO, D1);

    expect(filtresDuCalcul(compute)['driverId']).toBe(D1);
    // ⚠️ Le calcul ne suffit pas : un PDF juste et muet reste un piège une fois envoyé.
    expect(String(optionsDuPdf(pdfGenerate)['driverLabel'])).toContain('Sohaib Hamanni');
  });

  it('« none » : le document annonce les trajets sans conducteur', async () => {
    const { controller, compute, pdfGenerate } = construire();

    await controller.pdfDownload(requete(), reponse(), FLEET_ID, FROM, TO, 'none');

    expect(filtresDuCalcul(compute)['driverId']).toBe('none');
    expect(String(optionsDuPdf(pdfGenerate)['driverLabel'])).toContain('sans conducteur');
  });

  it('sans filtre : aucune mention de conducteur (pas de bruit permanent)', async () => {
    const { controller, compute, pdfGenerate } = construire();

    await controller.pdfDownload(requete(), reponse(), FLEET_ID, FROM, TO);

    expect(filtresDuCalcul(compute)['driverId']).toBeUndefined();
    expect(optionsDuPdf(pdfGenerate)['driverLabel']).toBeUndefined();
  });

  /**
   * ⚠️ Un identifiant d'une AUTRE société ne rend aucun trajet (les `where` portent déjà
   * `fleetId`). Un PDF à zéro ligne sans explication se lirait « ce conducteur n'a pas
   * roulé », ce qui est faux : le document dit qu'il est introuvable ici.
   */
  it('conducteur inconnu de la société : le document le dit, il ne se tait pas', async () => {
    const { controller, pdfGenerate } = construire();
    const AILLEURS = '99999999-9999-4999-8999-999999999999';

    await controller.pdfDownload(requete(), reponse(), FLEET_ID, FROM, TO, AILLEURS);

    expect(String(optionsDuPdf(pdfGenerate)['driverLabel'])).toContain('introuvable');
  });

  it('une valeur qui n’est ni un UUID ni « none » est refusée', async () => {
    const { controller, compute } = construire();

    await expect(
      controller.pdfDownload(requete(), reponse(), FLEET_ID, FROM, TO, 'OR 1=1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    // Rien n'a été calculé : le refus tombe avant la moindre requête.
    expect(compute).not.toHaveBeenCalled();
  });
});

describe('POST /reports/pdf — la variante configurable rend le MÊME périmètre', () => {
  it('le conducteur du corps descend dans le calcul et dans l’en-tête du document', async () => {
    const { controller, compute, pdfGenerate } = construire();

    await controller.pdfDownloadConfigured(requete(), reponse(), {
      fleetId: FLEET_ID, from: FROM, to: TO, driverId: D2,
    } as never);

    expect(filtresDuCalcul(compute)['driverId']).toBe(D2);
    expect(String(optionsDuPdf(pdfGenerate)['driverLabel'])).toContain('Amine Berrada');
  });

  /**
   * Le périmètre VÉHICULE était déjà annoncé (`scopeLabel`) ; le conducteur s'ajoute sans le
   * remplacer. Un document qui perdrait l'un en gagnant l'autre serait une régression muette.
   */
  it('les deux périmètres coexistent dans le document : véhicule ET conducteur', async () => {
    const { controller, pdfGenerate, compute } = construire();

    await controller.pdfDownloadConfigured(requete(), reponse(), {
      fleetId: FLEET_ID, from: FROM, to: TO, vehicleIds: [VEH], driverId: D1,
    } as never);

    expect(filtresDuCalcul(compute)['vehicleIds']).toEqual([VEH]);
    expect(filtresDuCalcul(compute)['driverId']).toBe(D1);
    expect(String(optionsDuPdf(pdfGenerate)['driverLabel'])).toContain('Sohaib Hamanni');
  });
});

describe('GET /reports/csv — trajets filtrés, et refus explicite pour le reste', () => {
  it('« trips » : la portée conducteur est transmise au service', async () => {
    const { controller, csvTrips } = construire();

    await controller.csvDownload(requete(), reponse(), 'trips', FLEET_ID, FROM, TO, undefined, D1);

    expect(csvTrips).toHaveBeenCalledWith(FLEET_ID, expect.any(Date), expect.any(Date), 'ALL', D1);
  });

  it('« trips » sans filtre : `undefined`, pas `null` — la nuance est tout le sujet', async () => {
    const { controller, csvTrips } = construire();

    await controller.csvDownload(requete(), reponse(), 'trips', FLEET_ID, FROM, TO);

    expect(csvTrips).toHaveBeenCalledWith(FLEET_ID, expect.any(Date), expect.any(Date), 'ALL', undefined);
  });

  it('« none » : la portée `null` descend telle quelle', async () => {
    const { controller, csvTrips } = construire();

    await controller.csvDownload(requete(), reponse(), 'trips', FLEET_ID, FROM, TO, undefined, 'none');

    expect(csvTrips).toHaveBeenCalledWith(FLEET_ID, expect.any(Date), expect.any(Date), 'ALL', null);
  });

  /**
   * ══ POURQUOI CES TROIS TYPES SONT REFUSÉS, ET NON SERVIS TELS QUELS ══════════════════
   *
   * Une position est un point de boîtier ; une ALERTE appartient à un véhicule (la rattacher
   * à quelqu'un demanderait de deviner qui conduisait à son horodatage — une accusation, pas
   * une donnée) ; une commande moteur est envoyée par un utilisateur, pas par un conducteur.
   *
   * Aucun ne PEUT suivre le filtre. Trois conduites étaient possibles :
   *
   *   - les servir en ignorant le filtre → une AUTRE population sous un nom de fichier qu'on
   *     croit filtré, c'est-à-dire le défaut même que ce lot répare ;
   *   - les servir vides → « cette personne n'a déclenché aucune alerte », qui est FAUX ;
   *   - REFUSER en disant pourquoi → le client apprend la raison et sait quoi faire.
   *
   * C'est la troisième qui est figée ici. L'écran, lui, désactive le bouton et porte la même
   * phrase avant le clic : ce 400 est la ceinture (une URL recopiée, un autre client).
   */
  it.each(['positions', 'alerts', 'commands'])(
    '« %s » sous filtre conducteur : REFUSÉ, avec la raison en français',
    async (type) => {
      const { controller, csvAlerts, csvPositions, csvCommands } = construire();

      await expect(
        controller.csvDownload(requete(), reponse(), type, FLEET_ID, FROM, TO, undefined, D1),
      ).rejects.toBeInstanceOf(BadRequestException);

      // Aucun fichier n'a été produit : le refus, pas une population de substitution.
      expect(csvAlerts).not.toHaveBeenCalled();
      expect(csvPositions).not.toHaveBeenCalled();
      expect(csvCommands).not.toHaveBeenCalled();
    },
  );

  it('le refus DIT pourquoi : « appartiennent à un véhicule », et quoi faire', async () => {
    const { controller } = construire();

    const erreur = await controller
      .csvDownload(requete(), reponse(), 'alerts', FLEET_ID, FROM, TO, undefined, D1)
      .catch((e: Error) => e);

    const message = (erreur as Error).message;
    expect(message).toContain('véhicule');
    expect(message).toContain('trajets');
    expect(message).toContain('Retirez le filtre conducteur');
  });

  it('SANS filtre conducteur, ces trois types sortent comme avant', async () => {
    const { controller, csvAlerts } = construire();

    await controller.csvDownload(requete(), reponse(), 'alerts', FLEET_ID, FROM, TO);

    expect(csvAlerts).toHaveBeenCalledTimes(1);
  });

  it('le refus laisse une trace FAILURE au journal, comme tout export refusé', async () => {
    const { controller, record } = construire();

    await controller
      .csvDownload(requete(), reponse(), 'alerts', FLEET_ID, FROM, TO, undefined, D1)
      .catch(() => undefined);

    expect(record).toHaveBeenCalledTimes(1);
    const trace = record.mock.calls[0]![0] as Record<string, unknown>;
    expect(trace['status']).toBe('FAILURE');
    expect(trace['action']).toBe('export_csv_alerts');
    expect(trace['fleetId']).toBe(FLEET_ID);
  });

  it('une valeur invalide est refusée même pour « trips »', async () => {
    const { controller, csvTrips } = construire();

    await expect(
      controller.csvDownload(requete(), reponse(), 'trips', FLEET_ID, FROM, TO, undefined, 'tout'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(csvTrips).not.toHaveBeenCalled();
  });

  /**
   * ══ LA MARQUE DOIT SORTIR DU SERVEUR, PAS SEULEMENT DU SERVICE ═══════════════════════
   *
   * Les tests du premier bloc lisent le nom que `ReportCsvService` RETOURNE. Entre lui et le
   * fichier reçu il reste deux étapes qui peuvent l'avaler : le contrôleur, qui pourrait
   * refabriquer un nom de son côté, et `enTeteTelechargement`, qui réduit le nom en ASCII
   * pour ne pas faire tomber la réponse sur une plaque accentuée (`ERR_INVALID_CHAR`, quatre
   * septembre) — sa règle remplace tout caractère refusé par un tiret et écrase les tirets
   * consécutifs.
   *
   * ⚠️ LES AUTRES TESTS DE CE BLOC NE PEUVENT PAS L'ATTRAPER : leur simulacre rend
   * « tracky-trips.csv », un nom sans marque qui passerait quel que soit le sort de celle-ci.
   * D'où le VRAI service monté ici.
   *
   * NON COUVERT, ET ASSUMÉ : côté navigateur, `reports.service.downloadCsv` refabrique encore
   * le nom au lieu de lire cet en-tête (le `-PARTIEL` de la troncature est avalé de la même
   * façon, depuis toujours). Ce qui est figé ici, c'est que le SERVEUR, lui, le dit.
   */
  describe('le nom marqué va jusqu’à l’en-tête HTTP, pas seulement jusqu’au service', () => {
    /** Une réponse Express dont on peut relire les en-têtes posés. */
    function reponseEspion() {
      const entetes: Record<string, string> = {};
      const res = {
        setHeader: jest.fn((nom: string, valeur: string) => {
          entetes[nom] = valeur;
        }),
        send: jest.fn(),
      };
      return { res: res as never, entetes };
    }

    /** Le contrôleur, avec le VRAI service CSV branché sur le jeu d'essai du fichier. */
    function avecServiceReel() {
      const { prisma } = makePrisma();
      return construire(new ReportCsvService(prisma));
    }

    it('« none » : le Content-Disposition annonce les trajets sans conducteur', async () => {
      const { controller, record } = avecServiceReel();
      const { res, entetes } = reponseEspion();

      await controller.csvDownload(requete(), res, 'trips', FLEET_ID, FROM, TO, undefined, 'none');

      expect(entetes['Content-Disposition']).toContain('tracky-trips-2026-06-01_2026-06-30-sans-conducteur.csv');
      // Le journal d'export porte le même nom : la trace serveur et le fichier reçu se
      // rapprochent encore l'un de l'autre des mois plus tard.
      expect(record.mock.calls[0]![0]).toMatchObject({ target: expect.stringContaining('sans-conducteur') });
    });

    it('conducteur nommé : l’en-tête porte l’identifiant, jamais le nom de la personne', async () => {
      const { controller } = avecServiceReel();
      const { res, entetes } = reponseEspion();

      await controller.csvDownload(requete(), res, 'trips', FLEET_ID, FROM, TO, undefined, D1);

      expect(entetes['Content-Disposition']).toContain(`-conducteur-${D1.slice(0, 8)}`);
      expect(entetes['Content-Disposition']).not.toContain('Hamanni');
    });

    it('sans filtre : l’en-tête garde le nom d’avant, au caractère près', async () => {
      const { controller } = avecServiceReel();
      const { res, entetes } = reponseEspion();

      await controller.csvDownload(requete(), res, 'trips', FLEET_ID, FROM, TO);

      expect(entetes['Content-Disposition']).toContain('filename="tracky-trips-2026-06-01_2026-06-30.csv"');
      expect(entetes['Content-Disposition']).not.toContain('conducteur');
    });
  });
});

describe('POST /reports/excel — le classeur porte le filtre, et le nomme', () => {
  it('classeur d’un VÉHICULE : la portée et le nom descendent dans le service', async () => {
    const { controller, excelGenerate } = construire();

    await controller.excelDownload(requete(), reponse(), {
      vehicleId: VEH, from: FROM, to: TO, driverId: D1,
    } as never);

    const filtre = excelGenerate.mock.calls[0]![4] as { scope: string | null; label: string };
    expect(filtre).toEqual({ scope: D1, label: 'Sohaib Hamanni' });
  });

  it('classeur d’un PÉRIMÈTRE : même filtre, même nom', async () => {
    const { controller, excelScope } = construire();

    await controller.excelDownload(requete(), reponse(), {
      fleetId: FLEET_ID, from: FROM, to: TO, driverId: D2,
    } as never);

    const filtre = excelScope.mock.calls[0]![4] as { scope: string | null; label: string };
    expect(filtre).toEqual({ scope: D2, label: 'Amine Berrada' });
  });

  it('« none » : portée `null`, libellé « Sans conducteur »', async () => {
    const { controller, excelScope } = construire();

    await controller.excelDownload(requete(), reponse(), {
      fleetId: FLEET_ID, from: FROM, to: TO, driverId: 'none',
    } as never);

    expect(excelScope.mock.calls[0]![4]).toEqual({ scope: null, label: 'Sans conducteur' });
  });

  it('sans filtre : AUCUN objet transmis — le classeur d’avant, au pixel', async () => {
    const { controller, excelScope } = construire();

    await controller.excelDownload(requete(), reponse(), {
      fleetId: FLEET_ID, from: FROM, to: TO,
    } as never);

    expect(excelScope.mock.calls[0]![4]).toBeUndefined();
  });

  it('une valeur invalide est refusée avant toute génération', async () => {
    const { controller, excelScope, excelGenerate } = construire();

    await expect(
      controller.excelDownload(requete(), reponse(), {
        fleetId: FLEET_ID, from: FROM, to: TO, driverId: 'moi',
      } as never),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(excelScope).not.toHaveBeenCalled();
    expect(excelGenerate).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------
// 3) Les documents eux-mêmes — ce qui est écrit dedans
// ---------------------------------------------------------------------------------------

/**
 * Capture tout le texte écrit dans le PDF. Le binaire est compressé, donc non greppable :
 * on espionne `PDFDocument.prototype.text` en laissant le rendu RÉEL se faire, pour que les
 * régressions de mise en page continuent de lever.
 */
async function texteDuPdf(
  options?: Parameters<ReportPdfService['generate']>[1],
): Promise<string> {
  const reel = (PDFDocument.prototype as never as { text: (...a: unknown[]) => unknown }).text;
  const capture: string[] = [];
  const espion = jest
    .spyOn(PDFDocument.prototype as never as { text: (...a: unknown[]) => unknown }, 'text')
    .mockImplementation(function (this: unknown, ...args: unknown[]) {
      if (typeof args[0] === 'string') capture.push(args[0]);
      return (reel as (...a: unknown[]) => unknown).apply(this, args);
    });
  try {
    await new ReportPdfService().generate(RAPPORT, options);
    return capture.join('\n');
  } finally {
    espion.mockRestore();
  }
}

describe('ReportPdfService — ce que le document dit de son conducteur', () => {
  it('écrit le conducteur sous le nom de la société', async () => {
    const texte = await texteDuPdf({ driverLabel: 'Conducteur : Sohaib Hamanni' });

    expect(texte).toContain('Conducteur : Sohaib Hamanni');
    expect(texte).toContain('Société test');
  });

  /**
   * ⚠️ L'EXCEPTION DES ALERTES, ÉCRITE DANS LE DOCUMENT.
   *
   * Une alerte appartient à un VÉHICULE : ce compte ne suit PAS le filtre conducteur. Sans
   * cette phrase, la section se lirait « voici ses alertes » — ce n'est plus un chiffre, c'est
   * une accusation, et sur du papier qui circule elle n'a pas de démenti.
   */
  it('prévient que les alertes ne suivent pas le filtre', async () => {
    const texte = await texteDuPdf({ driverLabel: 'Conducteur : Sohaib Hamanni' });

    expect(texte).toContain('Les alertes appartiennent à un véhicule');
    expect(texte).toContain('ne suit pas le filtre conducteur');
  });

  it('sans filtre : ni ligne conducteur, ni mention d’alertes — rien ne bouge', async () => {
    const texte = await texteDuPdf();

    expect(texte).not.toContain('Conducteur :');
    expect(texte).not.toContain('appartiennent à un véhicule');
  });

  it('le périmètre véhicule reste écrit quand les deux filtres sont posés', async () => {
    const texte = await texteDuPdf({
      scopeLabel: '2 véhicules : AA-111-AA, BB-222-BB',
      driverLabel: 'Conducteur : Sohaib Hamanni',
    });

    expect(texte).toContain('2 véhicules : AA-111-AA, BB-222-BB');
    expect(texte).toContain('Conducteur : Sohaib Hamanni');
  });
});

describe('ReportExcelService — le classeur borne ses trajets et nomme la personne', () => {
  const utilisateur: AuthUser = {
    id: 'user-1', authUserId: 'auth-1', email: 'u@test.fr',
    firstName: null, lastName: null, role: UserRole.FLEET_ADMIN,
    fleetId: FLEET_ID, isActive: true, isOwner: false, permissions: null,
  };

  function build() {
    const capture: { tripWhere?: Record<string, unknown> } = {};
    const prisma = {
      vehicle: {
        findUnique: jest.fn().mockResolvedValue({
          id: VEH, plate: 'AA-111-AA', brand: 'Renault', model: 'Master', type: 'VAN',
          fuelConsumptionL100km: null, calibratedConsumptionL100km: null, calibratedTanks: 0,
          fleetId: FLEET_ID, privacyModeEnabled: false,
          fleet: { id: FLEET_ID, name: 'Société test', fuelPriceEurL: 1.9 },
        }),
      },
      trip: {
        findMany: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
          capture.tripWhere = where;
          const attendu = where['driverId'];
          return Promise.resolve(
            TRAJETS
              .filter((t) => attendu === undefined || t.driverId === attendu)
              .map((t) => ({
                startedAt: t.startedAt,
                endedAt: new Date(t.startedAt.getTime() + 3_600_000),
                durationSeconds: 3600, distanceKm: t.distanceKm, maxSpeed: 90, avgSpeed: 45,
                notes: null,
                driver: t.driverId ? NOMS[t.driverId]! : null,
              })),
          );
        }),
      },
      tripFuelStop: { findMany: jest.fn().mockResolvedValue([]) },
    } as never;
    const vehicleAccess = { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') } as never;
    return { svc: new ReportExcelService(prisma, vehicleAccess), capture, prisma: prisma as never as { tripFuelStop: { findMany: jest.Mock } } };
  }

  it('borne les trajets au conducteur demandé', async () => {
    const { svc, capture } = build();

    await svc.generate(VEH, parisDayStart(FROM), parisDayStart(TO), utilisateur, {
      scope: D1, label: 'Sohaib Hamanni',
    });

    expect(capture.tripWhere!['driverId']).toBe(D1);
  });

  it('écrit le nom de la personne dans la feuille de synthèse', async () => {
    const { svc } = build();

    const { buffer } = await svc.generate(VEH, parisDayStart(FROM), parisDayStart(TO), utilisateur, {
      scope: D1, label: 'Sohaib Hamanni',
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    const synthese = wb.getWorksheet('Synthèse')!;
    let texte = '';
    synthese.eachRow((row) => row.eachCell((c) => { texte += String(c.value ?? '') + '\n'; }));
    expect(texte).toContain('Sohaib Hamanni');
    expect(texte).toContain('Filtre conducteur');
  });

  /**
   * ⚠️ LES PASSAGES EN STATION NE PEUVENT PAS SUIVRE LE FILTRE — et le classeur le dit.
   *
   * Une station est un arrêt du VÉHICULE : `TripFuelStop` ne porte pas de conducteur. Les
   * garder mettrait, dans un classeur au nom d'une personne, une liste d'arrêts et un « prix
   * constaté » qui peuvent tous venir des trajets d'un autre. On les retire, et on l'écrit —
   * un classeur composite en silence serait le pire des trois.
   */
  it('n’embarque PAS les passages en station, et l’annonce', async () => {
    const { svc, prisma } = build();

    const { buffer } = await svc.generate(VEH, parisDayStart(FROM), parisDayStart(TO), utilisateur, {
      scope: D1, label: 'Sohaib Hamanni',
    });

    expect(prisma.tripFuelStop.findMany).not.toHaveBeenCalled();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    expect(String(wb.getWorksheet('Synthèse')!.getCell('A2').value ?? '')).toContain('passages en station');
  });

  it('sans filtre : les passages sont chargés et rien n’est annoncé', async () => {
    const { svc, prisma } = build();

    const { buffer } = await svc.generate(VEH, parisDayStart(FROM), parisDayStart(TO), utilisateur);

    expect(prisma.tripFuelStop.findMany).toHaveBeenCalledTimes(1);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    expect(wb.getWorksheet('Synthèse')!.getCell('A2').value ?? '').toBe('');
  });

  it('« none » : le classeur ne porte que les trajets sans conducteur', async () => {
    const { svc, capture } = build();

    const { buffer } = await svc.generate(VEH, parisDayStart(FROM), parisDayStart(TO), utilisateur, {
      scope: null, label: 'Sans conducteur',
    });

    expect(capture.tripWhere).toHaveProperty('driverId', null);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as never);
    // Un seul trajet orphelin dans le jeu : en-tête + 1 ligne + TOTAL.
    expect(wb.getWorksheet('Trajets')!.rowCount).toBe(3);
    expect(String(wb.getWorksheet('Synthèse')!.getCell('A2').value ?? '')).toContain('sans conducteur');
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * GET /reports/stats — LA SYNTHÈSE SUIT LE FILTRE, COMME LE TABLEAU QU'ELLE SURPLOMBE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Les quatre routes d'export ci-dessus étaient câblées sous garde ; la SYNTHÈSE, elle, ne
 * l'était pas. Retirer `driverId: driverIdQ,` du bloc `filters` de `statsJson` ne faisait
 * rougir aucun test du dépôt : le client envoyait bien le paramètre, le service savait
 * l'appliquer, et c'est le fil entre les deux qui manquait de garde. L'écran aurait alors
 * montré une synthèse de toute la société au-dessus d'un tableau filtré sur une personne —
 * « le compteur annonce 622 et le tableau en affiche 100 », à l'identique.
 *
 * Les trois cas exigent des valeurs DIFFÉRENTES de la MÊME clé (un identifiant, `none`, puis
 * rien du tout) : aucun ne peut être satisfait par un voisin.
 */
describe('GET /reports/stats — le filtre atteint vraiment le calcul', () => {
  it('le conducteur descend dans le bloc de filtres', async () => {
    const { controller, compute } = construire();

    await controller.statsJson(requete(), FLEET_ID, FROM, TO, undefined, undefined, D1);

    expect(filtresDuCalcul(compute)['driverId']).toBe(D1);
  });

  it('« none » descend tel quel — le service le traduira, pas la route', async () => {
    const { controller, compute } = construire();

    await controller.statsJson(requete(), FLEET_ID, FROM, TO, undefined, undefined, 'none');

    expect(filtresDuCalcul(compute)['driverId']).toBe('none');
  });

  it('sans filtre : la clé vaut undefined, jamais null', async () => {
    const { controller, compute } = construire();

    await controller.statsJson(requete(), FLEET_ID, FROM, TO, undefined, undefined, undefined);

    // `null` serait un filtre (« les trajets sans conducteur »), pas son absence.
    expect(filtresDuCalcul(compute)['driverId']).toBeUndefined();
  });

  /**
   * ⚠️ LA VALEUR EST TRANSMISE BRUTE, ET C'EST VOULU. Contrairement aux exports, cette route
   * ne résout pas le filtre elle-même : `compute` le valide (`resolveDriverScope`) et refuse
   * par un 400 — le refus est figé dans `reports-stats-filtre-conducteur.spec.ts` (« refuse
   * une valeur qui n'est ni un UUID ni "none" »), là où la règle vit. Ce qu'on éprouve ICI,
   * c'est que la route ne l'avale pas en chemin : elle passe ce qu'elle a reçu, tel quel.
   */
  it('une valeur invalide n’est pas escamotée par la route : elle descend telle quelle', async () => {
    const { controller, compute } = construire();

    await controller.statsJson(requete(), FLEET_ID, FROM, TO, undefined, undefined, 'tous');

    expect(filtresDuCalcul(compute)['driverId']).toBe('tous');
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA MÊME ROUTE REND 400 ET NON 500 SUR UN PARAMÈTRE RÉPÉTÉ — ET C'EST LA SIGNATURE QUI LE
 * DÉCIDE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `?driverId=a&driverId=b` — une URL recopiée, un client d'intégration, un `HttpParams.append`
 * au lieu de `set` — fait rendre à express un TABLEAU. Sept des huit portes qui portent ce
 * filtre répondaient 400 en nommant le champ ; `/reports/stats` répondait 500 « Internal
 * server error », et le filtre d'exception global archivait l'incident en CRITICAL au centre
 * d'alerte pour une simple requête malformée.
 *
 * La cause n'est pas dans le corps de la méthode mais dans son TYPAGE. `emitDecoratorMetadata`
 * émet `design:paramtypes` : `?: string` donne `String`, `string | undefined` donne `Object`
 * (sous `strictNullChecks`, TypeScript n'élide plus `undefined` de l'union). Or le
 * `ValidationPipe` global ne convertit QUE pour `String` — `transformPrimitive` :
 * `if (metatype === String && !isUndefined(value)) return String(value)`. En `Object`, le
 * tableau traverse le pipe intact et atteint `(driverId ?? '').trim()` : `TypeError`, 500.
 *
 * ⚠️ CE TEST EXISTE PARCE QUE LA CORRECTION EST INVISIBLE À LA LECTURE DU CORPS. Rien dans le
 * code exécuté ne dit que `?: string` vaut mieux que `string | undefined` : une relecture qui
 * « harmoniserait » la signature rouvrirait le 500 sans qu'aucune ligne de logique n'ait
 * bougé. Le témoin `Object` en fin de test est là pour que l'assertion ne puisse pas être
 * verte par accident : il montre que c'est bien le métatype, et lui seul, qui fait la
 * différence.
 */
describe('GET /reports/stats — la coercition du ValidationPipe', () => {
  /** Les options EXACTES du pipe global de `main.ts`. */
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

  const metatypes = (): unknown[] =>
    Reflect.getMetadata('design:paramtypes', ReportsController.prototype, 'statsJson') as unknown[];

  const traverser = (metatype: unknown, valeur: unknown): Promise<unknown> =>
    pipe.transform(valeur, { type: 'query', data: 'driverId', metatype: metatype as never });

  it('les six @Query de la route émettent le métatype String, pas Object', async () => {
    // Le premier paramètre est `@Req()` — un objet, forcément. Les six suivants sont les
    // `@Query` : tous doivent être écrits `?: string`, aucun en union.
    expect(metatypes().slice(1)).toEqual([String, String, String, String, String, String]);
  });

  it('le paramètre répété devient une chaîne, que la règle partagée refuse par un 400', async () => {
    const [, , , , , , driverId] = metatypes();

    const coerce = await traverser(driverId, ['a', 'b']);

    expect(coerce).toBe('a,b');
    // Un refus explicite qui nomme le champ, jamais une TypeError qui remonte en 500.
    expect(() => resolveDriverScope(coerce as string)).toThrow(BadRequestException);
  });

  /**
   * Le témoin qui empêche l'assertion précédente d'être verte par accident : sous `Object`,
   * le MÊME pipe, avec les MÊMES options, ne convertit rien. C'est donc bien le métatype, et
   * lui seul, qui décide — et c'est ce tableau intact qui atteignait `(driverId ?? '').trim()`
   * et rendait un 500 là où les sept autres portes rendaient un 400.
   *
   * ⚠️ Ce test n'assert PAS ce que `resolveDriverScope` fait d'un tableau : ce point-là
   * appartient à `common/driver-scope`, et ce fichier ne doit pas se casser le jour où cette
   * fonction s'y protégera par un garde de type. Ce qu'on fige ici, c'est la porte.
   */
  it('témoin : sous le métatype Object, le même pipe ne convertit rien', async () => {
    expect(await traverser(Object, ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('les entrées valides ne changent pas : un UUID et « none » traversent tels quels', async () => {
    const [, , , , , , driverId] = metatypes();

    await expect(traverser(driverId, D1)).resolves.toBe(D1);
    await expect(traverser(driverId, 'none')).resolves.toBe('none');
    await expect(traverser(driverId, undefined)).resolves.toBeUndefined();
  });
});
