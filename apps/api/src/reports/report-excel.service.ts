import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import * as ExcelJS from 'exceljs';
// `partLibelle` : la MÊME règle d'arrondi que l'écran et que le PDF, prise dans le contrat
// partagé — le classeur se pose à côté des deux, et « 99 % » ici contre « 100 % » là-bas sur
// les mêmes trajets se lit comme une erreur de calcul, pas comme une nuance d'arrondi.
import { CLE_NON_ATTRIBUE, cleImputationTrajet, partLibelle } from '@vizyo/tracky-shared';
import { formatFleetDate, formatFleetDateTime, parisDayKey } from '../common/utils/datetime';
import { PrismaService } from '../prisma/prisma.service';
import { VehicleAccessService } from '../vehicle-access/vehicle-access.service';
import { resolveReportVehicleScope } from '../common/report-vehicle-scope';
import type { AuthUser } from '../auth/types/auth-user';

/**
 * Sprint 5 (Rapports & filtres v2) — Export Excel « soigné » PAR VÉHICULE.
 *
 * Différent du CSV brut (dump papaparse) : un vrai classeur `.xlsx` mis en forme
 * (en-têtes stylés, bordures, formats nombre/durée, en-tête figé, lignes total)
 * sur 4 feuilles : Synthèse · Par conducteur ou groupe · Trajets · Par jour
 * (+ « Passages station » quand des passages ont été captés).
 *
 * Périmètre / sécurité (cf. PART A) :
 *   - le `vehicleId` demandé DOIT appartenir au périmètre véhicules de
 *     l'appelant (resolveReportVehicleScope → 403 si hors périmètre) ;
 *   - ET à la flotte de l'appelant (défense en profondeur, 403 si autre flotte).
 *
 * Perf (cf. ANALYSE §7) : 1 seul véhicule, trajets capés (≤ 5000), AUCUNE
 * position brute (le full-scan dangereux). Génération en Buffer mémoire.
 */

/** Cap défensif sur le nombre de trajets embarqués dans le classeur. */
const TRIPS_CAP = 5000;

/**
 * ══ LE FILTRE CONDUCTEUR D'UN CLASSEUR (F13, seconde moitié) ═══════════════════════════
 *
 * Un gestionnaire filtré sur une personne qui cliquait « Excel » recevait le classeur de
 * TOUT le parc. Un fichier survit à l'écran qui l'a produit : il part par courriel, il
 * s'ouvre en réunion, et rien dedans ne disait qu'il décrivait une autre population.
 *
 * @property scope l'identifiant du conducteur, ou `null` pour les trajets SANS conducteur
 *   (le mot-clé `none`). ⚠️ `null` est un FILTRE, pas une absence de filtre : c'est le
 *   paramètre lui-même qui, absent, veut dire « aucun filtre ». Cette forme rend impossible
 *   la confusion `null` / `undefined` qui, dans un `where`, ne rendrait que les orphelins.
 * @property label la désignation NUE que le classeur enchâsse dans ses phrases — « Sohaib
 *   Hamanni », « Sans conducteur ». ⚠️ Pas de préfixe « Conducteur : » ici : ce libellé
 *   s'écrit au milieu d'une phrase (« … QUE les trajets de … »), et un préfixe collé
 *   produirait « les trajets de Conducteur : Sohaib Hamanni ». La résolution du nom vit dans
 *   le contrôleur, seul endroit qui la fait une fois pour le PDF comme pour l'Excel.
 */
export interface FiltreConducteurClasseur {
  scope: string | null;
  label: string;
}

/**
 * Ce que la feuille de synthèse écrit quand un conducteur est demandé.
 *
 * ⚠️ Elle dit AUSSI ce que le classeur ne contient plus. Les passages en station sont des
 * arrêts du VÉHICULE : rien ne les rattache à une personne (`TripFuelStop` ne porte pas de
 * conducteur). Les garder sous le nom de quelqu'un afficherait une liste d'arrêts et un
 * « prix constaté » qui peuvent tous appartenir aux trajets d'un autre — donc on les retire,
 * et on le dit. Un classeur silencieusement composite serait le pire des trois.
 */
function mentionConducteur(filtre: FiltreConducteurClasseur): string {
  const porte = filtre.scope === null
    ? 'Ce classeur ne porte QUE les trajets sans conducteur.'
    : `Ce classeur ne porte QUE les trajets de ${filtre.label}.`;
  return `${porte} Les passages en station sont des arrêts du véhicule, pas d'une personne : ils sont exclus de ce classeur.`;
}

/**
 * Hauteur d'une ligne portant une mention FUSIONNÉE.
 *
 * ⚠️ EXCEL N'AJUSTE JAMAIS LA HAUTEUR D'UNE LIGNE FUSIONNÉE, et une hauteur posée par
 * ExcelJS sort dans le XML avec `customHeight="1"` — le drapeau ECMA-376 qui lui INTERDIT
 * de l'ajuster à l'ouverture. Une hauteur FIGÉE est donc une phrase coupée dès qu'elle
 * s'allonge, et avec `vertical: 'middle'` elle est rognée aux DEUX bouts : la première
 * ligne cisaillée par le haut, la dernière par le bas. Or ce qui disparaît ici est
 * précisément l'aveu du classeur — « les passages en station sont exclus », « 99 % des
 * trajets n'ont ni conducteur ni groupe ». Un classeur incomplet ET muet sur son
 * incomplétude est le pire des trois. On calcule donc la hauteur au lieu de la poser.
 *
 * @param carParLigne budget de caractères pour la largeur de la fusion, à ~0,96 caractère
 *   par unité de largeur de colonne — la calibration prudente de la feuille « Par
 *   conducteur ou groupe » (78 caractères pour ses 81 unités cumulées). Elle sur-réserve
 *   d'environ un quart : de la place perdue, jamais du texte perdu.
 * @param plancher hauteur minimale, pour ne pas rétrécir une mise en page existante.
 */
function hauteurMention(texte: string, carParLigne: number, plancher = 16): number {
  return Math.max(plancher, Math.ceil(texte.length / carParLigne) * 15);
}

/** Consommation par défaut (L/100km) par type véhicule — aligné reports-stats. */
const DEFAULT_CONSUMPTION_L100KM: Record<string, number> = {
  CAR: 7,
  TRUCK: 22,
  VAN: 10,
  MOTORCYCLE: 4,
  BICYCLE: 0,
  BUS: 28,
  CONSTRUCTION: 18,
  OTHER: 8,
};

const COLOR_HEADER_FILL = 'FF10E0A0'; // vert tracky (ARGB)
const COLOR_HEADER_FONT = 'FF06281F';
const COLOR_TOTAL_FILL = 'FFECFDF5';
const COLOR_TITLE_FONT = 'FF1F2937';

@Injectable()
export class ReportExcelService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vehicleAccess: VehicleAccessService,
  ) {}

  /**
   * Génère le classeur Excel d'un véhicule sur une période.
   *
   * @param conducteur filtre CONDUCTEUR (F13). Absent = aucun filtre, comportement d'avant.
   *   Présent, il borne les trajets ET se lit dans la feuille de synthèse : un classeur
   *   calculé sur une seule personne et qui ne le dit pas est le piège que ce lot ferme.
   * @returns buffer .xlsx + nom de fichier `tracky-{plaque}-{from}_{to}.xlsx`.
   */
  async generate(
    vehicleId: string,
    from: Date,
    to: Date,
    requestedBy: AuthUser,
    conducteur?: FiltreConducteurClasseur,
  ): Promise<{ buffer: Buffer; filename: string }> {
    // 1) 🔒 Périmètre utilisateur : lève ForbiddenException si vehicleId hors
    //    périmètre accessible (VIEWER/FLEET_MANAGER scope groupe/véhicules).
    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(requestedBy);
    resolveReportVehicleScope(accessible, [vehicleId]);

    // 2) Charge le véhicule (+ flotte) et vérifie l'appartenance flotte (défense
    //    en profondeur — un SUPER_ADMIN passe ; un non-super d'une autre flotte
    //    est rejeté même si la règle d'accès était incohérente).
    const vehicle = await this.prisma.vehicle.findUnique({
      where: { id: vehicleId },
      select: {
        id: true,
        plate: true,
        brand: true,
        model: true,
        type: true,
        fuelConsumptionL100km: true,
        calibratedConsumptionL100km: true,
        calibratedTanks: true,
        fleetId: true,
        privacyModeEnabled: true,
        // Le groupe sert l'IMPUTATION des trajets sans conducteur (F13). Ordonné par nom et
        // borné à un, comme partout ailleurs : le modèle est mono-groupe de facto, mais le
        // jour où un véhicule en aurait deux, les trois surfaces doivent choisir le même —
        // sinon un même trajet serait imputé à deux groupes différents selon le document.
        groups: { select: { group: { select: { id: true, name: true } } }, orderBy: { group: { name: 'asc' } }, take: 1 },
        fleet: { select: { id: true, name: true, fuelPriceEurL: true } },
      },
    });
    if (!vehicle) throw new NotFoundException('Véhicule introuvable');
    if (
      requestedBy.role !== UserRole.SUPER_ADMIN &&
      vehicle.fleetId !== requestedBy.fleetId
    ) {
      throw new ForbiddenException('Accès refusé à ce véhicule');
    }
    // Mode vie privée (RGPD) : les trajets révèlent les déplacements → export bloqué tant qu'actif.
    if (vehicle.privacyModeEnabled) {
      throw new ForbiddenException('Véhicule en mode vie privée : export indisponible tant que le mode privé est actif.');
    }

    // 3) Trajets du véhicule sur la période (capés, triés). PAS de positions.
    // ⚠️ `driverId` n'est écrit QUE si un filtre est demandé : la clé posée à `null` sans
    //    raison ne rendrait que les trajets orphelins, soit l'inverse de « pas de filtre ».
    const trips = await this.prisma.trip.findMany({
      where: {
        vehicleId,
        startedAt: { gte: from, lt: to },
        endedAt: { not: null },
        ...(conducteur ? { driverId: conducteur.scope } : {}),
      },
      select: {
        startedAt: true,
        endedAt: true,
        durationSeconds: true,
        distanceKm: true,
        maxSpeed: true,
        avgSpeed: true,
        movingSeconds: true,
        notes: true,
        // ⚠️ L'IDENTIFIANT, PAS SEULEMENT LE NOM (F13) : deux conducteurs peuvent être
        // homonymes, et une imputation faite sur le nom les fondrait en une seule ligne.
        driverId: true,
        driver: { select: { firstName: true, lastName: true } },
      },
      orderBy: { startedAt: 'asc' },
      take: TRIPS_CAP,
    });

    // 3bis) Passages en station-service du véhicule sur la période (prix DATÉ à chaque passage) —
    //       base du suivi de coût réel et de la future section d'auto-calcul à la pompe.
    //
    // ⚠️ AUCUN passage sous un filtre conducteur, et ce n'est pas un oubli : `TripFuelStop`
    // ne porte pas de conducteur (cf. `mentionConducteur`). Les charger quand même mettrait,
    // dans un classeur au nom d'une personne, des arrêts et un « prix constaté » qui peuvent
    // tous venir des trajets d'un autre. La feuille de synthèse dit qu'ils manquent.
    const fuelStops = conducteur ? [] : await this.prisma.tripFuelStop.findMany({
      where: { vehicleId, arrivedAt: { gte: from, lte: to } },
      select: {
        arrivedAt: true, durationSec: true, fuelType: true, unitPriceEur: true,
        station: { select: { brand: true, name: true, city: true, address: true } },
      },
      orderBy: { arrivedAt: 'asc' },
    });

    // 4) Agrégation KPI à partir des trajets chargés (+ prix constaté depuis les passages station).
    const kpis = this.aggregate(trips, vehicle, fuelStops);

    // 5) Construit le classeur.
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Vizyo Tracky';
    workbook.created = new Date();

    this.buildSynthese(workbook, vehicle, from, to, kpis, conducteur);
    // Le groupe d'un classeur de véhicule est CONSTANT — c'est celui du véhicule exporté.
    // La feuille répond donc surtout à « qui a conduit celui-ci, et combien ».
    const groupeDuVehicule = vehicle.groups?.[0]?.group ?? null;
    this.buildParImputation(workbook, this.imputer(trips, () => groupeDuVehicule), trips.length, conducteur);
    this.buildTrajets(workbook, trips);
    this.buildParJour(workbook, trips);
    if (fuelStops.length) this.buildPassagesStation(workbook, fuelStops);

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer as ArrayBuffer);
    const filename = `tracky-${this.safePlate(vehicle.plate)}-${this.dateSuffix(from, to)}.xlsx`;
    return { buffer, filename };
  }

  /**
   * ══ LE CLASSEUR D'UN PÉRIMÈTRE : SOCIÉTÉ, GROUPE, OU LES DEUX ═════════════════════
   *
   * ── CE QUI MANQUAIT ────────────────────────────────────────────────────────────────
   *
   * L'Excel n'existait QUE par véhicule. Un gestionnaire qui voulait le mois de son parc
   * devait lancer quarante exports et les recoller à la main — ou se rabattre sur le CSV
   * brut, qui n'est pas un document qu'on met sur une table de réunion. C'est la fonction
   * qui manquait le plus souvent au dossier mensuel.
   *
   * Le classeur ouvre sur une feuille « Synthèse par véhicule » — une ligne par véhicule,
   * total en bas — puis liste tous les trajets du périmètre, avec la colonne « Véhicule »
   * qui n'avait aucune raison d'exister dans l'export d'un seul véhicule.
   *
   * ⚠️ LES VÉHICULES EN MODE VIE PRIVÉE SONT EXCLUS, ET C'EST ÉCRIT DANS LE CLASSEUR.
   * L'export d'un véhicule en mode privé est refusé (403) ; celui d'un parc ne peut pas
   * l'être, sinon un seul véhicule protégé bloquerait le rapport de toute la société. On
   * les retire donc — mais un total silencieusement amputé est un total faux : la feuille
   * de synthèse porte la mention et le nombre.
   */
  async generateScope(
    scope: { fleetId: string; groupId?: string },
    from: Date,
    to: Date,
    requestedBy: AuthUser,
    conducteur?: FiltreConducteurClasseur,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const fleet = await this.prisma.fleet.findUnique({
      where: { id: scope.fleetId },
      select: { id: true, name: true, fuelPriceEurL: true },
    });
    if (!fleet) throw new NotFoundException('Société introuvable');
    if (requestedBy.role !== UserRole.SUPER_ADMIN && fleet.id !== requestedBy.fleetId) {
      throw new ForbiddenException('Accès refusé à cette société');
    }

    const accessible = await this.vehicleAccess.getAccessibleVehicleIds(requestedBy);
    const borne = resolveReportVehicleScope(accessible);
    const vehicles = await this.prisma.vehicle.findMany({
      where: {
        fleetId: fleet.id,
        ...(borne === 'ALL' ? {} : { id: { in: borne } }),
        ...(scope.groupId ? { groups: { some: { groupId: scope.groupId } } } : {}),
      },
      select: {
        id: true, plate: true, brand: true, model: true, type: true,
        fuelConsumptionL100km: true, calibratedConsumptionL100km: true, calibratedTanks: true,
        privacyModeEnabled: true,
        groups: { select: { group: { select: { id: true, name: true } } }, orderBy: { group: { name: 'asc' } }, take: 1 },
      },
      orderBy: { plate: 'asc' },
    });
    if (vehicles.length === 0) throw new NotFoundException('Aucun véhicule dans ce périmètre');

    const prives = vehicles.filter((v) => v.privacyModeEnabled);
    const exportables = vehicles.filter((v) => !v.privacyModeEnabled);
    if (exportables.length === 0) {
      throw new ForbiddenException(
        'Tous les véhicules de ce périmètre sont en mode vie privée : aucun trajet ne peut être exporté.',
      );
    }
    const ids = exportables.map((v) => v.id);

    const [trips, fuelStops] = await Promise.all([
      this.prisma.trip.findMany({
        // Filtre conducteur (F13) : écrit SEULEMENT s'il est demandé — `null` sans raison
        // ne rendrait que les trajets orphelins, l'inverse de « pas de filtre ».
        where: {
          vehicleId: { in: ids },
          startedAt: { gte: from, lt: to },
          endedAt: { not: null },
          ...(conducteur ? { driverId: conducteur.scope } : {}),
        },
        select: {
          vehicleId: true,
          startedAt: true, endedAt: true, durationSeconds: true,
          distanceKm: true, maxSpeed: true, avgSpeed: true, movingSeconds: true, notes: true,
          // Cf. le classeur d'un véhicule : l'imputation se fait sur l'IDENTIFIANT.
          driverId: true,
          driver: { select: { firstName: true, lastName: true } },
        },
        orderBy: { startedAt: 'asc' },
        take: TRIPS_CAP,
      }),
      // ⚠️ Rien sous un filtre conducteur : une station est un arrêt du VÉHICULE (cf.
      // `mentionConducteur`), et la feuille de synthèse annonce l'absence.
      conducteur ? Promise.resolve([]) : this.prisma.tripFuelStop.findMany({
        where: { vehicleId: { in: ids }, arrivedAt: { gte: from, lte: to } },
        select: {
          arrivedAt: true, durationSec: true, fuelType: true, unitPriceEur: true,
          station: { select: { brand: true, name: true, city: true, address: true } },
        },
        orderBy: { arrivedAt: 'asc' },
      }),
    ]);

    const plaque = new Map(exportables.map((v) => [v.id, v.plate]));
    const parVehicule = new Map<string, TripRow[]>();
    for (const t of trips) {
      const liste = parVehicule.get(t.vehicleId) ?? [];
      liste.push(t);
      parVehicule.set(t.vehicleId, liste);
    }

    const lignes: LigneVehicule[] = exportables.map((v) => {
      const siens = parVehicule.get(v.id) ?? [];
      return {
        plate: v.plate,
        modele: [v.brand, v.model].filter(Boolean).join(' '),
        groupe: v.groups?.[0]?.group?.name ?? '',
        kpis: this.aggregate(siens, { ...v, fleet }, []),
      };
    });

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Vizyo Tracky';
    workbook.created = new Date();

    this.buildSyntheseParVehicule(workbook, fleet.name, scope.groupId ? (lignes[0]?.groupe || null) : null, from, to, lignes, prives.map((v) => v.plate), conducteur);
    /**
     * Le groupe vient des véhicules EXPORTABLES — la même relation, ordonnée pareil, que
     * celle qui alimente la colonne « Groupe » de la feuille précédente. Un véhicule en mode
     * vie privée n'a ni trajet ni ligne ici : ses kilomètres ne peuvent pas se glisser dans
     * l'imputation d'un groupe par la porte de derrière.
     */
    const groupeParVehicule = new Map(exportables.map((v) => [v.id, v.groups?.[0]?.group ?? null]));
    this.buildParImputation(
      workbook,
      this.imputer(trips, (vehicleId) => groupeParVehicule.get(vehicleId ?? '') ?? null),
      trips.length,
      conducteur,
    );
    this.buildTrajets(workbook, trips, plaque);
    this.buildParJour(workbook, trips);
    if (fuelStops.length) this.buildPassagesStation(workbook, fuelStops);

    const arrayBuffer = await workbook.xlsx.writeBuffer();
    const buffer = Buffer.from(arrayBuffer as ArrayBuffer);
    const nom = scope.groupId ? (lignes[0]?.groupe || 'groupe') : fleet.name;
    const filename = `tracky-${this.safePlate(nom)}-${this.dateSuffix(from, to)}.xlsx`;
    return { buffer, filename };
  }

  /**
   * Feuille d'ouverture d'un classeur de périmètre : une ligne par véhicule, total en bas.
   *
   * ⚠️ Le total de la colonne « Vitesse moyenne » n'existe PAS : une moyenne de moyennes
   * n'a pas de sens, et un chiffre plausible à cet endroit serait lu comme la vitesse
   * moyenne du parc. La cellule porte un tiret.
   */
  private buildSyntheseParVehicule(
    wb: ExcelJS.Workbook,
    societe: string,
    groupe: string | null,
    from: Date,
    to: Date,
    lignes: LigneVehicule[],
    plaquesPrivees: string[],
    conducteur?: FiltreConducteurClasseur,
  ): void {
    const ws = wb.addWorksheet('Synthèse par véhicule', { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.mergeCells('A1:H1');
    const titre = ws.getCell('A1');
    // ⚠️ LE CONDUCTEUR EST DANS LE TITRE, pas dans une note de bas de feuille : c'est la
    // première chose lue, et c'est ce qui distingue ce classeur de celui de tout le parc.
    const coiffe = groupe ? `${societe} — groupe ${groupe}` : societe;
    titre.value = conducteur
      ? `${coiffe} — ${conducteur.scope === null ? 'trajets sans conducteur' : conducteur.label}`
      : coiffe;
    titre.font = { size: 15, bold: true, color: { argb: COLOR_TITLE_FONT } };
    ws.mergeCells('A2:H2');
    const sousTitre = ws.getCell('A2');
    // Borne haute EXCLUSIVE côté API : la date affichée est la veille, comme partout ailleurs.
    sousTitre.value = `Du ${formatFleetDate(from)} au ${formatFleetDate(new Date(to.getTime() - 1))} inclus · ${lignes.length} véhicule(s)`;
    sousTitre.font = { size: 11, color: { argb: 'FF6B7280' } };
    /**
     * ── LES MENTIONS S'EMPILENT, ET L'EN-TÊTE DESCEND AVEC ELLES ────────────────────────
     *
     * La ligne 3 portait LA mention (véhicules en mode privé) et l'en-tête était figé en 4.
     * Il y a désormais deux choses à pouvoir dire — le mode privé et le filtre conducteur —
     * et écrire la seconde en 3 effacerait la première. ⚠️ Sans mention, ou avec une seule,
     * la mise en page est celle d'avant au pixel : en-tête ligne 4, volet figé sur 4.
     */
    const mentions: string[] = [];
    if (plaquesPrivees.length > 0) {
      // ⚠️ Un total amputé sans mention est un total faux. On nomme les plaques : le lecteur
      // doit pouvoir vérifier lui-même que le manque est voulu, et non une panne.
      mentions.push(`⚠️ ${plaquesPrivees.length} véhicule(s) exclu(s) — mode vie privée actif : ${plaquesPrivees.join(', ')}`);
    }
    if (conducteur) mentions.push(`⚠️ ${mentionConducteur(conducteur)}`);
    mentions.forEach((texte, i) => {
      const r = 3 + i;
      ws.mergeCells(`A${r}:H${r}`);
      const cellule = ws.getCell(`A${r}`);
      cellule.value = texte;
      cellule.font = { size: 10, italic: true, color: { argb: 'FFB45309' } };
      // ⚠️ RENVOI À LA LIGNE ET HAUTEUR CALCULÉE (cf. `hauteurMention`). Cette fusion ne
      // portait qu'une mention courte — les plaques en mode vie privée — et n'avait donc
      // ni `wrapText` ni hauteur ; une cellule fusionnée non renvoyée à la ligne est
      // ÉCRÊTÉE à la largeur de la fusion. La mention du filtre conducteur, elle, fait
      // 164 caractères pour 129 unités : elle débordait déjà pour n'importe quel nom, et
      // c'est sa fin — « ils sont exclus de ce classeur » — qui tombait.
      cellule.alignment = { wrapText: true, vertical: 'middle' };
      ws.getRow(r).height = hauteurMention(texte, 124);
    });

    const ligneEnTete = Math.max(4, 3 + mentions.length);
    if (ligneEnTete !== 4) ws.views = [{ state: 'frozen', ySplit: ligneEnTete }];
    const enTete = ws.getRow(ligneEnTete);
    const colonnes = ['Véhicule', 'Modèle', 'Groupe', 'Trajets', 'Distance (km)', 'Durée', 'V. moyenne (km/h)', 'Carburant estimé (€)'];
    enTete.values = colonnes;
    enTete.eachCell((c) => {
      c.font = { bold: true, color: { argb: COLOR_HEADER_FONT } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_FILL } };
      c.alignment = { vertical: 'middle' };
    });
    ws.columns = [
      { width: 14 }, { width: 22 }, { width: 18 }, { width: 10 },
      { width: 15 }, { width: 12 }, { width: 18 }, { width: 20 },
    ];

    // Les plus gros rouleurs en tête : c'est l'ordre dans lequel on lit ce tableau.
    const triees = [...lignes].sort((a, b) => b.kpis.totalKm - a.kpis.totalKm);
    for (const l of triees) {
      ws.addRow([
        l.plate, l.modele, l.groupe,
        l.kpis.tripCount, l.kpis.totalKm, fmtDuration(l.kpis.totalDurationSeconds),
        l.kpis.avgSpeedKmh, l.kpis.estimatedCostEur,
      ]);
    }

    const total = ws.addRow([
      'TOTAL', '', '',
      triees.reduce((n, l) => n + l.kpis.tripCount, 0),
      round1(triees.reduce((n, l) => n + l.kpis.totalKm, 0)),
      fmtDuration(triees.reduce((n, l) => n + l.kpis.totalDurationSeconds, 0)),
      '—',
      Math.round(triees.reduce((n, l) => n + l.kpis.estimatedCostEur, 0) * 100) / 100,
    ]);
    total.eachCell((c) => {
      c.font = { bold: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_TOTAL_FILL } };
    });
  }

  // ---------------------------------------------------------------------------
  // Agrégation KPI
  // ---------------------------------------------------------------------------

  private aggregate(
    trips: TripRow[],
    vehicle: { type: string; fuelConsumptionL100km: number | null; calibratedConsumptionL100km: number | null; calibratedTanks: number; fleet: { fuelPriceEurL: number } | null },
    fuelStops: FuelStopRow[],
  ): Kpis {
    let totalKm = 0;
    let totalDurationSeconds = 0;
    let totalMovingSeconds = 0;
    let maxSpeed = 0;
    for (const t of trips) {
      const km = Math.max(0, t.distanceKm);
      totalKm += km;
      totalDurationSeconds += Math.max(0, t.durationSeconds);
      totalMovingSeconds += Math.max(0, t.movingSeconds);
      maxSpeed = Math.max(maxSpeed, Math.max(0, t.maxSpeed));
    }
    /**
     * ⚠️ Σ km ÷ Σ temps roulant — la MÊME formule que la synthèse et que chaque ligne de
     * trajet. C'était une moyenne des `avgSpeed` pondérée par la durée : correcte tant que
     * `avgSpeed` valait distance ÷ durée, fausse dès qu'il vaut distance ÷ temps roulant,
     * puisque le poids et le dénominateur ne parlent alors plus du même temps.
     *
     * Repli sur la durée totale si aucun trajet du lot n'a de temps roulant connu (données
     * d'avant la reprise, positions purgées).
     */
    const denomSec = totalMovingSeconds > 0 ? totalMovingSeconds : totalDurationSeconds;
    const avgSpeed = denomSec > 0 ? totalKm / (denomSec / 3600) : 0;

    // Conso EFFECTIVE : calibrée (méthode du plein) si mesurée, sinon paramétrée, sinon défaut type.
    const consL100 = (vehicle.calibratedTanks > 0 ? vehicle.calibratedConsumptionL100km : null)
      ?? vehicle.fuelConsumptionL100km
      ?? DEFAULT_CONSUMPTION_L100KM[vehicle.type]
      ?? 8;
    const estimatedLiters = (totalKm * consL100) / 100;
    const fuelPrice = vehicle.fleet?.fuelPriceEurL ?? 1.85;

    // Prix RÉELLEMENT CONSTATÉ en station (moyenne des prix captés aux passages du véhicule sur la période).
    const priced = fuelStops.filter((s) => s.unitPriceEur != null).map((s) => s.unitPriceEur as number);
    const observedPriceEurL = priced.length ? Math.round((priced.reduce((a, b) => a + b, 0) / priced.length) * 1000) / 1000 : null;
    const fuelType = fuelStops.find((s) => s.fuelType)?.fuelType ?? null;

    return {
      tripCount: trips.length,
      totalKm: round1(totalKm),
      totalDurationSeconds,
      avgSpeedKmh: round1(avgSpeed),
      maxSpeedKmh: round1(maxSpeed),
      estimatedLiters: round1(estimatedLiters),
      estimatedCostEur: Math.round(estimatedLiters * fuelPrice * 100) / 100,
      fuelPriceEurL: fuelPrice,
      fuelVisits: fuelStops.length,
      fuelType,
      observedPriceEurL,
      estimatedCostAtObservedEur: observedPriceEurL != null ? Math.round(estimatedLiters * observedPriceEurL * 100) / 100 : null,
    };
  }

  // ---------------------------------------------------------------------------
  // Feuille « Synthèse »
  // ---------------------------------------------------------------------------

  private buildSynthese(
    wb: ExcelJS.Workbook,
    vehicle: { plate: string; brand: string | null; model: string | null; fleet: { name: string } | null },
    from: Date,
    to: Date,
    k: Kpis,
    conducteur?: FiltreConducteurClasseur,
  ): void {
    const ws = wb.addWorksheet('Synthèse', {
      properties: { defaultColWidth: 22 },
      views: [{ showGridLines: false }],
    });
    ws.columns = [{ width: 28 }, { width: 26 }];

    // Titre.
    ws.mergeCells('A1:B1');
    const title = ws.getCell('A1');
    title.value = 'Rapport véhicule — Vizyo Tracky';
    title.font = { bold: true, size: 16, color: { argb: COLOR_TITLE_FONT } };
    ws.getRow(1).height = 24;

    /**
     * ── LE FILTRE CONDUCTEUR, JUSTE SOUS LE TITRE (F13) ────────────────────────────────
     *
     * La ligne 2 était vide ; elle porte maintenant ce qui change TOUT le contenu du
     * classeur quand il est posé. Ni discret ni en bas : un lecteur qui compare deux
     * classeurs du même véhicule doit voir immédiatement pourquoi les totaux diffèrent.
     * Sans filtre, la ligne reste vide et rien ne bouge.
     */
    if (conducteur) {
      ws.mergeCells('A2:B2');
      const mention = ws.getCell('A2');
      const texte = `⚠️ ${mentionConducteur(conducteur)}`;
      mention.value = texte;
      mention.font = { size: 10, italic: true, bold: true, color: { argb: 'FFB45309' } };
      mention.alignment = { wrapText: true, vertical: 'middle' };
      // ⚠️ Hauteur CALCULÉE, jamais figée (cf. `hauteurMention`) : les 164 caractères de
      // cette phrase demandent trois lignes sur les 54 unités cumulées de A et B, et les
      // 30 pt posés jusqu'ici en affichaient deux — la moitié coupée étant celle qui avoue
      // le retrait des passages en station. ~52 caractères par ligne pour ces 54 unités.
      ws.getRow(2).height = hauteurMention(texte, 52, 30);
    }

    const marqueModele = [vehicle.brand, vehicle.model].filter(Boolean).join(' ') || '—';
    const headerRows: Array<[string, string]> = [
      ['Plaque', vehicle.plate],
      ['Marque / modèle', marqueModele],
      ['Flotte', vehicle.fleet?.name ?? '—'],
      // La ligne d'identité du périmètre : elle se lit à côté de la plaque, pas en note.
      ...(conducteur ? [['Filtre conducteur', conducteur.label] as [string, string]] : []),
      // Fin INCLUSE : la borne `to` est le lendemain minuit, « au 03/09 » aurait promis un jour de plus.
      ['Période (du)', formatFleetDate(from)],
      ['Période (au, inclus)', formatFleetDate(new Date(to.getTime() - 1))],
    ];
    let r = 3;
    for (const [label, value] of headerRows) {
      const lc = ws.getCell(`A${r}`);
      const vc = ws.getCell(`B${r}`);
      lc.value = label;
      lc.font = { bold: true, color: { argb: COLOR_TITLE_FONT } };
      vc.value = value;
      r++;
    }

    // Section KPIs.
    r += 1;
    const kpiHeader = ws.getCell(`A${r}`);
    ws.mergeCells(`A${r}:B${r}`);
    kpiHeader.value = 'Indicateurs';
    kpiHeader.font = { bold: true, size: 13, color: { argb: COLOR_HEADER_FONT } };
    kpiHeader.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_FILL } };
    kpiHeader.alignment = { vertical: 'middle' };
    ws.getRow(r).height = 20;
    r++;

    const kpiRows: Array<[string, string | number, string | undefined]> = [
      ['Nombre de trajets', k.tripCount, '#,##0'],
      ['Distance totale (km)', k.totalKm, '#,##0.0'],
      ['Durée totale', fmtDuration(k.totalDurationSeconds), undefined],
      ['Vitesse moyenne (km/h)', k.avgSpeedKmh, '#,##0.0'],
      ['Vitesse max (km/h)', k.maxSpeedKmh, '#,##0.0'],
      ['Conso estimée (L)', k.estimatedLiters, '#,##0.0'],
      ['Coût estimé — prix paramétré (€)', k.estimatedCostEur, '#,##0.00'],
      ['Prix carburant paramétré (€/L)', k.fuelPriceEurL, '#,##0.000'],
    ];
    // Prix RÉELLEMENT CONSTATÉ en station sur la période (si des passages ont été captés).
    if (k.fuelVisits > 0) {
      kpiRows.push(['Passages en station', k.fuelVisits, '#,##0']);
      if (k.observedPriceEurL != null) {
        kpiRows.push([`Prix constaté en station (€/L${k.fuelType ? ' — ' + fuelLabelXlsx(k.fuelType) : ''})`, k.observedPriceEurL, '#,##0.000']);
        kpiRows.push(['Coût au prix constaté (€)', k.estimatedCostAtObservedEur ?? 0, '#,##0.00']);
      }
    }
    const kpiStart = r;
    for (const [label, value, fmt] of kpiRows) {
      const lc = ws.getCell(`A${r}`);
      const vc = ws.getCell(`B${r}`);
      lc.value = label;
      lc.font = { bold: true, color: { argb: COLOR_TITLE_FONT } };
      vc.value = value;
      if (fmt) vc.numFmt = fmt;
      vc.alignment = { horizontal: 'right' };
      r++;
    }
    // Bordures sur le bloc KPI.
    this.applyBorders(ws, `A${kpiStart}:B${r - 1}`);
    this.applyBorders(ws, `A${kpiStart - 1}:B${kpiStart - 1}`);
  }

  // ---------------------------------------------------------------------------
  // Feuille « Par conducteur ou groupe »
  // ---------------------------------------------------------------------------

  /**
   * ══ « QUI ROULE ? » — L'IMPUTATION DES TRAJETS DU CLASSEUR (F13) ═══════════════════════
   *
   * L'écran des Rapports rend ce récapitulatif depuis le 5 septembre ; les documents, non —
   * « le client voit à l'écran ce que son PDF ne dit pas ». Un classeur se pose sur une table
   * de réunion et sert de référence : il doit répondre à « qui a roulé ? », pas seulement à
   * « quel véhicule ? ».
   *
   * ⚠️ LA RÈGLE D'IMPUTATION EST CELLE DU CONTRAT PARTAGÉ (`cleImputationTrajet`) : le
   * conducteur du TRAJET s'il est renseigné, sinon le GROUPE du véhicule, sinon personne.
   * La recopier ici en aurait fait une seconde définition, et le classeur aurait fini par
   * répondre autrement que l'écran à la même question — la faute que ce produit a déjà payée
   * sur « reste à faire » et sur « avec excès ».
   *
   * ⚠️ CE CLASSEUR IMPUTE SES PROPRES TRAJETS, pas ceux de l'agrégat serveur : ses feuilles
   * sont toutes calculées sur les mêmes lignes (`TRIPS_CAP`), et une ligne d'imputation qui
   * viendrait d'ailleurs ne retomberait pas sur le total de la feuille « Trajets ». C'est
   * aussi pourquoi le dénombrement des non attribués se dit « de ce classeur ».
   *
   * @param groupeDe le groupe du véhicule d'un trajet — constant pour le classeur d'UN
   *   véhicule, lu dans une table pour celui d'un parc.
   */
  private imputer(
    trips: TripRow[],
    groupeDe: (vehicleId: string | undefined) => { id: string; name: string } | null,
  ): Imputation {
    const lignes = new Map<string, LigneImputation>();
    const nonAttribue = { tripCount: 0, km: 0 };

    for (const t of trips) {
      const groupe = groupeDe(t.vehicleId);
      const cle = cleImputationTrajet(t.driverId ?? null, groupe?.id ?? null);
      const km = Math.max(0, t.distanceKm);
      const dur = Math.max(0, t.durationSeconds);
      // ⚠️ COMPTÉ, JAMAIS CLASSÉ : on ne crée pas de ligne « personne ». Ces trajets et ces
      // kilomètres existent, ils ne peuvent simplement être portés au crédit de quiconque.
      if (cle === CLE_NON_ATTRIBUE) {
        nonAttribue.tripCount++;
        nonAttribue.km += km;
        continue;
      }
      let l = lignes.get(cle);
      if (!l) {
        lignes.set(cle, (l = {
          libelle: t.driverId
            // Repli qui ne devrait jamais s'afficher (supprimer un conducteur remet
            // `Trip.driverId` à NULL) : une ligne sans nom vaut mieux qu'une ligne escamotée,
            // qui emporterait ses kilomètres avec elle.
            ? (`${t.driver?.firstName ?? ''} ${t.driver?.lastName ?? ''}`.trim() || 'Conducteur inconnu')
            : (groupe?.name ?? 'Groupe sans nom'),
          sorte: t.driverId ? 'conducteur' : 'groupe',
          tripCount: 0, km: 0, durationSeconds: 0,
        }));
      }
      l.tripCount++;
      l.km += km;
      l.durationSeconds += dur;
    }

    return {
      // Les plus gros rouleurs d'abord, départage par le libellé : l'ordre d'une Map suit
      // l'ordre de lecture des trajets, que rien ne garantit d'un export à l'autre.
      lignes: [...lignes.values()].sort((a, b) => b.km - a.km || a.libelle.localeCompare(b.libelle, 'fr')),
      nonAttribue,
    };
  }

  /**
   * La feuille « Par conducteur ou groupe » — la même vérité que l'écran et que le PDF.
   *
   * ⚠️ LES NON ATTRIBUÉS SE DISENT QUEL QUE SOIT L'ÉTAT DU CLASSEMENT, et EN TÊTE de feuille.
   * L'écran a déjà payé cette faute : une première version ne montrait l'encart que si le
   * classement était vide, et chez cdef31 dix-sept groupes classés l'auraient masqué. Mesuré
   * en production le 2026-09-05 : chez mh cars, 1 866 trajets sur 1 886 n'ont NI conducteur NI
   * groupe — un classement muet sur ce point donnerait à lire une image complète alors qu'il
   * en manque 99 %.
   *
   * ⚠️ SON DÉNOMINATEUR EST LE TOTAL DES TRAJETS DU CLASSEUR, celui de la feuille « Trajets »,
   * jamais la somme des lignes classées : « 1 866 sur 22 » serait un mensonge parfaitement
   * crédible. Le pourcentage vient de `partLibelle` (contrat partagé) : c'est la mention de
   * l'écran et du PDF au mot près, « 1 866 trajets sur 1 886 (99 %, 11 460 km) ». Trois
   * surfaces qui montrent les mêmes trajets et n'écrivent pas la même part se lisent comme
   * une erreur de calcul.
   *
   * ⚠️ ET CE CLASSEUR EST PLAFONNÉ. Ses feuilles s'arrêtent à `TRIPS_CAP` trajets, les plus
   * ANCIENS de la période (`orderBy: startedAt asc` + `take`) : la fin de période manque. Une
   * phrase qui compte « N sur M de ce classeur » au-dessus d'un classeur tronqué en silence
   * est pire que le silence — elle a l'air de tout compter. Le plafond se dit donc là où le
   * lecteur compte, et AVANT le compte, pour qu'il sache d'emblée sur quoi porte le M.
   *
   * @param totalTrajets nombre de trajets embarqués dans le classeur (feuille « Trajets »).
   */
  private buildParImputation(
    wb: ExcelJS.Workbook,
    imputation: Imputation,
    totalTrajets: number,
    conducteur?: FiltreConducteurClasseur,
  ): void {
    const ws = wb.addWorksheet('Par conducteur ou groupe', { views: [{ state: 'frozen', ySplit: 4 }] });
    ws.columns = [
      { width: 30 }, { width: 14 },
      { width: 10, style: { numFmt: '#,##0' } },
      { width: 15, style: { numFmt: '#,##0.0' } },
      { width: 12 },
    ];

    ws.mergeCells('A1:E1');
    const titre = ws.getCell('A1');
    titre.value = 'Par conducteur ou groupe';
    titre.font = { size: 15, bold: true, color: { argb: COLOR_TITLE_FONT } };

    ws.mergeCells('A2:E2');
    const regle = ws.getCell('A2');
    // La règle d'imputation est ÉCRITE : sans elle, un lecteur ne peut pas savoir pourquoi
    // « Livraisons » et « Amine Berrada » figurent dans la même colonne.
    regle.value = 'Chaque trajet compte pour son conducteur, sinon pour le groupe de son véhicule.';
    regle.font = { size: 11, color: { argb: 'FF6B7280' } };

    /**
     * ── LES MENTIONS S'EMPILENT, ET L'EN-TÊTE DESCEND AVEC ELLES ────────────────────────
     *
     * Même mécanique que la feuille « Synthèse par véhicule », et pour la même raison :
     * il y a deux choses à pouvoir dire ici, écrire la seconde sur la ligne de la première
     * l'effacerait. Sans mention, en-tête ligne 4 et volet figé sur 4.
     */
    const mentions: string[] = [];
    /**
     * ── LE PLAFOND DU CLASSEUR, DIT AVANT LE COMPTE QU'IL BORNE ──────────────────────────
     *
     * `TRIPS_CAP` atteint = la période contient PEUT-ÊTRE davantage de trajets, et on ne peut
     * pas savoir combien sans une seconde requête de comptage. On ne prétend donc pas au
     * nombre manquant : on dit le plafond, le fait qu'il est atteint, et QUELS trajets ont
     * été gardés — les plus anciens, la fin de période étant coupée. Un lecteur averti sait
     * alors quoi faire (resserrer la période) ; un lecteur qui l'ignore prendrait « 4 300
     * trajets sur 5 000 de ce classeur » pour le compte de sa société.
     *
     * ⚠️ ET LA PHRASE DIT AUSSI CE QUE LE PLAFOND NE BORNE PAS. Elle affirmait « tous les
     * nombres de ce classeur, ceux des autres feuilles compris » : c'était FAUX pour les
     * passages en station. `tripFuelStop.findMany` n'a AUCUN `take` — à trois lignes du
     * `take: TRIPS_CAP` des trajets — et ces passages ne dérivent pas des trajets : c'est
     * une population parallèle, lue sur TOUTE la période. La feuille « Passages station »,
     * son PRIX MOYEN, et dans le classeur d'un véhicule les indicateurs « Passages en
     * station », « Prix constaté en station » et « Coût au prix constaté » (ce dernier
     * croisant des litres PLAFONNÉS avec un prix qui ne l'est pas) débordent donc la
     * fenêtre annoncée. Un lecteur qui fait confiance à la phrase rapprocherait un total de
     * station d'un total de trajets qui ne portent pas sur la même population.
     * Ne PAS « corriger » en plafonnant les passages : cela amputerait un prix moyen
     * aujourd'hui juste. On dit ce qui manque, et on dit ce qui déborde.
     */
    if (totalTrajets >= TRIPS_CAP) {
      mentions.push(
        `⚠️ Classeur plafonné à ${TRIPS_CAP} trajets, et ce plafond est atteint : la période en `
        + 'compte peut-être davantage. Les trajets gardés sont les plus ANCIENS de la période — '
        + 'la fin de période manque. Tous les nombres TIRÉS DES TRAJETS — cette feuille, '
        + '« Trajets », « Par jour » et la synthèse — portent sur ces trajets-là. EXCEPTION : '
        + 'les passages en station ne sont PAS plafonnés ; leur feuille, le prix constaté et le '
        + 'coût qui en découle couvrent TOUTE la période, ils ne se rapprochent donc pas des '
        + 'kilomètres ci-dessus. Resserrez la période pour obtenir un classeur homogène.',
      );
    }
    const na = imputation.nonAttribue;
    if (na.tripCount > 0) {
      const s = na.tripCount > 1 ? 's' : '';
      mentions.push(
        `⚠️ ${na.tripCount} trajet${s} sur ${totalTrajets} de ce classeur `
        + `(${partLibelle(na.tripCount, totalTrajets)}, ${round1(na.km)} km) `
        + `n’${na.tripCount > 1 ? 'ont' : 'a'} ni conducteur, ni groupe : `
        + `${na.tripCount > 1 ? 'ils ne figurent' : 'il ne figure'} dans aucune ligne ci-dessous, `
        + 'et ne peuvent être attribués à personne. Renseignez un conducteur ou un groupe sur ces '
        + 'véhicules pour que leurs kilomètres comptent pour quelqu’un.',
      );
    }
    /**
     * ⚠️ SOUS FILTRE, CE CLASSEMENT SE RÉDUIT PAR CONSTRUCTION — un classement d'une seule
     * ligne, laissé sans contexte, se lit « il n'y a qu'une personne qui roule ». La phrase
     * vaut pour les DEUX formes du filtre : sur une personne nommée il ne reste qu'une ligne,
     * sous « sans conducteur » il reste des lignes de GROUPE et aucune de personne.
     */
    if (conducteur) {
      mentions.push(
        '⚠️ Périmètre limité par le filtre conducteur de ce classeur : le classement ci-dessous '
        + 'ne porte que sur les trajets retenus. Un classeur centré sur une personne ne peut donc '
        + 'contenir qu’une seule ligne, et un classeur « sans conducteur » n’en contient aucune de '
        + 'conducteur — ce n’est pas le classement de la société.',
      );
    }
    mentions.forEach((texte, i) => {
      const r = 3 + i;
      ws.mergeCells(`A${r}:E${r}`);
      const cellule = ws.getCell(`A${r}`);
      cellule.value = texte;
      cellule.font = { size: 10, italic: true, color: { argb: 'FFB45309' } };
      cellule.alignment = { wrapText: true, vertical: 'middle' };
      // ⚠️ EXCEL N'AJUSTE PAS LA HAUTEUR D'UNE LIGNE FUSIONNÉE : sans ce calcul, la phrase
      // la plus importante de la feuille — celle qui dit que 99 % des trajets ne sont
      // attribués à personne — serait coupée au ras de la deuxième ligne. ~78 caractères
      // par ligne pour la largeur cumulée des cinq colonnes.
      ws.getRow(r).height = hauteurMention(texte, 78);
    });

    const ligneEnTete = Math.max(4, 3 + mentions.length);
    if (ligneEnTete !== 4) ws.views = [{ state: 'frozen', ySplit: ligneEnTete }];
    const enTete = ws.getRow(ligneEnTete);
    enTete.values = ['Conducteur ou groupe', 'Sorte', 'Trajets', 'Distance (km)', 'Durée'];
    enTete.eachCell((c) => {
      c.font = { bold: true, color: { argb: COLOR_HEADER_FONT } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_FILL } };
      c.alignment = { vertical: 'middle' };
    });

    if (imputation.lignes.length === 0) {
      // ⚠️ « Aucun trajet imputé » et « aucun trajet » sont deux faits différents : le premier
      // est un trou de données à combler, le second une période sans activité. Les confondre
      // enverrait le gestionnaire renseigner des conducteurs sur un parc à l'arrêt.
      //
      // ⚠️ ET « SUR LA PÉRIODE » SERAIT UN FAUX SOUS FILTRE — même règle que le PDF, qui
      // écrit déjà « Aucun trajet retenu par ce filtre sur la période » sur ce fait exact.
      // Un classeur filtré sur quelqu'un qui était en congés est vide parce qu'il vient
      // d'écarter tous les autres par construction, pas parce que le parc s'est arrêté ; et
      // c'est la seule phrase AFFIRMATIVE que l'œil trouve juste sous l'en-tête. Posée sur
      // une table de réunion, elle se lirait « le parc n'a pas bougé en juin ».
      // La seconde branche, elle, ne date pas sa population : elle reste vraie sous filtre.
      const vide = ws.addRow([
        totalTrajets === 0
          ? (conducteur
            ? 'Aucun trajet retenu par ce filtre sur la période — le classeur a écarté les autres conducteurs, la période n’est pas vide pour autant.'
            : 'Aucun trajet sur la période.')
          : 'Aucun trajet n’est imputé à un conducteur ni à un groupe.',
      ]);
      vide.font = { italic: true, color: { argb: 'FF6B7280' } };
      return;
    }

    for (const l of imputation.lignes) {
      ws.addRow([l.libelle, l.sorte, l.tripCount, round1(l.km), fmtDuration(l.durationSeconds)]);
    }

    // ⚠️ « lignes classées » et non « TOTAL » : sous ce tableau, le total du classeur, c'est
    // celui-ci PLUS les non attribués annoncés en tête. Un « TOTAL » nu se lirait comme le
    // total de la période, et manquerait 99 % des trajets chez deux sociétés sur cinq.
    const total = ws.addRow([
      'TOTAL (lignes classées)', '',
      imputation.lignes.reduce((n, l) => n + l.tripCount, 0),
      round1(imputation.lignes.reduce((n, l) => n + l.km, 0)),
      fmtDuration(imputation.lignes.reduce((n, l) => n + l.durationSeconds, 0)),
    ]);
    total.eachCell((c) => {
      c.font = { bold: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_TOTAL_FILL } };
    });
    this.applyBorders(ws, `A${ligneEnTete}:E${ws.rowCount}`);
  }

  // ---------------------------------------------------------------------------
  // Feuille « Trajets »
  // ---------------------------------------------------------------------------

  /**
   * @param plaques quand il est fourni, le classeur couvre PLUSIEURS véhicules et une
   *   colonne « Véhicule » ouvre le tableau. Sans elle, un classeur de parc serait une
   *   liste de trajets dont on ne saurait pas de qui ils sont.
   */
  private buildTrajets(wb: ExcelJS.Workbook, trips: TripRow[], plaques?: Map<string, string>): void {
    const ws = wb.addWorksheet('Trajets', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      // ⚠️ La colonne « Véhicule » n'existe QUE dans un classeur de périmètre. Dans l'export
      // d'un seul véhicule, elle répéterait la même plaque sur mille lignes.
      ...(plaques ? [{ header: 'Véhicule', key: 'veh', width: 14 }] : []),
      // Heure de PARIS, écrite en texte : une cellule Date passe à Excel un instant UTC, que
      // le tableur affiche sans fuseau — un départ à 07:30 se lisait 05:30, alors que le PDF
      // du même véhicule disait 07:30.
      { header: 'Départ (heure de Paris)', key: 'start', width: 20 },
      { header: 'Arrivée (heure de Paris)', key: 'end', width: 20 },
      { header: 'Durée', key: 'dur', width: 12 },
      { header: 'Distance (km)', key: 'km', width: 14, style: { numFmt: '#,##0.0' } },
      { header: 'V. moy (km/h)', key: 'avg', width: 14, style: { numFmt: '#,##0.0' } },
      { header: 'V. max (km/h)', key: 'max', width: 14, style: { numFmt: '#,##0.0' } },
      { header: 'Conducteur', key: 'driver', width: 22 },
      { header: 'Notes', key: 'notes', width: 40 },
    ];
    this.styleHeaderRow(ws.getRow(1));

    let sumKm = 0;
    let sumDur = 0;
    /**
     * ⚠️ ON SOMME LE BRUT, ON N'ARRONDIT QU'UNE FOIS — la convention de tout le reste du
     * fichier (`aggregate`, `buildParJour`, `imputer`), dont cette feuille était la seule
     * exception. `distanceKm` est stocké au CENTIÈME en production
     * (`Math.round(metres / 10) / 100`, cf. trips.service) : arrondir chaque ligne au
     * DIXIÈME avant de l'accumuler jetait jusqu'à 0,05 km par trajet, et toujours dans le
     * même sens. Sur un classeur plafonné à 5 000 trajets, cela faisait ~23 km d'écart
     * entre le TOTAL de cette feuille et celui des trois autres — deux totaux de
     * kilomètres contradictoires dans le même fichier, alors que la feuille « Par
     * conducteur ou groupe » invite justement le lecteur à faire l'addition (« TOTAL
     * (lignes classées) » + les non attribués annoncés en tête).
     *
     * ⚠️ ET LA CELLULE PORTE LE BRUT, PAS L'ARRONDI : c'est le format de colonne
     * (`numFmt: '#,##0.0'`) qui affiche le dixième. Y écrire `round1(km)` tout en sommant
     * le brut rouvrirait l'écart À L'INTÉRIEUR de la feuille — un simple Autosum sur la
     * colonne ne retomberait plus sur sa propre ligne TOTAL, ce qui est pire que l'écart
     * entre feuilles. Effet de bord assumé : une distance dont le centième vaut exactement
     * 5 peut désormais s'afficher 0,1 km plus bas (le tableur arrondit le double réel, que
     * `Math.round` poussait vers le haut) — du bruit d'affichage contre un total juste.
     */
    for (const t of trips) {
      const km = Math.max(0, t.distanceKm);
      const dur = Math.max(0, t.durationSeconds);
      sumKm += km;
      sumDur += dur;
      ws.addRow({
        ...(plaques ? { veh: plaques.get(t.vehicleId ?? '') ?? '' } : {}),
        start: formatFleetDateTime(t.startedAt),
        end: t.endedAt ? formatFleetDateTime(t.endedAt) : '',
        dur: fmtDuration(dur),
        km,
        avg: round1(Math.max(0, t.avgSpeed)),
        max: round1(Math.max(0, t.maxSpeed)),
        driver: t.driver ? `${t.driver.firstName} ${t.driver.lastName}` : '',
        notes: t.notes ?? '',
      });
    }

    // Ligne TOTAL.
    const totalRow = ws.addRow({
      start: 'TOTAL',
      dur: fmtDuration(sumDur),
      km: round1(sumKm),
    });
    totalRow.font = { bold: true };
    totalRow.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_TOTAL_FILL } };
    });
    (totalRow.getCell('km') as ExcelJS.Cell).numFmt = '#,##0.0';

    // Bordures sur tout le tableau (header + lignes + total).
    if (ws.rowCount >= 1) {
      this.applyBorders(ws, `A1:H${ws.rowCount}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Feuille « Par jour »
  // ---------------------------------------------------------------------------

  private buildParJour(wb: ExcelJS.Workbook, trips: TripRow[]): void {
    const ws = wb.addWorksheet('Par jour', {
      views: [{ state: 'frozen', ySplit: 1 }],
    });
    ws.columns = [
      { header: 'Date', key: 'date', width: 14 },
      { header: 'Nb trajets', key: 'count', width: 12, style: { numFmt: '#,##0' } },
      { header: 'Distance (km)', key: 'km', width: 14, style: { numFmt: '#,##0.0' } },
      { header: 'Durée', key: 'dur', width: 12 },
      { header: 'V. max (km/h)', key: 'max', width: 14, style: { numFmt: '#,##0.0' } },
    ];
    this.styleHeaderRow(ws.getRow(1));

    const byDate = new Map<string, { count: number; km: number; dur: number; max: number }>();
    for (const t of trips) {
      // Jour civil de Paris — même règle que le résumé journalier de l'écran.
      const date = parisDayKey(t.startedAt);
      const e = byDate.get(date) ?? { count: 0, km: 0, dur: 0, max: 0 };
      e.count++;
      e.km += Math.max(0, t.distanceKm);
      e.dur += Math.max(0, t.durationSeconds);
      e.max = Math.max(e.max, Math.max(0, t.maxSpeed));
      byDate.set(date, e);
    }
    // Tri chronologique des jours.
    for (const date of [...byDate.keys()].sort()) {
      const e = byDate.get(date)!;
      ws.addRow({
        date,
        count: e.count,
        km: round1(e.km),
        dur: fmtDuration(e.dur),
        max: round1(e.max),
      });
    }

    if (ws.rowCount >= 1) {
      this.applyBorders(ws, `A1:E${ws.rowCount}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Feuille « Passages station » — chaque passage DATÉ + prix du moment (matière brute
  // pour le suivi de coût réel et la future section d'auto-calcul à la pompe).
  // ---------------------------------------------------------------------------

  private buildPassagesStation(wb: ExcelJS.Workbook, fuelStops: FuelStopRow[]): void {
    const ws = wb.addWorksheet('Passages station', { views: [{ state: 'frozen', ySplit: 1 }] });
    ws.columns = [
      { header: 'Date/heure', key: 'at', width: 20, style: { numFmt: 'yyyy-mm-dd hh:mm' } },
      { header: 'Station', key: 'station', width: 24 },
      { header: 'Ville', key: 'city', width: 18 },
      { header: 'Adresse', key: 'address', width: 30 },
      { header: 'Carburant', key: 'fuel', width: 16 },
      { header: 'Prix (€/L)', key: 'price', width: 12, style: { numFmt: '#,##0.000' } },
      { header: 'Durée arrêt', key: 'dur', width: 14 },
    ];
    this.styleHeaderRow(ws.getRow(1));

    let sumPrice = 0;
    let priced = 0;
    for (const s of fuelStops) {
      if (s.unitPriceEur != null) { sumPrice += s.unitPriceEur; priced++; }
      ws.addRow({
        at: s.arrivedAt,
        station: s.station?.brand || s.station?.name || 'Station-service',
        city: s.station?.city ?? '',
        address: s.station?.address ?? '',
        fuel: s.fuelType ? fuelLabelXlsx(s.fuelType) : '',
        price: s.unitPriceEur ?? null,
        dur: fmtDuration(s.durationSec),
      });
    }
    // Ligne PRIX MOYEN constaté sur la période.
    if (priced > 0) {
      const avgRow = ws.addRow({ at: 'PRIX MOYEN', price: Math.round((sumPrice / priced) * 1000) / 1000 });
      avgRow.font = { bold: true };
      avgRow.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_TOTAL_FILL } }; });
      (avgRow.getCell('price') as ExcelJS.Cell).numFmt = '#,##0.000';
    }

    if (ws.rowCount >= 1) this.applyBorders(ws, `A1:G${ws.rowCount}`);
  }

  // ---------------------------------------------------------------------------
  // Helpers de mise en forme
  // ---------------------------------------------------------------------------

  private styleHeaderRow(row: ExcelJS.Row): void {
    row.font = { bold: true, color: { argb: COLOR_HEADER_FONT } };
    row.height = 18;
    row.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: COLOR_HEADER_FILL } };
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    });
  }

  private applyBorders(ws: ExcelJS.Worksheet, range: string): void {
    const thin: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: 'FFD1D5DB' } };
    const [start, end] = range.split(':');
    const startCell = ws.getCell(start);
    const endCell = ws.getCell(end);
    for (let r = startCell.fullAddress.row; r <= endCell.fullAddress.row; r++) {
      for (let c = startCell.fullAddress.col; c <= endCell.fullAddress.col; c++) {
        const cell = ws.getCell(r, c);
        cell.border = { top: thin, left: thin, bottom: thin, right: thin };
      }
    }
  }

  private safePlate(plate: string): string {
    // Nom de fichier sûr : alphanumérique + tirets.
    return plate.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'vehicule';
  }

  /** Jours civils de Paris, fin INCLUSE (la borne `to` est le lendemain minuit). */
  private dateSuffix(from: Date, to: Date): string {
    return `${parisDayKey(from)}_${parisDayKey(new Date(to.getTime() - 1))}`;
  }
}

// -----------------------------------------------------------------------------
// Types internes
// -----------------------------------------------------------------------------

interface TripRow {
  /** Renseigné uniquement dans un classeur de PÉRIMÈTRE (plusieurs véhicules). */
  vehicleId?: string;
  startedAt: Date;
  endedAt: Date | null;
  durationSeconds: number;
  distanceKm: number;
  maxSpeed: number;
  avgSpeed: number;
  movingSeconds: number;
  notes: string | null;
  /**
   * Conducteur du TRAJET, la clé de l'imputation (F13) — et non celui du véhicule : c'est
   * qui a conduit ce jour-là, et un même véhicule peut en changer.
   *
   * ⚠️ OPTIONNEL dans ce type, jamais dans les requêtes : les deux `findMany` le
   * sélectionnent. Il l'est parce que d'anciens jeux d'essai construisent des `TripRow` à la
   * main — et un trajet sans identifiant est alors imputé à son GROUPE, comme un trajet qui
   * n'a réellement pas de conducteur.
   */
  driverId?: string | null;
  driver: { firstName: string; lastName: string } | null;
}

/** Une ligne du classement « par conducteur ou groupe ». */
interface LigneImputation {
  libelle: string;
  sorte: 'conducteur' | 'groupe';
  tripCount: number;
  km: number;
  durationSeconds: number;
}

/**
 * Le classement, et ce qu'il ne peut pas contenir.
 *
 * ⚠️ `nonAttribue` n'est PAS une ligne du classement : on ne note pas « personne », et on ne
 * lui attribue pas non plus de kilomètres. Il est compté à part et annoncé en tête de feuille.
 */
interface Imputation {
  lignes: LigneImputation[];
  nonAttribue: { tripCount: number; km: number };
}

/** Une ligne de la feuille « Synthèse par véhicule » d'un classeur de périmètre. */
interface LigneVehicule {
  plate: string;
  modele: string;
  groupe: string;
  kpis: Kpis;
}

interface Kpis {
  tripCount: number;
  totalKm: number;
  totalDurationSeconds: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  estimatedLiters: number;
  estimatedCostEur: number;
  fuelPriceEurL: number;
  /** Nombre de passages en station sur la période. */
  fuelVisits: number;
  fuelType: string | null;
  /** Prix moyen RÉELLEMENT CONSTATÉ en station (€/L) sur la période, ou null si aucun passage capté. */
  observedPriceEurL: number | null;
  /** Coût carburant estimé au prix constaté (litres × prix constaté), ou null. */
  estimatedCostAtObservedEur: number | null;
}

interface FuelStopRow {
  arrivedAt: Date;
  durationSec: number;
  fuelType: string | null;
  unitPriceEur: number | null;
  station: { brand: string | null; name: string | null; city: string | null; address: string | null } | null;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Libellé lisible d'un carburant de l'API (gazole → « Gazole », gplc → « GPL »…). */
function fuelLabelXlsx(t: string): string {
  switch (t) {
    case 'gazole': return 'Gazole';
    case 'sp95': return 'SP95';
    case 'sp98': return 'SP98';
    case 'e10': return 'E10';
    case 'e85': return 'E85 (Superéthanol)';
    case 'gplc': return 'GPL';
    default: return t;
  }
}

/** Formate une durée en secondes vers `Xh YYmin` (ou `YYmin` si < 1h). */
function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}min`;
  return `${m}min`;
}

/** Date lisible « 24/07/2026 07:38 », heure de Paris — comme le PDF et les e-mails. */
function fmtDate(d: Date): string {
  return formatFleetDateTime(d);
}
