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
      dormantVehicles: [],
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
      observedSampleCount: 0, estimatedCo2Kg: 0,
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
    ],
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

  it('parc 100 % dormant : le PDF sort quand même, sans NaN à l’écran', async () => {
    const report = makeReport({
      vehicles: {
        total: 2, activeDuringPeriod: 0, exploited: 0, dormant: 2, withoutTracker: 0,
        dormantVehicles: [
          { vehicleId: 'v1', plate: 'AA-111-AA', silenceLabel: '90 j' },
          { vehicleId: 'v2', plate: 'AA-222-AA', silenceLabel: '60 j' },
        ],
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
