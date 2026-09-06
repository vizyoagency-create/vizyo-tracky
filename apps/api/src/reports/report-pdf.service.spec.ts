/**
 * LOT « dénominateurs — rapports », volet PDF.
 *
 * Le PDF est le seul document que le client relit vraiment, et il le compare à
 * celui de la semaine précédente. Le jour où deux boîtiers muets sortent du
 * dénominateur de la moyenne kilométrique, le chiffre monte : sans mention écrite,
 * la seule lecture possible côté client est « l'outil s'est mis à mentir ».
 *
 * On vérifie donc le CONTENU rendu, pas seulement que le buffer sort. Pour cela on
 * espionne `PDFDocument.prototype.text` : le PDF est compressé, son binaire n'est
 * pas greppable, alors qu'ici on capture exactement ce qui est écrit sur la page.
 */
import PDFDocument from 'pdfkit';
import { ReportPdfService } from './report-pdf.service';
import { FleetStatsReport } from './reports-stats.service';

function makeReport(overrides: Partial<FleetStatsReport> = {}): FleetStatsReport {
  return {
    fleet: { id: 'f1', name: 'Flotte test' },
    period: { from: '2026-06-01T00:00:00.000Z', to: '2026-06-30T23:59:59.000Z', days: 30 },
    vehicles: {
      total: 5,
      activeDuringPeriod: 3,
      exploited: 5,
      dormant: 0,
      withoutTracker: 0,
      dormantVehicles: [], idleVehicles: [], idleTotal: 0, hiddenByPrivacy: 0,
    },
    trips: {
      count: 12,
      totalKm: 200,
      totalDurationHours: 9,
      avgKmPerVehicle: 40,
      avgKmBasisVehicles: 5,
      avgKmBasisKm: 200,
      avgSpeedKmh: 42,
      maxSpeedKmh: 110,
    },
    alerts: { total: 0, byType: [], bySeverity: [] },
    consumption: {
      estimatedLiters: 14,
      estimatedCostEur: 25.9,
      fuelPriceEurL: 1.85,
      observedPriceEurL: null,
      estimatedCostAtObservedEur: null,
      observedSampleCount: 0, estimatedCo2Kg: 0, idleSecondsTotal: 0,
    },
    topVehicles: [],
    recentTrips: [],
    ...overrides,
  };
}

/** Parc réel : 3 exploités, 2 dormants (89 j / 52 j) — cf. incident de prod. */
const REPORT_AVEC_DORMANTS = makeReport({
  vehicles: {
    total: 5,
    activeDuringPeriod: 3,
    exploited: 3,
    dormant: 2,
    withoutTracker: 0,
    dormantVehicles: [
      { vehicleId: 'v4', plate: 'FV-941-LZ', silenceLabel: '89 j' },
      { vehicleId: 'v5', plate: 'FL-787-KV', silenceLabel: '52 j' },
    ], idleVehicles: [], idleTotal: 0, hiddenByPrivacy: 0,
  },
  trips: {
    count: 12, totalKm: 200, totalDurationHours: 9,
    avgKmPerVehicle: 60, avgKmBasisVehicles: 3, avgKmBasisKm: 180,
    avgSpeedKmh: 42, maxSpeedKmh: 110,
  },
});

/** Capture tout le texte écrit dans le document pendant `generate`. */
async function renderedText(
  report: FleetStatsReport,
  options?: Parameters<ReportPdfService['generate']>[1],
): Promise<{ text: string; buffer: Buffer }> {
  // Espionnage « callThrough » : le rendu reste réel (donc les régressions de
  // layout continuent de lever), on se contente de noter les chaînes écrites.
  const real = (PDFDocument.prototype as any).text;
  const captured: string[] = [];
  const patched = jest
    .spyOn(PDFDocument.prototype as any, 'text')
    .mockImplementation(function (this: any, ...args: any[]) {
      if (typeof args[0] === 'string') captured.push(args[0]);
      return real.apply(this, args);
    });

  try {
    const buffer = await new ReportPdfService().generate(report, options);
    return { text: captured.join('\n'), buffer };
  } finally {
    patched.mockRestore();
  }
}

describe('ReportPdfService — mention « parc exploité »', () => {
  it('écrit la mention, les plaques, l’ancienneté et la réintégration automatique', async () => {
    const { text } = await renderedText(REPORT_AVEC_DORMANTS);

    expect(text).toContain('2 véhicules sans signal boîtier depuis plus de 7 j');
    expect(text).toContain('FV-941-LZ (89 j)');
    expect(text).toContain('FL-787-KV (52 j)');
    expect(text).toContain('réintégrés dès la première trame reçue');
    expect(text).toContain('parc total inchangé : 5');
  });

  it('affiche la distance moyenne — le chiffre que la mention explique', async () => {
    const { text } = await renderedText(REPORT_AVEC_DORMANTS);

    expect(text).toContain('DISTANCE MOY./VÉHICULE');
    expect(text).toContain('60.0 km');
    // Le total contractuel du parc reste affiché tel quel (3 actifs / 5 au parc).
    expect(text).toContain('3 / 5');
  });

  it('aucune mention quand rien n’est exclu (pas de bruit permanent)', async () => {
    const { text } = await renderedText(makeReport());

    expect(text).not.toContain('sans signal boîtier');
    expect(text).not.toContain('parc exploité');
  });

  it('garde la mention même si la section KPI est décochée', async () => {
    const { text } = await renderedText(REPORT_AVEC_DORMANTS, { sections: ['trips'] });

    expect(text).toContain('sans signal boîtier depuis plus de 7 j');
    // La section KPI, elle, a bien disparu.
    expect(text).not.toContain('Indicateurs cles');
  });

  /**
   * ⚠️ L'ENCART EST LA SEULE PIÈCE RENDUE HORS DU BLOC « kpi » : un rapport dont on a
   * décoché « Indicateurs clés » le porte quand même. Sa dernière phrase énonce la base de
   * la moyenne — sous filtre conducteur, la phrase de flotte affirmait que le parc exploité
   * avait roulé les kilomètres d'UNE personne, à trois lignes du nom de cette personne.
   */
  it('sous filtre conducteur, l’encart n’attribue plus les km d’une personne au parc', async () => {
    const { text } = await renderedText(REPORT_AVEC_DORMANTS, {
      driverLabel: 'Conducteur : Sohaib Hamanni',
    });

    expect(text).toContain('jamais par le parc');
    expect(text).toContain('180.0 km sur 3 véhicules');
    // La phrase de flotte, celle qui affirmait un faux, n'est plus imprimée.
    expect(text).not.toContain('3 véhicules exploités');
    // Le reste de l'encart ne bouge pas : plaques, ancienneté, réintégration.
    expect(text).toContain('FV-941-LZ (89 j)');
  });

  it('la phrase de la base survit à une section « Indicateurs clés » décochée', async () => {
    const { text } = await renderedText(REPORT_AVEC_DORMANTS, {
      sections: ['trips'],
      driverLabel: 'Conducteur : Sohaib Hamanni',
    });

    expect(text).toContain('jamais par le parc');
    expect(text).not.toContain('DISTANCE MOY./VÉHICULE'); // la section KPI a bien sauté
  });

  it('sans filtre : l’encart dit toujours « véhicules exploités », rien ne bouge', async () => {
    const { text } = await renderedText(REPORT_AVEC_DORMANTS);

    expect(text).toContain('3 véhicules exploités');
    expect(text).toContain('parc total inchangé : 5');
    expect(text).not.toContain('jamais par le parc');
  });

  it('parc 100 % dormant : le PDF sort quand même, sans NaN à l’écran', async () => {
    const report = makeReport({
      vehicles: {
        total: 2, activeDuringPeriod: 0, exploited: 0, dormant: 2, withoutTracker: 0,
        dormantVehicles: [
          { vehicleId: 'v1', plate: 'AA-111-AA', silenceLabel: '90 j' },
          { vehicleId: 'v2', plate: 'AA-222-AA', silenceLabel: '60 j' },
        ], idleVehicles: [], idleTotal: 0, hiddenByPrivacy: 0,
      },
      trips: {
        count: 0, totalKm: 0, totalDurationHours: 0,
        avgKmPerVehicle: 0, avgKmBasisVehicles: 2, avgKmBasisKm: 0,
        avgSpeedKmh: 0, maxSpeedKmh: 0,
      },
    });

    const { text, buffer } = await renderedText(report);

    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    expect(text).toContain('Aucun véhicule exploité');
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('Infinity');
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * L'EN-TÊTE : LE TRAIT DESCEND AVEC LES LIGNES (F13)
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le périmètre VÉHICULE tenait sur une ligne posée à 116, sous un trait FIGÉ à 130. La
 * seconde ligne — le conducteur — n'avait donc nulle part où aller. `renderHeader` empile
 * désormais les mentions et repousse le trait d'autant (`Math.max(130, ligneY + 1)`).
 *
 * ⚠️ CET INVARIANT N'ÉTAIT GARDÉ QUE PAR UN COMMENTAIRE. Aucune surface de test du dépôt
 * n'observait une ordonnée : les trois espions de texte existants n'empilent que `args[0]`
 * et jettent `args[2]`, et aucun n'espionne `moveTo`. Remettre `const traitY = 130;`
 * laissait la suite ENTIÈREMENT verte — le texte écrit est identique au caractère près —
 * pendant qu'un trait vert de 1,5 pt, centré sur 130, barrait le haut des capitales du
 * texte Helvetica-Bold 9,5 pt posé à 129 : « Conducteur : Sohaib Hamanni » sortait rayé
 * d'un PDF envoyé par courriel.
 */
describe('ReportPdfService — l’en-tête : le trait descend avec les lignes', () => {
  /**
   * Le pendant géométrique de `renderedText` : celui-ci retient l'ORDONNÉE de chaque
   * chaîne, et celle de chaque trait. `renderedText` ne garde que `args[0]`.
   */
  async function renderedGeometry(
    report: FleetStatsReport,
    options?: Parameters<ReportPdfService['generate']>[1],
  ): Promise<{ yTexte: Map<string, number>; yTraits: number[] }> {
    const realText = (PDFDocument.prototype as any).text;
    const realMoveTo = (PDFDocument.prototype as any).moveTo;
    const yTexte = new Map<string, number>();
    const yTraits: number[] = [];
    const sT = jest.spyOn(PDFDocument.prototype as any, 'text')
      .mockImplementation(function (this: any, ...a: any[]) {
        if (typeof a[0] === 'string' && typeof a[2] === 'number') yTexte.set(a[0], a[2]);
        return realText.apply(this, a);
      });
    const sM = jest.spyOn(PDFDocument.prototype as any, 'moveTo')
      .mockImplementation(function (this: any, ...a: any[]) {
        yTraits.push(a[1] as number);
        return realMoveTo.apply(this, a);
      });
    try {
      await new ReportPdfService().generate(report, options);
    } finally {
      sT.mockRestore();
      sM.mockRestore();
    }
    return { yTexte, yTraits };
  }

  it('le trait passe SOUS la ligne conducteur : il ne la barre pas', async () => {
    const { yTexte, yTraits } = await renderedGeometry(makeReport(), {
      scopeLabel: '2 véhicules : AA-111-AA, BB-222-BB',
      driverLabel: 'Conducteur : Sohaib Hamanni',
    });

    // `yTraits[0]` est le trait de l'en-tête : `renderHeader` est le premier rendu du
    // document, donc le premier `moveTo`.
    // Assertion RELATIONNELLE, jamais un 144 en dur : elle survit à un changement de
    // police ou à une troisième ligne d'en-tête, et lève dès que le trait remonte dans le
    // texte. 9 pt ≈ la hauteur d'une ligne Helvetica-Bold 9,5.
    expect(yTraits[0]!).toBeGreaterThan(yTexte.get('Conducteur : Sohaib Hamanni')! + 9);
  });

  /**
   * La contre-épreuve, qui tient la promesse écrite dans `renderHeader` : « sans mention,
   * la mise en page est celle d'avant, au pixel ». Sans elle, on pourrait faire descendre
   * le trait de tous les rapports pour satisfaire l'assertion du dessus.
   */
  it('sans ligne conducteur, le trait reste à 130 — la mise en page d’avant, au pixel', async () => {
    const { yTraits } = await renderedGeometry(makeReport(), { scopeLabel: '3 véhicules sélectionnés' });

    expect(yTraits[0]).toBe(130);
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LA GRILLE D'INDICATEURS DIT D'ELLE-MÊME SOUS FILTRE CONDUCTEUR (F13)
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * Le lot avait écrit sa phrase d'exception pour les ALERTES et l'avait oubliée ici, alors
 * que deux cartes changent de sens sans changer d'apparence :
 *
 *  • « Véhicules ayant roulé : 3 / 5 » oppose un numérateur CONDUCTEUR à un dénominateur
 *    PARC — muette, la fraction se lit « 2 véhicules sont restés au garage » ;
 *  • « Distance moy./véhicule » divise désormais par les seuls véhicules du filtre : un
 *    chiffre que le client compare d'une semaine sur l'autre ne peut pas changer de base
 *    en silence.
 *
 * Et ce document n'a pas de démenti : `avgKmPerVehicle` n'est affiché nulle part ailleurs
 * (ni écran, ni Excel), il voyage par courriel et ressort d'un classeur des mois plus tard.
 */
describe('ReportPdfService — indicateurs sous filtre conducteur', () => {
  const LIBELLE = 'Conducteur : Sohaib Hamanni';

  /**
   * ⚠️ LE LIBELLÉ D'ABORD, LA PHRASE ENSUITE. Un lecteur pressé ne lit que les petites
   * capitales de la carte : « VÉHICULES AYANT ROULÉ » au-dessus de « 3 / 5 » se lit
   * « 2 véhicules sont restés au garage », et un paragraphe posé au-dessus de la grille
   * n'y change rien. Le test exige donc les DEUX, et l'ABSENCE de l'ancien intitulé.
   */
  it('renomme les deux cartes qui changent de sens, puis énonce la règle de lecture', async () => {
    const { text } = await renderedText(REPORT_AVEC_DORMANTS, { driverLabel: LIBELLE });

    // Les intitulés disent eux-mêmes ce que chaque moitié compte…
    expect(text).toContain('VÉHICULES CONDUITS / PARC');
    expect(text).toContain('DISTANCE MOY./VÉHICULE CONDUIT');
    expect(text).not.toContain('VÉHICULES AYANT ROULÉ');
    // …et la fraction, elle, ne bouge pas : le parc reste le parc.
    expect(text).toContain('3 / 5');

    // La phrase finit le travail — et elle est bien celle de la GRILLE, pas celle de
    // l'encart : les deux ouvraient sur les mêmes mots, un test l'aurait crue posée.
    expect(text).toContain('Lecture sous filtre conducteur');
    expect(text).toContain('ils ont roulé hors de ce filtre');
    expect(text).toContain('le parc total de la société');
    // La base est écrite, donc le lecteur peut refaire la division.
    expect(text).toContain('par ces 3 véhicules');
  });

  /**
   * ⚠️ LE CAS SANS ENCART EST LE PIRE, PAS LE BÉNIN. `buildExploitedScopeNotice` rend `null`
   * dès qu'aucun véhicule n'est dormant ni sans boîtier : sur une société au parc sain, la
   * carte s'imprimerait alors SANS une ligne d'explication si la mention ne tenait que dans
   * l'encart. Elle doit tenir dans la grille elle-même.
   */
  it('parc sain : la règle de lecture tient sans l’encart pour la porter', async () => {
    const { text } = await renderedText(makeReport(), { driverLabel: LIBELLE });

    expect(text).not.toContain('sans signal boîtier'); // l'encart n'est pas rendu
    expect(text).toContain('Lecture sous filtre conducteur');
    expect(text).toContain('par ces 5 véhicules');
    expect(text).toContain('VÉHICULES CONDUITS / PARC');
  });

  /**
   * Un conducteur qui n'a pas roulé du mois (congés, arrêt) vide la base : `basis === 0`.
   * Le document ne doit pas imprimer une division par zéro mise en forme — ni dans la
   * grille, ni dans l'encart, qui écrivent tous deux la base.
   */
  it('conducteur sans un seul trajet : aucune division par zéro imprimée', async () => {
    const rapport = makeReport({
      vehicles: { ...REPORT_AVEC_DORMANTS.vehicles, activeDuringPeriod: 0 },
      trips: {
        count: 0, totalKm: 0, totalDurationHours: 0,
        avgKmPerVehicle: 0, avgKmBasisVehicles: 0, avgKmBasisKm: 0,
        avgSpeedKmh: 0, maxSpeedKmh: 0,
      },
    });
    const { text } = await renderedText(rapport, { driverLabel: LIBELLE });

    expect(text).toContain('Lecture sous filtre conducteur');
    expect(text).toContain('n’a pas de base et vaut 0');
    expect(text).toContain('aucun trajet retenu par ce filtre sur la période');
    // Ni « par ces 0 véhicules » dans la grille, ni « 0.0 km sur 0 véhicule » dans l'encart.
    expect(text).not.toContain('par ces 0');
    expect(text).not.toContain('sur 0 véhicule');
  });

  it('sans filtre : libellés et grille inchangés, aucune règle de lecture', async () => {
    const { text } = await renderedText(REPORT_AVEC_DORMANTS);

    // Les intitulés d'origine, au pixel : ce PDF part chaque semaine sans filtre.
    expect(text).toContain('VÉHICULES AYANT ROULÉ');
    expect(text).toContain('DISTANCE MOY./VÉHICULE');
    expect(text).not.toContain('CONDUITS / PARC');
    expect(text).not.toContain('VÉHICULE CONDUIT');
    expect(text).not.toContain('Lecture sous filtre conducteur');
    expect(text).not.toContain('hors de ce filtre');
  });

  /**
   * ── LE PRIX CONSTATÉ EN STATION : GARDÉ, MAIS DIT ────────────────────────────────────
   *
   * `TripFuelStop` n'a pas de conducteur : ce prix et ce compte portent sur le périmètre
   * VÉHICULE. Le classeur Excel les RETIRE et l'annonce ; le PDF les GARDE — un prix de
   * station est un fait de marché — mais « 12 passages station » est un dénombrement
   * d'événements imprimé sous un nom propre. Muet, il s'attribuait tout seul à la personne
   * nommée en tête de page ; le silence se lisait « celui-ci, si, il suit le filtre ».
   */
  const REPORT_PRIX_STATION = makeReport({
    consumption: {
      estimatedLiters: 14, estimatedCostEur: 25.9, fuelPriceEurL: 1.85,
      observedPriceEurL: 1.842, estimatedCostAtObservedEur: 25.79,
      observedSampleCount: 12, estimatedCo2Kg: 0, idleSecondsTotal: 0,
    },
  });

  it('dit que les passages en station ne suivent pas le filtre — et garde le chiffre', async () => {
    const { text } = await renderedText(REPORT_PRIX_STATION, { driverLabel: LIBELLE });

    // Le chiffre reste : c'est une décision, pas un oubli — et elle est écrite.
    expect(text).toContain('12 passages station');
    expect(text).toContain('Les passages en station sont des arrêts du véhicule');
    expect(text).toContain('ne suivent pas le filtre conducteur');
    // La part qui, elle, SUIT le filtre est nommée : sinon « Coût au prix constaté »
    // (litres filtrés × prix du parc) reste un hybride que rien n'explique.
    expect(text).toContain('Seuls les litres valorisés le suivent');
  });

  it('sans filtre : la ligne du prix constaté est là, sans mention de périmètre', async () => {
    const { text } = await renderedText(REPORT_PRIX_STATION);

    expect(text).toContain('12 passages station');
    expect(text).not.toContain('Les passages en station sont des arrêts');
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LE BLOC « PAR CONDUCTEUR OU GROUPE » — LE DERNIER TROU DE F13
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'écran le rend depuis le 5 septembre, le PDF non : « le client voit à l'écran ce que son
 * PDF ne dit pas ». Et c'est le PDF qui part par courriel chaque lundi, puis ressort d'un
 * classeur des mois plus tard, sans écran pour le compléter.
 *
 * Ces tests tiennent les trois façons de le rendre FAUX :
 *   1. taire les trajets non attribués — 99 % de la population chez deux sociétés sur cinq ;
 *   2. les rapporter au total des seules lignes classées (« 1 866 sur 12 ») ;
 *   3. imprimer sous filtre un classement d'une ligne comme s'il décrivait la société.
 */
describe('ReportPdfService — récapitulatif par conducteur ou groupe', () => {
  type Ligne = NonNullable<FleetStatsReport['byAttribution']>[number];

  const ligne = (o: Partial<Ligne> & Pick<Ligne, 'key' | 'label' | 'kind'>): Ligne => ({
    tripCount: 10, distanceKm: 100, durationHours: 4, avgSpeedKmh: 25,
    speedingCount: 0, speedingTripCount: 0, worstOverKmh: 0, idleSeconds: 0,
    ...o,
  });

  /**
   * cdef31, mesuré le 2026-09-05 : des GROUPES qui roulent, un conducteur nommé, et
   * 32 trajets sur 2 707 que rien ne rattache à personne. C'est le cas qui a piégé l'écran.
   */
  const RAPPORT_CDEF31 = makeReport({
    trips: {
      count: 2707, totalKm: 24704.4, totalDurationHours: 900,
      avgKmPerVehicle: 500, avgKmBasisVehicles: 49, avgKmBasisKm: 24500,
      avgSpeedKmh: 27, maxSpeedKmh: 131,
    },
    byAttribution: [
      ligne({ key: 'group:g1', label: '425', kind: 'group', tripCount: 620, distanceKm: 6119.4, durationHours: 212.5, speedingCount: 41, speedingTripCount: 33, worstOverKmh: 38.4 }),
      ligne({ key: 'group:g2', label: 'BOREAL', kind: 'group', tripCount: 289, distanceKm: 2810.2, durationHours: 96.5 }),
      ligne({ key: 'driver:d1', label: 'Sohaib Hamanni', kind: 'driver', tripCount: 22, distanceKm: 310.5, durationHours: 11.5, speedingCount: 3, speedingTripCount: 2, worstOverKmh: 12.6 }),
    ],
    byAttributionTotal: 15,
    unattributedTrips: { tripCount: 32, distanceKm: 214.7, durationHours: 9.5 },
  });

  it('rend le classement, la sorte de chaque ligne et les excès établis', async () => {
    const { text } = await renderedText(RAPPORT_CDEF31);

    expect(text).toContain('Par conducteur ou groupe');
    expect(text).toContain('CONDUCTEUR OU GROUPE');
    // Le sous-libellé n'est pas décoratif : sans lui, « 425 » et « Sohaib Hamanni » se
    // lisent comme deux personnes.
    expect(text).toContain('BOREAL');
    expect(text).toContain('groupe');
    expect(text).toContain('Sohaib Hamanni');
    expect(text).toContain('conducteur');
    // Les chiffres de la ligne, aux arrondis de l'écran.
    expect(text).toContain('6119.4 km');
    expect(text).toContain('620');
    // Excès ÉTABLIS + pire dépassement, comme la vue par véhicule.
    expect(text).toContain('41 (+38 km/h)');
    // La règle d'imputation est écrite : un lecteur doit savoir d'où sort chaque ligne.
    expect(text).toContain('sinon pour le groupe de son véhicule');
  });

  /**
   * ⚠️ LE PIÈGE PAYÉ PAR L'ÉCRAN. Une première version n'affichait l'encart QUE si le
   * classement était vide : chez cdef31, quinze groupes classés l'auraient masqué, et le
   * gestionnaire aurait cru lire une image complète.
   */
  it('rend l’encart « non attribué » MÊME avec un classement plein', async () => {
    const { text } = await renderedText(RAPPORT_CDEF31);

    expect(text).toContain('32 trajets sur 2707 de la période');
    expect(text).toContain('ni conducteur, ni groupe');
    expect(text).toContain('Renseignez un conducteur ou un groupe');
  });

  /**
   * mh cars, mesuré le 2026-09-05 : trois conducteurs nommés totalisant 51 trajets, et
   * 1 866 trajets sur 1 886 qui n'ont NI conducteur NI groupe.
   *
   * ⚠️ LE DÉNOMINATEUR EST LE TOTAL RÉEL DE LA PÉRIODE. Rapporté aux seules lignes classées,
   * l'encart aurait annoncé « 1 866 sur 51 » — un chiffre absurde, mais imprimé.
   */
  it('rapporte les non attribués au total RÉEL, jamais aux lignes classées', async () => {
    const { text } = await renderedText(makeReport({
      trips: {
        count: 1886, totalKm: 12000, totalDurationHours: 400,
        avgKmPerVehicle: 300, avgKmBasisVehicles: 40, avgKmBasisKm: 12000,
        avgSpeedKmh: 30, maxSpeedKmh: 120,
      },
      byAttribution: [
        ligne({ key: 'driver:d1', label: 'Sohaib Hamanni', kind: 'driver', tripCount: 22, distanceKm: 240 }),
        ligne({ key: 'driver:d2', label: 'Nael Mhamdi', kind: 'driver', tripCount: 17, distanceKm: 180 }),
        ligne({ key: 'driver:d3', label: 'Hamza Ayachi', kind: 'driver', tripCount: 12, distanceKm: 120 }),
      ],
      byAttributionTotal: 3,
      unattributedTrips: { tripCount: 1866, distanceKm: 11460, durationHours: 380 },
    }));

    expect(text).toContain('1866 trajets sur 1886 de la période');
    expect(text).toContain('99 %');
    // La somme des lignes classées (51 trajets) ne peut pas servir de dénominateur.
    expect(text).not.toContain('sur 51');
  });

  /**
   * Le cas le plus fréquent en production, et le seul que l'ancien PDF aurait rendu
   * honnêtement par accident : aucune ligne classée du tout. L'encart doit rester, et la
   * phrase de vide doit dire que c'est la PÉRIODE qui n'impute rien.
   */
  it('classement vide : le document le dit, et compte quand même les non attribués', async () => {
    const { text } = await renderedText(makeReport({
      trips: {
        count: 725, totalKm: 5200, totalDurationHours: 180,
        avgKmPerVehicle: 200, avgKmBasisVehicles: 26, avgKmBasisKm: 5200,
        avgSpeedKmh: 28, maxSpeedKmh: 118,
      },
      byAttribution: [],
      byAttributionTotal: 0,
      unattributedTrips: { tripCount: 725, distanceKm: 5200, durationHours: 180 },
    }));

    expect(text).toContain('Aucun trajet de la période n’est imputé à un conducteur ni à un groupe.');
    expect(text).toContain('725 trajets sur 725 de la période');
    expect(text).toContain('100 %');
    // Aucun tableau vide : ni en-tête de colonnes, ni ligne fantôme.
    expect(text).not.toContain('CONDUCTEUR OU GROUPE');
  });

  /**
   * ⚠️ LE CHAMP EST OPTIONNEL DANS LE CONTRAT. Un producteur qui ne le fabrique pas doit
   * rendre un document MUET — jamais un classement vide, qui se lirait « personne n'a roulé ».
   */
  it('rapport sans imputation servie : aucune section, aucun zéro inventé', async () => {
    const { text } = await renderedText(makeReport());

    expect(text).not.toContain('Par conducteur ou groupe');
    expect(text).not.toContain('ni conducteur, ni groupe');
  });

  /** Société sans un seul trajet (« Envoyer maintenant » sur une société d'essai). */
  it('aucun trajet : pas de section, pas d’encart à zéro', async () => {
    const { text } = await renderedText(makeReport({
      trips: {
        count: 0, totalKm: 0, totalDurationHours: 0,
        avgKmPerVehicle: 0, avgKmBasisVehicles: 5, avgKmBasisKm: 0,
        avgSpeedKmh: 0, maxSpeedKmh: 0,
      },
      byAttribution: [],
      byAttributionTotal: 0,
      unattributedTrips: { tripCount: 0, distanceKm: 0, durationHours: 0 },
    }));

    expect(text).not.toContain('Par conducteur ou groupe');
    expect(text).not.toContain('ni conducteur, ni groupe');
  });

  /**
   * ⚠️ SOUS FILTRE, LE CLASSEMENT SE RÉDUIT PAR CONSTRUCTION. Une seule ligne imprimée sans
   * contexte se lit « il n'y a qu'une personne qui roule dans cette société » — la même faute
   * que le lot a fermée pour les alertes et pour les passages en station.
   */
  it('sous filtre conducteur, écrit pourquoi le classement tient sur une ligne', async () => {
    const { text } = await renderedText(makeReport({
      trips: {
        count: 22, totalKm: 310.5, totalDurationHours: 11.5,
        avgKmPerVehicle: 155, avgKmBasisVehicles: 2, avgKmBasisKm: 310.5,
        avgSpeedKmh: 27, maxSpeedKmh: 118,
      },
      byAttribution: [ligne({ key: 'driver:d1', label: 'Sohaib Hamanni', kind: 'driver', tripCount: 22, distanceKm: 310.5 })],
      byAttributionTotal: 1,
      unattributedTrips: { tripCount: 0, distanceKm: 0, durationHours: 0 },
    }), { driverLabel: 'Conducteur : Sohaib Hamanni' });

    expect(text).toContain('ce classement ne porte que sur les trajets retenus');
    expect(text).toContain('ce n’est pas le classement de la société');
  });

  /**
   * Sous filtre, le dénominateur de l'encart a lui aussi été filtré : l'annoncer « de la
   * période » ferait passer une population bornée pour la société entière. Le cas réel est
   * le filtre « sans conducteur », où l'encart reste plein.
   */
  it('sous filtre, l’encart annonce un dénominateur filtré, jamais « de la période »', async () => {
    const { text } = await renderedText(makeReport({
      trips: {
        count: 1905, totalKm: 12000, totalDurationHours: 400,
        avgKmPerVehicle: 300, avgKmBasisVehicles: 40, avgKmBasisKm: 12000,
        avgSpeedKmh: 30, maxSpeedKmh: 120,
      },
      byAttribution: [ligne({ key: 'group:g1', label: 'Atelier', kind: 'group', tripCount: 39, distanceKm: 400 })],
      byAttributionTotal: 1,
      unattributedTrips: { tripCount: 1866, distanceKm: 11460, durationHours: 380 },
    }), { driverLabel: 'Trajets sans conducteur (filtre « none »)' });

    expect(text).toContain('1866 trajets sur 1905 retenus par ce filtre');
    expect(text).not.toContain('sur 1905 de la période');
  });

  it('la troncature se dit : dix lignes affichées sur quarante', async () => {
    const lignes = Array.from({ length: 10 }, (_, i) =>
      ligne({ key: `group:g${i}`, label: `Groupe ${i}`, kind: 'group', distanceKm: 1000 - i }));
    const { text } = await renderedText(makeReport({
      byAttribution: lignes,
      byAttributionTotal: 40,
      unattributedTrips: { tripCount: 0, distanceKm: 0, durationHours: 0 },
    }));

    expect(text).toContain('10 lignes affichées sur 40');
  });

  /**
   * ⚠️ LA COUPE DU LIBELLÉ, MESURÉE — pas la présence d'une ellipse.
   *
   * `tronquerA` n'a qu'un seul appelant, ce bloc, et rien en amont ne borne la longueur :
   * `VehicleGroup.name` est un `String` nu au schéma, `CreateVehicleGroupDto` n'a pas de
   * `@MaxLength`, et un libellé de conducteur vaut `firstName lastName`, soit 80 + 80.
   * Sans la coupe, le nom est écrit avec `lineBreak: false` et passe PAR-DESSUS les
   * kilomètres de SA PROPRE LIGNE : mesuré, il finit à 265,98 pt et sa sorte à 296,80 pt
   * pour une colonne DISTANCE qui commence à 255. Le PDF sort quand même — il est
   * simplement illisible sur cette rangée, dans un document envoyé par courriel.
   *
   * ⚠️ Et ce n'est PAS `{ ellipsis: true }` de PDFKit qui protège : vérifié dans son
   * source, l'ellipse n'est posée que sur un débordement VERTICAL. Sur une largeur, elle
   * ne coupe rien.
   *
   * L'abscisse de la colonne n'est pas recopiée en dur : elle est LUE sur l'en-tête que
   * le bloc vient d'écrire (`DISTANCE` est posé à `colX.dist`), pour que le test suive
   * une refonte de la grille au lieu de la contredire.
   */
  it('coupe un libellé trop long AVANT la colonne DISTANCE, sorte comprise', async () => {
    const LONG = 'Groupe très long qui déborde de la colonne voisine';
    const ecrits: { s: string; x: number; fin: number }[] = [];
    const real = (PDFDocument.prototype as any).text;
    const spy = jest.spyOn(PDFDocument.prototype as any, 'text')
      .mockImplementation(function (this: any, ...a: any[]) {
        // `fin` se mesure AVEC LA POLICE COURANTE, donc à l'instant exact de l'écriture :
        // le nom est en Helvetica 10, la sorte accolée en Helvetica 8.
        if (typeof a[0] === 'string' && typeof a[1] === 'number') {
          ecrits.push({ s: a[0], x: a[1], fin: a[1] + this.widthOfString(a[0]) });
        }
        return real.apply(this, a);
      });
    try {
      await new ReportPdfService().generate(makeReport({
        byAttribution: [ligne({ key: 'group:g1', label: LONG, kind: 'group', distanceKm: 6119.4 })],
        byAttributionTotal: 1,
      }));
    } finally {
      spy.mockRestore();
    }

    const iEnTete = ecrits.findIndex((e) => e.s === 'CONDUCTEUR OU GROUPE');
    expect(iEnTete).toBeGreaterThanOrEqual(0);
    const colDist = ecrits.slice(iEnTete).find((e) => e.s === 'DISTANCE')!.x;

    const iNom = ecrits.findIndex((e) => e.s.startsWith('Groupe très long'));
    expect(iNom).toBeGreaterThanOrEqual(0);
    const nom = ecrits[iNom]!;
    const sorte = ecrits[iNom + 1]!;

    expect(nom.s).not.toBe(LONG);
    expect(nom.s.endsWith('…')).toBe(true);

    // Le fait qui compte : ni le nom, ni la sorte posée à sa suite n'entrent dans la
    // colonne DISTANCE — sinon le libellé s'imprime par-dessus les km de sa propre ligne.
    expect(sorte.s).toBe('groupe');
    expect(nom.fin).toBeLessThan(colDist);
    expect(sorte.fin).toBeLessThan(colDist);
  });

  /**
   * Le bloc est la SECONDE FACE de la carte « récapitulatif » de l'écran : il suit donc la
   * section « Top véhicules ». Un cinquième identifiant de section n'aurait atteint aucun
   * lecteur — la modale poste la liste explicite des quatre sections qu'elle connaît, et le
   * rapport hebdomadaire filtre la sienne sur le contrat partagé.
   */
  it('suit la section « Top véhicules » : présent avec elle, absent sans elle', async () => {
    const avec = await renderedText(RAPPORT_CDEF31, { sections: ['topVehicles'] });
    expect(avec.text).toContain('Par conducteur ou groupe');

    const sans = await renderedText(RAPPORT_CDEF31, { sections: ['kpi'] });
    expect(sans.text).not.toContain('Par conducteur ou groupe');
  });

  /**
   * ⚠️ MAIS L'ENCART, LUI, NE SUIT PAS LA SECTION. Le classement est la seconde face de la
   * carte « Top véhicules » ; l'encart des non attribués est le contre-poids qui empêche de
   * lire le document comme complet. Une société qui règle son rapport hebdomadaire sur
   * ['kpi','alerts','trips'] — la route l'accepte — recevait un courriel qui écrit
   * « … n'ont ni conducteur, ni groupe » et une pièce jointe qui n'en disait pas un mot.
   * C'est la pièce jointe qu'on classe et qu'on relit six mois plus tard.
   *
   * Ses mots sont ceux de l'encart et de personne d'autre : « 32 trajets sur 2707 de la
   * période » n'apparaît nulle part ailleurs dans le document.
   */
  it('l’encart « non attribué » survit au décochage de « Top véhicules »', async () => {
    const { text } = await renderedText(RAPPORT_CDEF31, { sections: ['kpi', 'alerts', 'trips'] });

    // Le classement, lui, est bien parti : le couplage assumé n'est pas défait.
    expect(text).not.toContain('CONDUCTEUR OU GROUPE');
    expect(text).not.toContain('Par conducteur ou groupe');
    // Le fait, lui, reste imprimé.
    expect(text).toContain('32 trajets sur 2707 de la période');
    expect(text).toContain('ni conducteur, ni groupe');
  });

  /**
   * ⚠️ La profondeur demandée vaut pour les DEUX vues : un `topN` de 2 ne peut pas rendre
   * dix lignes d'imputation sous un top véhicules de deux.
   */
  it('respecte le plafond « topN » demandé par le rapport', async () => {
    const { text } = await renderedText(RAPPORT_CDEF31, { topN: 2 });

    expect(text).toContain('BOREAL');
    expect(text).not.toContain('Sohaib Hamanni');
    expect(text).toContain('2 lignes affichées sur 15');
  });
});

/**
 * ════════════════════════════════════════════════════════════════════════════════════════
 * LES DEUX DERNIÈRES SECTIONS QUI COMPTAIENT SANS LE DIRE (F13)
 * ════════════════════════════════════════════════════════════════════════════════════════
 *
 * La grille d'indicateurs, l'encart du parc, les alertes, les passages en station et le
 * récapitulatif par imputation disent tous, désormais, sur quelle population ils portent.
 * « Top véhicules » et « Trajets récents », non — alors qu'ils se réduisent exactement de la
 * même façon : sous « Conducteur : Sohaib Hamanni », le palmarès ne porte que SES kilomètres
 * et la liste que SES trajets. Un lecteur ne peut pas savoir s'il lit le parc ou une personne.
 *
 * ⚠️ CHAQUE MENTION A SES PROPRES MOTS, ET C'EST UNE EXIGENCE DE TEST, pas de style. Le lot
 * précédent a laissé passer une assertion morte parce que deux phrases ouvraient pareil : le
 * test de l'une était satisfait par l'autre. Les fragments exigés ici (« palmarès du parc »,
 * « derniers trajets de la société ») n'existent nulle part ailleurs dans le document.
 */
describe('ReportPdfService — top véhicules et trajets récents sous filtre conducteur', () => {
  const LIBELLE = 'Conducteur : Sohaib Hamanni';

  /** Deux véhicules conduits par la personne filtrée, et deux de ses trajets. */
  const RAPPORT_AVEC_LISTES = makeReport({
    trips: {
      count: 22, totalKm: 310.5, totalDurationHours: 11.5,
      avgKmPerVehicle: 155, avgKmBasisVehicles: 2, avgKmBasisKm: 310.5,
      avgSpeedKmh: 27, maxSpeedKmh: 118,
    },
    topVehicles: [
      {
        vehicleId: 'v1', plate: 'AB-123-CD', distanceKm: 210.5, tripCount: 14,
        estimatedConsumptionL: 14.7, group: null, durationHours: 7.5, avgSpeedKmh: 28,
        speedingCount: 1, speedingTripCount: 1, worstOverKmh: 9.2, idleSeconds: 400,
      },
      {
        vehicleId: 'v2', plate: 'EF-456-GH', distanceKm: 100, tripCount: 8,
        estimatedConsumptionL: 7, group: null, durationHours: 4, avgSpeedKmh: 25,
        speedingCount: 0, speedingTripCount: 0, worstOverKmh: 0, idleSeconds: 0,
      },
    ] as unknown as FleetStatsReport['topVehicles'],
    recentTrips: [
      {
        id: 't1', vehicleId: 'v1', plate: 'AB-123-CD', startedAt: '2026-06-20T08:00:00.000Z',
        endedAt: '2026-06-20T08:30:00.000Z', durationSeconds: 1800, distanceKm: 12.4,
        driverName: 'Sohaib Hamanni', notes: null,
      },
      {
        id: 't2', vehicleId: 'v2', plate: 'EF-456-GH', startedAt: '2026-06-19T08:00:00.000Z',
        endedAt: '2026-06-19T08:40:00.000Z', durationSeconds: 2400, distanceKm: 20.1,
        driverName: 'Sohaib Hamanni', notes: null,
      },
    ] as unknown as FleetStatsReport['recentTrips'],
  });

  /**
   * ⚠️ « UN VÉHICULE QUI N'Y FIGURE PAS A PU ROULER POUR QUELQU'UN D'AUTRE » est le cœur de
   * la phrase : sans elle, l'absence d'un véhicule du palmarès se lit « il est resté au
   * garage » — la lecture que l'encart du parc, qui nomme les plaques dormantes, pousse
   * activement. Deux affirmations opposées sur la même page.
   */
  it('le palmarès dit qu’il ne compte que les trajets du filtre', async () => {
    const { text } = await renderedText(RAPPORT_AVEC_LISTES, { driverLabel: LIBELLE });

    expect(text).toContain('Top véhicules (km parcourus)');
    expect(text).toContain('ce palmarès ne compte que les trajets retenus');
    expect(text).toContain('a pu rouler pour quelqu’un d’autre');
    expect(text).toContain('ce n’est pas le palmarès du parc');
    // Les chiffres, eux, ne bougent pas : on situe la population, on ne la corrige pas.
    expect(text).toContain('210.5 km');
  });

  it('la liste des trajets dit qu’elle n’est pas celle de la société', async () => {
    const { text } = await renderedText(RAPPORT_AVEC_LISTES, { driverLabel: LIBELLE });

    expect(text).toContain('Trajets récents');
    expect(text).toContain('cette liste ne montre que les trajets retenus');
    expect(text).toContain('ce ne sont pas les derniers trajets de la société');
  });

  /**
   * Le compte entre parenthèses (« sur 22 au total ») est LUI AUSSI filtré, et la phrase le
   * nomme — mais seulement quand il est écrit. Le nommer alors qu'il est absent enverrait le
   * lecteur chercher un chiffre qui n'est pas sur la page.
   */
  it('ne renvoie au total entre parenthèses que lorsqu’il est écrit', async () => {
    const avecTotal = await renderedText(RAPPORT_AVEC_LISTES, { driverLabel: LIBELLE, maxTrips: 1 });
    expect(avecTotal.text).toContain('(sur 22 au total)');
    expect(avecTotal.text).toContain('le total entre parenthèses est celui de ce seul périmètre');

    // Tous les trajets de la période tiennent dans la liste : plus de parenthèse…
    const sansTotal = await renderedText(makeReport({
      trips: {
        count: 2, totalKm: 32.5, totalDurationHours: 1.2,
        avgKmPerVehicle: 16, avgKmBasisVehicles: 2, avgKmBasisKm: 32.5,
        avgSpeedKmh: 27, maxSpeedKmh: 90,
      },
      recentTrips: RAPPORT_AVEC_LISTES.recentTrips,
    }), { driverLabel: LIBELLE });
    expect(sansTotal.text).not.toContain('au total)');
    expect(sansTotal.text).not.toContain('le total entre parenthèses');
    // …mais la phrase reste, amputée de sa seule clause devenue fausse.
    expect(sansTotal.text).toContain('ce ne sont pas les derniers trajets de la société');
  });

  /**
   * Le rapport hebdomadaire part sans filtre à toutes les sociétés : ces deux sections
   * doivent rester au mot ce qu'elles étaient.
   */
  it('sans filtre : ni l’une ni l’autre mention', async () => {
    const { text } = await renderedText(RAPPORT_AVEC_LISTES);

    expect(text).toContain('Top véhicules (km parcourus)');
    expect(text).toContain('Trajets récents');
    expect(text).not.toContain('palmarès');
    expect(text).not.toContain('derniers trajets de la société');
    expect(text).not.toContain('Lecture sous filtre conducteur');
  });
});

/**
 * ⚠️ LA RÈGLE D'ARRONDI VIENT DU CONTRAT PARTAGÉ, PLUS D'UNE COPIE LOCALE.
 *
 * Le PDF, la page Rapports et l'écran des scores écrivent la même mention sur les MÊMES
 * trajets, et le gestionnaire les lit côte à côte : « 99 % » ici contre « 100 % » là-bas se
 * lit comme une erreur de calcul, pas comme une nuance d'arrondi. Les extrêmes sont les deux
 * cas à tenir — ce sont les seuls que l'arrondi peut retourner en mensonge.
 */
describe('ReportPdfService — la part des non attribués suit la règle du contrat partagé', () => {
  const encart = (tripCount: number, count: number) => makeReport({
    trips: {
      count, totalKm: 12000, totalDurationHours: 400,
      avgKmPerVehicle: 300, avgKmBasisVehicles: 40, avgKmBasisKm: 12000,
      avgSpeedKmh: 30, maxSpeedKmh: 120,
    },
    byAttribution: [],
    byAttributionTotal: 0,
    unattributedTrips: { tripCount, distanceKm: 11.4, durationHours: 1 },
  });

  it('un trajet sur mille n’est pas « 0 % » : le document écrit « < 1 % »', async () => {
    const { text } = await renderedText(encart(1, 1000));

    expect(text).toContain('1 trajet sur 1000 de la période');
    expect(text).toContain('< 1 %');
    expect(text).not.toContain('(0 %,');
  });

  it('999 trajets sur mille ne sont pas « 100 % » : le document écrit « > 99 % »', async () => {
    const { text } = await renderedText(encart(999, 1000));

    expect(text).toContain('> 99 %');
    expect(text).not.toContain('(100 %,');
  });
});
