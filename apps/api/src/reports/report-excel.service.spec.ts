/**
 * Sprint 5 — Tests du ReportExcelService (export Excel « soigné » par véhicule).
 *
 * Vérifie :
 *   1. `generate` retourne un Buffer .xlsx non vide, relisible par exceljs, avec
 *      les 3 feuilles attendues (Synthèse · Trajets · Par jour) + l'en-tête de la
 *      feuille Trajets ;
 *   2. les données trajets (TOTAL, par jour) sont bien rendues ;
 *   3. un `vehicleId` HORS périmètre de l'appelant → ForbiddenException ;
 *   4. le nom de fichier suit `tracky-{plaque}-{from}_{to}.xlsx`.
 */
import { ForbiddenException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as ExcelJS from 'exceljs';
import { ReportExcelService } from './report-excel.service';
import { parisDayStart } from '../common/utils/datetime';
import type { AuthUser } from '../auth/types/auth-user';

const FLEET_ID = 'fleet-1';
const VEH_A = 'veh-a';
const VEH_X = 'veh-x'; // hors périmètre
// Bornes telles que le contrôleur les produit : jours civils de Paris, fin EXCLUSIVE
// (lendemain minuit). Le nom de fichier, lui, affiche la fin INCLUSE : 2026-06-30.
const FROM = parisDayStart('2026-06-01');
const TO = parisDayStart('2026-07-01');

function makeUser(role: UserRole, fleetId: string | null = FLEET_ID): AuthUser {
  return {
    id: 'user-1', authUserId: 'auth-1', email: 'u@test.fr',
    firstName: null, lastName: null, role, fleetId, isActive: true, isOwner: false, permissions: null,
  };
}

const TRIP_ROWS = [
  {
    startedAt: new Date('2026-06-02T08:00:00.000Z'),
    endedAt: new Date('2026-06-02T08:30:00.000Z'),
    durationSeconds: 1800, distanceKm: 12.4, maxSpeed: 92, avgSpeed: 41,
    notes: 'Livraison matin', driverId: 'drv-alice', driver: { firstName: 'Alice', lastName: 'Martin' },
  },
  {
    startedAt: new Date('2026-06-02T14:00:00.000Z'),
    endedAt: new Date('2026-06-02T14:45:00.000Z'),
    durationSeconds: 2700, distanceKm: 20.1, maxSpeed: 110, avgSpeed: 53,
    notes: null, driver: null,
  },
  {
    startedAt: new Date('2026-06-05T09:00:00.000Z'),
    endedAt: new Date('2026-06-05T09:20:00.000Z'),
    durationSeconds: 1200, distanceKm: 7.5, maxSpeed: 70, avgSpeed: 30,
    notes: null, driverId: 'drv-bob', driver: { firstName: 'Bob', lastName: 'Durand' },
  },
];

/**
 * @param accessible périmètre véhicules retourné par VehicleAccessService.
 * @param vehicleFleetId flotte du véhicule chargé (pour le check d'appartenance).
 */
function buildService(accessible: string[] | 'ALL', vehicleFleetId = FLEET_ID) {
  const prisma = {
    vehicle: {
      findUnique: jest.fn().mockResolvedValue({
        id: VEH_A, plate: 'AB-123-CD', brand: 'Renault', model: 'Master',
        type: 'VAN', fuelConsumptionL100km: null, fleetId: vehicleFleetId,
        fleet: { id: FLEET_ID, name: 'Flotte Test', fuelPriceEurL: 1.9 },
      }),
    },
    trip: { findMany: jest.fn().mockResolvedValue(TRIP_ROWS) },
    tripFuelStop: { findMany: jest.fn().mockResolvedValue([]) },
  } as any;
  const vehicleAccess = {
    getAccessibleVehicleIds: jest.fn().mockResolvedValue(accessible),
  } as any;
  const svc = new ReportExcelService(prisma, vehicleAccess);
  return { svc, prisma, vehicleAccess };
}

describe('ReportExcelService.generate', () => {
  it('retourne un Buffer .xlsx non vide avec les 3 feuilles + en-tête Trajets', async () => {
    const { svc } = buildService('ALL');

    const { buffer, filename } = await svc.generate(VEH_A, FROM, TO, makeUser(UserRole.FLEET_ADMIN));

    expect(Buffer.isBuffer(buffer)).toBe(true);
    expect(buffer.length).toBeGreaterThan(0);
    expect(filename).toBe('tracky-AB-123-CD-2026-06-01_2026-06-30.xlsx');

    // Relit le classeur produit.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const names = wb.worksheets.map((w) => w.name);
    // ⚠️ La feuille « Par conducteur ou groupe » (F13) s'intercale APRÈS la synthèse et
    // AVANT les trajets : elle se lit avec la synthèse, pas après la liste brute.
    expect(names).toEqual(['Synthèse', 'Par conducteur ou groupe', 'Trajets', 'Par jour']);

    // En-tête de la feuille Trajets (ligne 1).
    const trajets = wb.getWorksheet('Trajets')!;
    const header = (trajets.getRow(1).values as unknown[]).slice(1); // index 0 vide chez exceljs
    expect(header).toEqual([
      'Départ (heure de Paris)', 'Arrivée (heure de Paris)', 'Durée', 'Distance (km)',
      'V. moy (km/h)', 'V. max (km/h)', 'Conducteur', 'Notes',
    ]);

    // 3 trajets + 1 ligne TOTAL = 4 lignes de données (rows 2..5).
    expect(trajets.rowCount).toBe(1 + TRIP_ROWS.length + 1);
    const totalRow = trajets.getRow(trajets.rowCount);
    expect(totalRow.getCell(1).value).toBe('TOTAL');
  });

  it("feuille « Par jour » agrège par date (2 jours pour ce jeu d'essai)", async () => {
    const { svc } = buildService('ALL');
    const { buffer } = await svc.generate(VEH_A, FROM, TO, makeUser(UserRole.FLEET_ADMIN));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const parJour = wb.getWorksheet('Par jour')!;
    // header + 2 jours distincts (2026-06-02, 2026-06-05).
    expect(parJour.rowCount).toBe(1 + 2);
    expect(parJour.getRow(2).getCell(1).value).toBe('2026-06-02');
    expect(parJour.getRow(3).getCell(1).value).toBe('2026-06-05');
  });

  it("Synthèse porte la plaque et le nombre de trajets", async () => {
    const { svc } = buildService('ALL');
    const { buffer } = await svc.generate(VEH_A, FROM, TO, makeUser(UserRole.FLEET_ADMIN));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const synth = wb.getWorksheet('Synthèse')!;
    // Cherche une cellule contenant la plaque.
    let foundPlate = false;
    synth.eachRow((row) => {
      row.eachCell((cell) => {
        if (cell.value === 'AB-123-CD') foundPlate = true;
      });
    });
    expect(foundPlate).toBe(true);
  });

  it('VIEWER scopé (sans VEH_X) demandant VEH_X → ForbiddenException', async () => {
    // Le périmètre accessible ne contient QUE VEH_A ; on demande VEH_X.
    const { svc, prisma } = buildService([VEH_A]);

    await expect(
      svc.generate(VEH_X, FROM, TO, makeUser(UserRole.VIEWER)),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Rejet AVANT toute requête véhicule/trip (court-circuit périmètre).
    expect(prisma.vehicle.findUnique).not.toHaveBeenCalled();
    expect(prisma.trip.findMany).not.toHaveBeenCalled();
  });

  /**
   * ⚠️ UNE MENTION FUSIONNÉE À HAUTEUR FIGÉE EST UNE MENTION COUPÉE.
   *
   * Excel n'ajuste jamais la hauteur d'une ligne fusionnée, et la hauteur écrite par
   * ExcelJS sort avec `customHeight="1"` — le drapeau qui le lui interdit formellement.
   * Les 30 pt posés ici affichaient deux lignes pour une phrase qui en demande trois, et
   * `vertical: 'middle'` la rogne aux deux bouts : ce qui disparaît est l'aveu que les
   * passages en station ont été retirés, c'est-à-dire la décision (c) retournée en
   * « incomplet en silence ».
   *
   * L'assertion est RELATIONNELLE — elle lie la hauteur au texte réellement posé — donc
   * elle ne meurt pas le jour où la phrase s'allonge : c'est justement ce jour-là qu'elle
   * doit lever.
   */
  it('la mention fusionnée de la Synthèse a la hauteur de son texte, pas une hauteur figée', async () => {
    const { svc } = buildService('ALL');
    const { buffer } = await svc.generate(
      VEH_A, FROM, TO, makeUser(UserRole.FLEET_ADMIN),
      { scope: 'drv-1', label: 'Sohaib Hamanni' },
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('Synthèse')!;
    const texte = String(ws.getCell('A2').value ?? '');

    // La phrase entière est bien là — et c'est sa FIN qui doit rester lisible.
    expect(texte).toContain('exclus de ce classeur');
    expect(ws.getCell('A2').alignment?.wrapText).toBe(true);
    // ~52 caractères par ligne pour les 54 unités cumulées de A et B, 15 pt par ligne.
    expect(ws.getRow(2).height).toBeGreaterThanOrEqual(Math.ceil(texte.length / 52) * 15);
  });

  it('non-super dont le véhicule appartient à une AUTRE flotte → Forbidden (defense en profondeur)', async () => {
    // Périmètre 'ALL' incohérent mais véhicule d'une autre flotte → 403 via le
    // check d'appartenance flotte.
    const { svc } = buildService('ALL', 'autre-flotte');

    await expect(
      svc.generate(VEH_A, FROM, TO, makeUser(UserRole.FLEET_MANAGER, FLEET_ID)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

/**
 * ══ LE CLASSEUR D'UN PÉRIMÈTRE (société ou groupe) ═══════════════════════════════════
 *
 * L'Excel n'existait QUE par véhicule : obtenir le mois d'un parc demandait quarante
 * exports recollés à la main. Ces tests protègent les trois points où l'on peut se
 * tromper — le périmètre, la mention des véhicules exclus, et la colonne qui dit de QUI
 * est chaque trajet.
 */
describe('ReportExcelService.generateScope — le classeur d’un parc', () => {
  const VEH_B = 'veh-b';
  const VEH_PRIVE = 'veh-prive';

  function buildScope(opts: { accessible?: string[] | 'ALL'; avecPrive?: boolean; trips?: unknown[] } = {}) {
    const vehicules = [
      {
        id: VEH_A, plate: 'AB-123-CD', brand: 'Renault', model: 'Master', type: 'VAN',
        fuelConsumptionL100km: null, calibratedConsumptionL100km: null, calibratedTanks: 0,
        privacyModeEnabled: false, groups: [{ group: { id: 'g1', name: 'Livraisons' } }],
      },
      {
        id: VEH_B, plate: 'EF-456-GH', brand: 'Peugeot', model: 'Partner', type: 'VAN',
        fuelConsumptionL100km: null, calibratedConsumptionL100km: null, calibratedTanks: 0,
        privacyModeEnabled: false, groups: [],
      },
      ...(opts.avecPrive
        ? [{
            id: VEH_PRIVE, plate: 'ZZ-999-ZZ', brand: null, model: null, type: 'CAR',
            fuelConsumptionL100km: null, calibratedConsumptionL100km: null, calibratedTanks: 0,
            privacyModeEnabled: true, groups: [],
          }]
        : []),
    ];
    const capture: { tripWhere?: any; vehWhere?: any } = {};
    const prisma = {
      fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID, name: 'Flotte Test', fuelPriceEurL: 1.9 }) },
      vehicle: {
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          capture.vehWhere = where;
          return Promise.resolve(vehicules);
        }),
      },
      trip: {
        findMany: jest.fn().mockImplementation(({ where }: any) => {
          capture.tripWhere = where;
          const lignes = (opts.trips ?? TRIP_ROWS.map((t, i) => ({ ...t, vehicleId: i === 0 ? VEH_A : VEH_B }))) as any[];
          /**
           * ⚠️ CE SIMULACRE FILTRE VRAIMENT. Un `mockResolvedValue` nu rendrait la même
           * population quel que soit le `where` : une assertion portée sur le CONTENU du
           * classeur serait alors satisfaite par des lignes non filtrées — une assertion
           * morte, verte sur un service qui aurait cessé de borner quoi que ce soit.
           * `'driverId' in where` et non `where.driverId != null` : la clé posée à `null`
           * est le filtre « sans conducteur », pas une absence de filtre.
           */
          if (!('driverId' in where)) return Promise.resolve(lignes);
          return Promise.resolve(lignes.filter((t) => (t.driverId ?? null) === where.driverId));
        }),
      },
      tripFuelStop: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const vehicleAccess = { getAccessibleVehicleIds: jest.fn().mockResolvedValue(opts.accessible ?? 'ALL') } as any;
    return { svc: new ReportExcelService(prisma, vehicleAccess), capture, prisma };
  }

  it('ouvre sur une feuille de synthèse par véhicule, total compris', async () => {
    const { svc } = buildScope();
    const { buffer, filename } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Synthèse par véhicule', 'Par conducteur ou groupe', 'Trajets', 'Par jour']);
    expect(filename).toContain('2026-06-01_2026-06-30');

    const synth = wb.getWorksheet('Synthèse par véhicule')!;
    expect((synth.getRow(4).values as unknown[])[1]).toBe('Véhicule');
    const derniere = synth.getRow(synth.rowCount);
    expect(derniere.getCell(1).value).toBe('TOTAL');
    /**
     * ⚠️ LA VITESSE MOYENNE DU PARC, ET PLUS UN TIRET.
     *
     * Le tiret venait d'un raisonnement juste — on ne fait pas la moyenne de moyennes — mais
     * appliqué à la mauvaise opération. La grandeur est cumulable dès lors qu'on additionne
     * les DEUX termes et qu'on divise à la fin : Σ km ÷ Σ temps roulant, exactement ce
     * qu'imprime la synthèse du PDF.
     *
     * Tant que la colonne restait vide, le gestionnaire qui comparait les deux documents ne
     * trouvait ce chiffre que dans l'un des deux — et n'avait aucun moyen de vérifier que
     * l'autre disait la même chose.
     */
    const kmTotal = derniere.getCell(5).value as number;
    const moyenne = derniere.getCell(7).value as number;
    expect(typeof moyenne).toBe('number');
    expect(moyenne).toBeGreaterThan(0);
    // Cohérente avec les kilomètres de la même ligne : jamais plus que la distance parcourue
    // en une heure ne le permettrait sur la durée affichée.
    expect(moyenne).toBeLessThanOrEqual(kmTotal);
  });

  it('ajoute la colonne « Véhicule » aux trajets — un classeur de parc doit dire de qui ils sont', async () => {
    const { svc } = buildScope();
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const trajets = wb.getWorksheet('Trajets')!;
    expect((trajets.getRow(1).values as unknown[])[1]).toBe('Véhicule');
    expect(trajets.getRow(2).getCell(1).value).toBe('AB-123-CD');
  });

  /**
   * ⚠️ Un véhicule en mode vie privée ne peut pas bloquer le rapport de toute la société
   * (ce serait un seul véhicule protégé contre quarante). Il est donc retiré — mais un
   * total silencieusement amputé est un total FAUX : la mention et les plaques doivent
   * figurer dans le classeur.
   */
  it('exclut les véhicules en mode vie privée ET le dit, plaques comprises', async () => {
    const { svc, capture } = buildScope({ avecPrive: true });
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));

    // Le véhicule privé ne fait pas partie de la requête trajets.
    expect(capture.tripWhere.vehicleId.in).not.toContain(VEH_PRIVE);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const synth = wb.getWorksheet('Synthèse par véhicule')!;
    const mention = String(synth.getCell('A3').value ?? '');
    expect(mention).toContain('vie privée');
    expect(mention).toContain('ZZ-999-ZZ');
  });

  it('borne au périmètre de l’appelant, jamais à toute la société', async () => {
    const { svc, capture } = buildScope({ accessible: [VEH_A] });
    await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.VIEWER));
    expect(capture.vehWhere.id).toEqual({ in: [VEH_A] });
    expect(capture.vehWhere.fleetId).toBe(FLEET_ID);
  });

  it('refuse la société d’autrui à un non-super-administrateur', async () => {
    const { svc } = buildScope();
    await expect(
      svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN, 'autre-flotte')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  /**
   * ══ LE FILTRE CONDUCTEUR DU CLASSEUR DE PÉRIMÈTRE (F13) ════════════════════════════
   *
   * ⚠️ C'EST LE CHEMIN PAR DÉFAUT DE L'ÉCRAN. Le bouton « Excel » n'exige plus qu'un
   * véhicule soit choisi ; sans `vehicleId`, le contrôleur appelle `generateScope`. Le
   * classeur d'UN VÉHICULE avait ses tests de filtre, celui-ci n'en avait aucun : on
   * pouvait retirer le `driverId` du `where`, figer le titre ou supprimer la mention
   * sans qu'une seule assertion bronche.
   *
   * QUATRE CHOSES DOIVENT TENIR ENSEMBLE, et c'est leur conjonction qui fait la valeur du
   * document : le `where` borné, le nom dans le titre, la mention de ce qui manque, et
   * l'absence effective des passages en station qu'elle annonce. Un classeur qui affirme
   * « ne porte QUE les trajets de X » en portant tout le parc est le fichier qu'on ne
   * rattrape plus une fois parti par courriel.
   */
  it('sous filtre : borne les trajets, nomme la personne, annonce ce qui manque', async () => {
    const { svc, capture, prisma } = buildScope();
    const { buffer } = await svc.generateScope(
      { fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN),
      { scope: 'drv-alice', label: 'Alice Martin' },
    );

    expect(capture.tripWhere.driverId).toBe('drv-alice');
    // La décision (c) au banc d'essai : l'Excel RETIRE les passages en station, il ne se
    // contente pas de l'écrire. Sans cette ligne, la mention pourrait promettre une
    // exclusion devant une feuille « Passages station » bien présente.
    expect(prisma.tripFuelStop.findMany).not.toHaveBeenCalled();

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const synth = wb.getWorksheet('Synthèse par véhicule')!;
    expect(String(synth.getCell('A1').value)).toContain('Alice Martin');
    const mention = String(synth.getCell('A3').value ?? '');
    expect(mention).toContain('ne porte QUE les trajets de Alice Martin');
    expect(mention).toContain('passages en station');
    // Une seule mention : l'en-tête reste en 4 (il ne descend en 5 qu'avec le mode privé).
    expect((synth.getRow(4).values as unknown[])[1]).toBe('Véhicule');
  });

  /**
   * ⚠️ `null` EST UN FILTRE, PAS UNE ABSENCE DE FILTRE. `toHaveProperty('driverId', null)`
   * et non une comparaison sur la valeur : une clé ABSENTE se lirait `undefined`, ce que
   * Prisma comprend comme « aucun filtre » — exactement l'inverse de ce qui est demandé.
   */
  it('« sans conducteur » : le where ne rend que les orphelins, et le titre le dit', async () => {
    const { svc, capture } = buildScope();
    const { buffer } = await svc.generateScope(
      { fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN),
      { scope: null, label: 'Sans conducteur' },
    );

    expect(capture.tripWhere).toHaveProperty('driverId', null);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    expect(String(wb.getWorksheet('Synthèse par véhicule')!.getCell('A1').value))
      .toContain('trajets sans conducteur');
  });

  /**
   * La contre-épreuve, sans laquelle les trois assertions ci-dessus laisseraient passer une
   * mention POSÉE EN PERMANENCE : un avertissement qui s'affiche toujours ne s'avertit plus
   * de rien, et un `driverId` glissé au `where` sans filtre ne rendrait que les orphelins.
   */
  it('sans filtre : aucun driverId au where, ni nom ni mention — le classeur d’avant', async () => {
    const { svc, capture, prisma } = buildScope();
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));

    expect(capture.tripWhere).not.toHaveProperty('driverId');
    expect(prisma.tripFuelStop.findMany).toHaveBeenCalledTimes(1);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const synth = wb.getWorksheet('Synthèse par véhicule')!;
    expect(String(synth.getCell('A1').value)).toBe('Flotte Test');
    expect(String(synth.getCell('A3').value ?? '')).toBe('');
  });

  /**
   * Même défaut, autre feuille, et pire : la fusion A:H de « Synthèse par véhicule » ne
   * portait NI `wrapText` NI hauteur du tout. Elle ne recevait jusqu'ici qu'une mention
   * courte — les plaques en mode vie privée — et une cellule fusionnée non renvoyée à la
   * ligne est ÉCRÊTÉE à la largeur de la fusion. La mention du filtre conducteur y verse
   * 164 caractères pour ~129 unités : sa fin tombait pour n'importe quel nom.
   */
  it('la mention fusionnée du parc est renvoyée à la ligne et dimensionnée', async () => {
    const { svc } = buildScope();
    const { buffer } = await svc.generateScope(
      { fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN),
      { scope: 'drv-alice', label: 'Alice Martin' },
    );

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('Synthèse par véhicule')!;
    const texte = String(ws.getCell('A3').value ?? '');

    expect(texte).toContain('exclus de ce classeur');
    expect(ws.getCell('A3').alignment?.wrapText).toBe(true);
    // ~124 caractères par ligne pour les 129 unités cumulées des huit colonnes.
    expect(ws.getRow(3).height).toBeGreaterThanOrEqual(Math.ceil(texte.length / 124) * 15);
  });
});

/**
 * ══ LA FEUILLE « PAR CONDUCTEUR OU GROUPE » (F13) ═══════════════════════════════════════
 *
 * Le dernier trou déclaré du chantier : l'écran rend ce récapitulatif depuis le 5 septembre,
 * les documents non — « le client voit à l'écran ce que son PDF ne dit pas ». Un classeur se
 * pose sur une table de réunion : il doit répondre à « qui a roulé ? ».
 *
 * Ces tests tiennent les trois façons de le rendre FAUX :
 *   1. taire les trajets que rien ne rattache à personne — 99 % de la population chez deux
 *      sociétés de production sur cinq (mh cars : 1 866 sur 1 886 au 2026-09-05) ;
 *   2. les rapporter à la somme des lignes classées (« 1 866 sur 22 ») au lieu du total réel ;
 *   3. imputer au NOM du conducteur plutôt qu'à son identifiant — deux homonymes fondus.
 */
describe('ReportExcelService — feuille « Par conducteur ou groupe »', () => {
  const VEH_B = 'veh-b';

  function buildScopeTrips(trips: unknown[], accessible: string[] | 'ALL' = 'ALL') {
    const vehicules = [
      {
        id: VEH_A, plate: 'AB-123-CD', brand: 'Renault', model: 'Master', type: 'VAN',
        fuelConsumptionL100km: null, calibratedConsumptionL100km: null, calibratedTanks: 0,
        privacyModeEnabled: false, groups: [{ group: { id: 'g1', name: 'Livraisons' } }],
      },
      {
        id: VEH_B, plate: 'EF-456-GH', brand: 'Peugeot', model: 'Partner', type: 'VAN',
        fuelConsumptionL100km: null, calibratedConsumptionL100km: null, calibratedTanks: 0,
        privacyModeEnabled: false, groups: [],
      },
    ];
    const prisma = {
      fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID, name: 'Flotte Test', fuelPriceEurL: 1.9 }) },
      vehicle: { findMany: jest.fn().mockResolvedValue(vehicules) },
      trip: { findMany: jest.fn().mockResolvedValue(trips) },
      tripFuelStop: { findMany: jest.fn().mockResolvedValue([]) },
    } as any;
    const vehicleAccess = { getAccessibleVehicleIds: jest.fn().mockResolvedValue(accessible) } as any;
    return new ReportExcelService(prisma, vehicleAccess);
  }

  const trajet = (o: Record<string, unknown>) => ({
    startedAt: new Date('2026-06-02T08:00:00.000Z'),
    endedAt: new Date('2026-06-02T08:30:00.000Z'),
    durationSeconds: 1800, distanceKm: 10, maxSpeed: 90, avgSpeed: 40,
    notes: null, driverId: null, driver: null,
    ...o,
  });

  /** Lit la feuille et rend ses lignes utiles, index de ligne compris. */
  async function feuille(buffer: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('Par conducteur ou groupe')!;
    const valeurs = (r: number) => (ws.getRow(r).values as unknown[]).slice(1);
    return { ws, valeurs, texte: (r: number) => String(ws.getCell(`A${r}`).value ?? '') };
  }

  /**
   * LA RÈGLE, DE BOUT EN BOUT : conducteur s'il est connu, sinon GROUPE du véhicule, sinon
   * personne. C'est la règle du contrat partagé (`cleImputationTrajet`), et le repli sur le
   * groupe n'est pas un détail — chez cdef31, 2 675 trajets sur 2 707 n'ont pas de conducteur
   * mais ont un groupe : sans lui, 99 % du parc serait « non attribué ».
   */
  it('impute au conducteur, sinon au groupe du véhicule, sinon à personne', async () => {
    const svc = buildScopeTrips([
      trajet({ vehicleId: VEH_A, driverId: 'drv-alice', driver: { firstName: 'Alice', lastName: 'Martin' }, distanceKm: 30 }),
      trajet({ vehicleId: VEH_A, distanceKm: 20 }),               // sans conducteur → groupe du véhicule
      trajet({ vehicleId: VEH_B, distanceKm: 5 }),                // ni conducteur ni groupe
    ]);
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const { valeurs, texte, ws } = await feuille(buffer);

    // Une seule mention (les non attribués) : l'en-tête reste en ligne 4.
    expect(valeurs(4)).toEqual(['Conducteur ou groupe', 'Sorte', 'Trajets', 'Distance (km)', 'Durée']);
    // Les plus gros rouleurs d'abord, et la SORTE dit d'où vient la ligne : sans elle,
    // « Livraisons » et « Alice Martin » se lisent comme deux personnes.
    expect(valeurs(5)).toEqual(['Alice Martin', 'conducteur', 1, 30, '30min']);
    expect(valeurs(6)).toEqual(['Livraisons', 'groupe', 1, 20, '30min']);
    // Le total ne prétend PAS être celui du classeur : il manque le trajet non attribué.
    const total = ws.getRow(ws.rowCount);
    expect(total.getCell(1).value).toBe('TOTAL (lignes classées)');
    expect(total.getCell(3).value).toBe(2);
    // Et le trajet de personne est compté, en tête, sur le total RÉEL du classeur.
    expect(texte(3)).toContain('1 trajet sur 3 de ce classeur');
    expect(texte(3)).toContain('ni conducteur, ni groupe');
  });

  /**
   * ⚠️ LE PIÈGE PAYÉ PAR L'ÉCRAN : une première version n'affichait la mention que si le
   * classement était vide. Chez cdef31, dix-sept groupes classés l'auraient masquée, et le
   * gestionnaire aurait cru lire une image complète.
   */
  it('dit les non attribués MÊME quand le classement est plein', async () => {
    const svc = buildScopeTrips([
      trajet({ vehicleId: VEH_A, driverId: 'drv-alice', driver: { firstName: 'Alice', lastName: 'Martin' } }),
      trajet({ vehicleId: VEH_A }),
      trajet({ vehicleId: VEH_B }),
      trajet({ vehicleId: VEH_B }),
    ]);
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const { texte, valeurs } = await feuille(buffer);

    expect(valeurs(5)).toContain('Alice Martin'); // le classement n'est pas vide…
    expect(texte(3)).toContain('2 trajets sur 4 de ce classeur'); // …et la mention est là quand même.
  });

  /**
   * ⚠️ LE DÉNOMINATEUR EST LE TOTAL DU CLASSEUR, jamais la somme des lignes classées. Sur la
   * population de mh cars, l'erreur aurait produit « 1 866 sur 22 » : un chiffre absurde, mais
   * imprimé, et personne pour le démentir six mois plus tard.
   */
  it('rapporte les non attribués au total du classeur, pas aux lignes classées', async () => {
    const svc = buildScopeTrips([
      trajet({ vehicleId: VEH_A, driverId: 'drv-alice', driver: { firstName: 'Alice', lastName: 'Martin' } }),
      ...Array.from({ length: 9 }, () => trajet({ vehicleId: VEH_B })),
    ]);
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const { texte } = await feuille(buffer);

    expect(texte(3)).toContain('9 trajets sur 10 de ce classeur');
    expect(texte(3)).not.toContain('sur 1 de ce classeur');
  });

  /**
   * Le cas le plus fréquent en production : aucune ligne classée du tout. Le classeur doit
   * distinguer « rien n'est imputé » (un trou de données à combler) de « rien n'a roulé ».
   */
  it('classement vide : le dit, et compte quand même les trajets de personne', async () => {
    const svc = buildScopeTrips([trajet({ vehicleId: VEH_B }), trajet({ vehicleId: VEH_B })]);
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const { texte } = await feuille(buffer);

    expect(texte(3)).toContain('2 trajets sur 2 de ce classeur');
    expect(texte(5)).toBe('Aucun trajet n’est imputé à un conducteur ni à un groupe.');
  });

  it('aucun trajet : la feuille dit la période vide, pas un trou de données', async () => {
    const svc = buildScopeTrips([]);
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const { texte } = await feuille(buffer);

    expect(texte(3)).toBe(''); // aucune mention : il n'y a rien à ne pas attribuer
    expect(texte(5)).toBe('Aucun trajet sur la période.');
  });

  /**
   * ⚠️ LA MÊME LIGNE, SOUS FILTRE, DEVIENT UN FAUX. Un gestionnaire filtre sur quelqu'un qui
   * était en congés tout le mois : le classeur sort vide alors que la société a roulé. « Aucun
   * trajet sur la période. » est exactement la phrase que le PDF prend soin de ne pas écrire
   * (« Aucun trajet retenu par ce filtre sur la période ») — et c'est la seule phrase
   * affirmative que l'œil trouve juste sous l'en-tête.
   *
   * L'assertion `toBe` sur la phrase d'origine est délibérée : un `toContain` sur la nouvelle
   * laisserait revenir l'ancienne à côté.
   */
  it('aucun trajet SOUS FILTRE : la feuille ne déclare pas la période vide', async () => {
    const svc = buildScopeTrips([]);
    const { buffer } = await svc.generateScope(
      { fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN),
      { scope: 'drv-9', label: 'Nael Mhamdi' },
    );
    const { texte } = await feuille(buffer);

    // Une seule mention (le filtre) → l'en-tête reste en 4, la phrase en 5.
    expect(texte(3)).toContain('Périmètre limité par le filtre conducteur');
    expect(texte(5)).not.toBe('Aucun trajet sur la période.');
    expect(texte(5)).toContain('retenu par ce filtre');
    expect(texte(5)).toContain('la période n’est pas vide pour autant');
  });

  /**
   * ⚠️ L'ADDITION QUE LA FEUILLE INVITE À FAIRE DOIT RETOMBER JUSTE.
   *
   * « TOTAL (lignes classées) » n'est pas le total du classeur : la feuille dit elle-même
   * que les non attribués annoncés en tête « ne figurent dans aucune ligne ci-dessous ». Le
   * lecteur additionne donc les deux et compare au TOTAL de la feuille « Trajets ». Cette
   * dernière sommait les valeurs DÉJÀ ARRONDIES au dixième, sur une donnée stockée au
   * centième : ~0,05 km jetés par trajet, toujours dans le même sens, soit ~23 km d'écart
   * sur un classeur plafonné. Le compte de TRAJETS, lui, retombait juste — ce qui rendait
   * l'écart de distance parfaitement inexplicable pour le lecteur.
   *
   * ⚠️ LES DISTANCES DE CE TEST ONT DEUX DÉCIMALES, ET C'EST TOUT L'INTÉRÊT : les autres
   * tests du fichier n'utilisent que des entiers (30, 20, 5, 10), où l'arrondi ne mord
   * jamais. C'est ce qui a laissé passer le défaut.
   */
  it('le TOTAL des trajets se réconcilie avec l’imputation, distances au centième', async () => {
    const svc = buildScopeTrips([
      // VEH_A porte le groupe « Livraisons » → 10 lignes classées de 12,35 km.
      ...Array.from({ length: 10 }, () => trajet({ vehicleId: VEH_A, distanceKm: 12.35 })),
      // VEH_B n'a ni groupe ni conducteur → 10 trajets non attribués de 7,45 km.
      ...Array.from({ length: 10 }, () => trajet({ vehicleId: VEH_B, distanceKm: 7.45 })),
    ]);
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const trajets = wb.getWorksheet('Trajets')!;
    const imputation = wb.getWorksheet('Par conducteur ou groupe')!;

    const totalTrajets = trajets.getRow(trajets.rowCount).getCell(5).value as number;
    const totalClassees = imputation.getRow(imputation.rowCount).getCell(4).value as number;
    expect(String(imputation.getCell('A3').value)).toContain('74.5 km');
    expect(totalClassees).toBe(123.5);

    // 123,5 + 74,5. La somme des arrondis donnait 199 — un kilomètre de trop sur vingt
    // trajets, et le lecteur n'avait aucun moyen de savoir lequel des deux totaux croire.
    expect(totalTrajets).toBe(198);
    expect(totalTrajets).toBe(totalClassees + 74.5);
  });

  /**
   * ⚠️ DEUX HOMONYMES NE SONT PAS UNE PERSONNE. L'imputation porte sur `driverId`, pas sur le
   * nom affiché : fondre deux conducteurs en une ligne doublerait ses kilomètres et ses
   * excès, sous un nom qui a l'air juste.
   */
  it('sépare deux conducteurs homonymes — la clé est l’identifiant', async () => {
    const svc = buildScopeTrips([
      trajet({ vehicleId: VEH_A, driverId: 'drv-1', driver: { firstName: 'Jean', lastName: 'Martin' }, distanceKm: 30 }),
      trajet({ vehicleId: VEH_B, driverId: 'drv-2', driver: { firstName: 'Jean', lastName: 'Martin' }, distanceKm: 20 }),
    ]);
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const { valeurs } = await feuille(buffer);

    expect(valeurs(4)[0]).toBe('Conducteur ou groupe'); // aucune mention : rien de non attribué
    expect(valeurs(5)).toEqual(['Jean Martin', 'conducteur', 1, 30, '30min']);
    expect(valeurs(6)).toEqual(['Jean Martin', 'conducteur', 1, 20, '30min']);
  });

  /**
   * ⚠️ SOUS FILTRE, LE CLASSEMENT SE RÉDUIT PAR CONSTRUCTION : une seule ligne, laissée sans
   * contexte, se lit « il n'y a qu'une personne qui roule dans cette société ». Les mentions
   * s'empilent alors, et l'en-tête descend avec elles — sinon la seconde efface la première.
   */
  it('sous filtre conducteur, empile les mentions et fait descendre l’en-tête', async () => {
    const svc = buildScopeTrips([
      trajet({ vehicleId: VEH_A, driverId: 'drv-alice', driver: { firstName: 'Alice', lastName: 'Martin' } }),
      trajet({ vehicleId: VEH_B }),
    ]);
    const { buffer } = await svc.generateScope(
      { fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN),
      { scope: 'drv-alice', label: 'Alice Martin' },
    );
    const { valeurs, texte, ws } = await feuille(buffer);

    expect(texte(3)).toContain('ni conducteur, ni groupe');
    expect(texte(4)).toContain('ce n’est pas le classement de la société');
    // L'en-tête a bien descendu d'une ligne, et le volet figé l'a suivi.
    expect(valeurs(5)[0]).toBe('Conducteur ou groupe');
    expect((ws.views[0] as { ySplit?: number } | undefined)?.ySplit).toBe(5);
  });

  /** Le classeur d'UN véhicule répond à « qui l'a conduit », avec la même feuille. */
  it('le classeur d’un véhicule porte la même feuille', async () => {
    const { svc } = buildService('ALL');
    const { buffer } = await svc.generate(VEH_A, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const { valeurs, texte } = await feuille(buffer);

    // Alice 12,4 km, Bob 7,5 km — et le trajet sans conducteur du véhicule (20,1 km), qui
    // n'a pas de groupe dans ce jeu d'essai, n'est imputé à personne.
    expect(valeurs(5)).toEqual(['Alice Martin', 'conducteur', 1, 12.4, '30min']);
    expect(valeurs(6)).toEqual(['Bob Durand', 'conducteur', 1, 7.5, '20min']);
    expect(texte(3)).toContain('1 trajet sur 3 de ce classeur');
  });
});

/**
 * ══ LE PLAFOND DU CLASSEUR, ET LA PART QUI MANQUAIT À SA MENTION ═══════════════════════
 *
 * Deux défauts d'une même phrase, « N trajets sur M de ce classeur » :
 *
 *   1. le classeur s'arrête à 5 000 trajets et ne le disait NULLE PART — une phrase qui
 *      prétend compter au-dessus d'un classeur tronqué en silence est pire que le silence,
 *      parce qu'elle a l'air de tout compter ;
 *   2. elle donnait les deux nombres SANS la part, là où l'écran et le PDF écrivent
 *      « (99 %, 11 460 km) » sur les mêmes trajets. Trois surfaces, deux présentations.
 */
describe('ReportExcelService — le plafond du classeur et la part des non attribués', () => {
  const VEH_B = 'veh-b';

  /**
   * @param fuelStops passages en station rendus par le simulacre. ⚠️ Ils NE SONT PAS
   *   plafonnés en production (`tripFuelStop.findMany` n'a aucun `take`, à trois lignes du
   *   `take: TRIPS_CAP` des trajets) : c'est une population parallèle, lue sur toute la
   *   période. Les deux harnais du fichier rendaient `[]`, et c'est ce qui a laissé la
   *   co-occurrence « plafond atteint + passages en station » sans aucun test.
   */
  function buildScopeTrips(trips: unknown[], fuelStops: unknown[] = []) {
    const vehicules = [
      {
        id: VEH_A, plate: 'AB-123-CD', brand: 'Renault', model: 'Master', type: 'VAN',
        fuelConsumptionL100km: null, calibratedConsumptionL100km: null, calibratedTanks: 0,
        privacyModeEnabled: false, groups: [{ group: { id: 'g1', name: 'Livraisons' } }],
      },
      {
        id: VEH_B, plate: 'EF-456-GH', brand: 'Peugeot', model: 'Partner', type: 'VAN',
        fuelConsumptionL100km: null, calibratedConsumptionL100km: null, calibratedTanks: 0,
        privacyModeEnabled: false, groups: [],
      },
    ];
    const prisma = {
      fleet: { findUnique: jest.fn().mockResolvedValue({ id: FLEET_ID, name: 'Flotte Test', fuelPriceEurL: 1.9 }) },
      vehicle: { findMany: jest.fn().mockResolvedValue(vehicules) },
      // ⚠️ Le simulacre rend EXACTEMENT ce qu'on lui donne : c'est Prisma qui applique le
      // `take` en production, et ce test joue le résultat d'un `take` saturé.
      trip: { findMany: jest.fn().mockResolvedValue(trips) },
      tripFuelStop: { findMany: jest.fn().mockResolvedValue(fuelStops) },
    } as any;
    const vehicleAccess = { getAccessibleVehicleIds: jest.fn().mockResolvedValue('ALL') } as any;
    return new ReportExcelService(prisma, vehicleAccess);
  }

  const passage = (jour: number, prix: number) => ({
    arrivedAt: new Date(`2026-06-${String(jour).padStart(2, '0')}T10:00:00.000Z`),
    durationSec: 600, fuelType: 'DIESEL', unitPriceEur: prix,
    station: { brand: 'Total', name: 'Total', city: 'Toulouse', address: '1 rue X' },
  });

  const trajet = (o: Record<string, unknown>) => ({
    startedAt: new Date('2026-06-02T08:00:00.000Z'),
    endedAt: new Date('2026-06-02T08:30:00.000Z'),
    durationSeconds: 1800, distanceKm: 10, maxSpeed: 90, avgSpeed: 40,
    notes: null, driverId: null, driver: null,
    ...o,
  });

  async function feuille(buffer: Buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const ws = wb.getWorksheet('Par conducteur ou groupe')!;
    return { ws, texte: (r: number) => String(ws.getCell(`A${r}`).value ?? '') };
  }

  /**
   * ⚠️ LE CAS QUI FAIT MENTIR LA PHRASE : 5 000 trajets rendus, donc un `take` saturé. Le
   * lecteur doit apprendre le plafond AVANT de lire « sur 5 000 » — sinon il prend ce 5 000
   * pour le compte de sa société, et la fin de période, qui est celle qui l'intéresse, a
   * disparu sans un mot (le tri est chronologique croissant).
   *
   * ⚠️ DÉLAI PROPRE DE 60 s, ET IL DOIT RESTER — c'est le seul test du dossier qui fasse
   * écrire à ExcelJS un classeur de 5 000 lignes (~146 ko). Le bloc `jest` de
   * apps/api/package.json ne règle AUCUN `testTimeout` : la limite par défaut de Jest,
   * 5 000 ms, s'appliquait donc à ce test. Or son coût mesuré va de 1,8 s machine au
   * repos à plus de 6 s machine chargée — le plafond tombait AU MILIEU de la bande de
   * dispersion, pas au-dessus d'elle, et le test échouait environ une passe sur deux
   * en fin de journée avec « Exceeded timeout of 5000 ms for a test. ». Une suite qui
   * rougit selon la CHARGE est pire qu'un test absent : elle apprend à l'équipe à
   * relancer au lieu de lire, et la prochaine vraie régression d'Excel passerait pour
   * « encore ce test-là ». Même geste et même valeur que le test de volume CSV
   * (exports-filtre-conducteur.spec.ts, `}, 60_000)`) — et surtout PAS un `testTimeout`
   * global, qui relâcherait le garde des ~3 400 autres tests pour en couvrir un.
   *
   * ⚠️ ET NE PAS RÉDUIRE LE JEU POUR L'ACCÉLÉRER : `TRIPS_CAP = 5000`
   * (report-excel.service.ts) est une constante de module, ni exportée ni injectable, et
   * la mention de plafond ne s'écrit QUE lorsque ce cap est atteint. Sous 5 000 trajets,
   * ce test devient rapide, vert — et n'éprouve plus rien.
   */
  it('plafond atteint : le classeur le dit, en tête et avant le compte', async () => {
    const trips = Array.from({ length: 5000 }, (_, i) =>
      trajet({ vehicleId: i < 4000 ? VEH_B : VEH_A }));
    // Trois passages en station, dont un POSTÉRIEUR à la coupe des trajets : c'est le cas
    // que la phrase de plafond englobait à tort.
    const svc = buildScopeTrips(trips, [passage(2, 1.7), passage(15, 1.9), passage(30, 2.1)]);
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const { texte, ws } = await feuille(buffer);

    // Ligne 3 : le plafond. Ligne 4 : le compte qu'il borne.
    expect(texte(3)).toContain('Classeur plafonné à 5000 trajets');
    expect(texte(3)).toContain('les plus ANCIENS de la période');
    expect(texte(3)).toContain('Resserrez la période');
    expect(texte(4)).toContain('4000 trajets sur 5000 de ce classeur');
    // L'en-tête a descendu de deux lignes, et le volet figé l'a suivi.
    expect(String(ws.getCell('A5').value)).toBe('Conducteur ou groupe');
    expect((ws.views[0] as { ySplit?: number } | undefined)?.ySplit).toBe(5);

    /**
     * ⚠️ ET LA PHRASE NE DOIT PLUS ENGLOBER CE QU'ELLE NE BORNE PAS. Elle affirmait « tous
     * les nombres de ce classeur, ceux des autres feuilles compris » alors que les passages
     * en station ne sont PAS plafonnés — le lecteur averti rapprochait un total de station
     * d'un total de trajets portant sur une autre population.
     */
    expect(texte(3)).not.toContain('ceux des autres feuilles');
    expect(texte(3)).toContain('ne sont PAS plafonnés');
    // Et l'exception dit vrai : la feuille porte bien les TROIS passages, coupe comprise.
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const stations = wb.getWorksheet('Passages station')!;
    expect(stations.rowCount).toBe(1 + 3 + 1); // en-tête + 3 passages + PRIX MOYEN
  }, 60_000);

  /**
   * Un classeur qui tient sous le plafond ne porte AUCUNE mention de plafond : un
   * avertissement permanent est un avertissement qu'on ne lit plus, et c'est le cas de
   * l'écrasante majorité des exports.
   */
  it('sous le plafond : aucune mention de plafond', async () => {
    const svc = buildScopeTrips([trajet({ vehicleId: VEH_B }), trajet({ vehicleId: VEH_A })]);
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const { texte } = await feuille(buffer);

    expect(texte(3)).not.toContain('plafonné');
    expect(texte(4)).not.toContain('plafonné');
    // La mention des non attribués, elle, est bien en tête comme avant.
    expect(texte(3)).toContain('1 trajet sur 2 de ce classeur');
  });

  /**
   * ⚠️ LA PART, AU MOT DE L'ÉCRAN ET DU PDF. Et c'est la règle du contrat partagé qui la
   * calcule : un simple arrondi écrirait « 100 % » pour 999 trajets sur 1 000, c'est-à-dire
   * « tous » alors qu'il en manque un — sur un classeur dont l'objet même est de dire ce qui
   * manque.
   */
  it('écrit la part, et n’affirme un extrême que si les nombres l’atteignent', async () => {
    const trips = [
      ...Array.from({ length: 999 }, () => trajet({ vehicleId: VEH_B })),
      trajet({ vehicleId: VEH_A, driverId: 'drv-alice', driver: { firstName: 'Alice', lastName: 'Martin' } }),
    ];
    const svc = buildScopeTrips(trips);
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const { texte } = await feuille(buffer);

    expect(texte(3)).toContain('999 trajets sur 1000 de ce classeur (> 99 %,');
    expect(texte(3)).not.toContain('(100 %,');
  });

  it('un trajet sur mille n’est pas « 0 % » : le classeur écrit « < 1 % »', async () => {
    const trips = [
      trajet({ vehicleId: VEH_B }),
      ...Array.from({ length: 999 }, () => trajet({ vehicleId: VEH_A })),
    ];
    const svc = buildScopeTrips(trips);
    const { buffer } = await svc.generateScope({ fleetId: FLEET_ID }, FROM, TO, makeUser(UserRole.FLEET_ADMIN));
    const { texte } = await feuille(buffer);

    expect(texte(3)).toContain('1 trajet sur 1000 de ce classeur (< 1 %,');
    expect(texte(3)).not.toContain('(0 %,');
  });
});
