import { existsSync } from 'node:fs';
import PDFDocument from 'pdfkit';
import { CHEMIN_LOGO, ReportPdfService } from './report-pdf.service';
import { FleetStatsReport } from './reports-stats.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LA MISE EN PAGE DU RAPPORT — CE QUE LE CLIENT REÇOIT VRAIMENT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Les suites existantes vérifient ce que le PDF ÉCRIT (les mentions, les dénominateurs, les
 * excès) en espionnant `text()`. Elles ne pouvaient donc rien voir de ce fichier-ci : un
 * document de trois pages dont deux sont blanches écrit exactement le même texte qu'un
 * document d'une page.
 *
 * C'est pourtant ce qui partait chez les clients. On lit ici le BUFFER.
 */

function makeReport(overrides: Partial<FleetStatsReport> = {}): FleetStatsReport {
  return {
    fleet: { id: 'f1', name: 'Flotte test' },
    period: { from: '2026-08-30T22:00:00.000Z', to: '2026-09-06T22:00:00.000Z', days: 7 },
    vehicles: {
      total: 2, activeDuringPeriod: 0, exploited: 0, dormant: 0, withoutTracker: 0,
      dormantVehicles: [], idleVehicles: [], idleTotal: 0, hiddenByPrivacy: 0,
    },
    trips: {
      count: 0, totalKm: 0, totalDurationHours: 0, avgKmPerVehicle: 0,
      avgKmBasisVehicles: 2, avgKmBasisKm: 0, avgSpeedKmh: 0, maxSpeedKmh: 0,
      speedingCount: 0, worstOverKmh: 0,
    },
    alerts: { total: 0, byType: [], bySeverity: [] },
    consumption: {
      estimatedLiters: 0, estimatedCostEur: 0, fuelPriceEurL: 1.85, observedPriceEurL: null,
      estimatedCostAtObservedEur: null, observedSampleCount: 0, estimatedCo2Kg: 0, idleSecondsTotal: 0,
    },
    topVehicles: [],
    recentTrips: [],
    ...overrides,
  };
}

/** Un rapport dont le tableau des trajets déborde forcément sur une seconde page. */
const REPORT_LONG = makeReport({
  trips: {
    count: 400, totalKm: 8000, totalDurationHours: 160, avgKmPerVehicle: 4000,
    avgKmBasisVehicles: 2, avgKmBasisKm: 8000, avgSpeedKmh: 50, maxSpeedKmh: 130,
    speedingCount: 12, worstOverKmh: 28,
  },
  recentTrips: Array.from({ length: 45 }, (_, i) => ({
    id: `t${i}`, plate: 'AB-123-CD',
    startedAt: '2026-09-01T07:10:00.000Z', endedAt: '2026-09-01T08:10:00.000Z',
    durationSeconds: 3600, distanceKm: 42.5, notes: null, driverName: null, group: null,
  })),
});

/** Le nombre de pages RÉEL du document, lu dans le PDF et non dans nos intentions. */
function nombreDePages(buffer: Buffer): number {
  return (buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;
}

/** Le document embarque-t-il au moins une image ? */
function contientUneImage(buffer: Buffer): boolean {
  return buffer.toString('latin1').includes('/Subtype /Image');
}

/** Capture le texte écrit, comme les autres suites PDF, et rend aussi le buffer. */
async function rendu(
  report: FleetStatsReport,
  options?: Parameters<ReportPdfService['generate']>[1],
): Promise<{ text: string; buffer: Buffer }> {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const real = (PDFDocument.prototype as any).text;
  const captured: string[] = [];
  const patched = jest.spyOn(PDFDocument.prototype as any, 'text')
    .mockImplementation(function (this: any, ...args: any[]) {
      if (typeof args[0] === 'string') captured.push(args[0]);
      return real.apply(this, args);
    });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  try {
    const buffer = await new ReportPdfService().generate(report, options);
    return { text: captured.join('\n'), buffer };
  } finally {
    patched.mockRestore();
  }
}

describe('PDF — le pied de page ne fabrique plus les pages blanches', () => {
  /**
   * 🔴 LE TEST DE RÉGRESSION. Un rapport d'une page sortait en TROIS : la première portait le
   * contenu et aucun pied de page, la deuxième la seule mention « Généré automatiquement », la
   * troisième le seul « Page 1 / 1 ».
   *
   * La cause n'était pas le retour à la ligne — `lineBreak: false` était déjà là — mais la
   * MARGE BASSE : PDFKit ouvre une page dès qu'un texte commence sous `height - margins.bottom`.
   * Chaque `.text()` du pied de page ouvrait donc la sienne.
   */
  it('un rapport court tient sur UNE page', async () => {
    const { buffer } = await rendu(makeReport());

    expect(nombreDePages(buffer)).toBe(1);
  });

  it('un rapport long garde ses pages de CONTENU, sans en ajouter de vides', async () => {
    const { buffer } = await rendu(REPORT_LONG);
    const pages = nombreDePages(buffer);

    // Le tableau des trajets déborde : deux pages de contenu sont attendues, pas quatre.
    expect(pages).toBeGreaterThan(1);
    expect(pages).toBeLessThanOrEqual(3);
  });

  /**
   * ⚠️ LE PIED DE PAGE N'ÉTAIT SUR AUCUNE PAGE DE CONTENU. Il s'écrivait sur les pages qu'il
   * venait de créer — donc jamais sur celle qu'on lit.
   */
  it('la mention et le numéro sont écrits une fois par page', async () => {
    const { text, buffer } = await rendu(REPORT_LONG);
    const pages = nombreDePages(buffer);

    const mentions = (text.match(/Généré automatiquement par Vizyo Tracky/g) ?? []).length;
    expect(mentions).toBe(pages);
  });

  /**
   * ⚠️ « PAGE 1 / 1 » SUR UN DOCUMENT DE TROIS PAGES : le total était lu avant que la boucle
   * n'ait créé les pages qu'elle créait elle-même. Il est désormais lu une fois, et il est vrai.
   */
  it('la numérotation dit le vrai total', async () => {
    const { text, buffer } = await rendu(REPORT_LONG);
    const total = nombreDePages(buffer);

    expect(text).toContain(`Page 1 / ${total}`);
    expect(text).toContain(`Page ${total} / ${total}`);
    expect(text).not.toContain(`Page ${total + 1} /`);
  });
});

/** Toutes les couleurs posées pendant le rendu — remplissages ET traits. */
async function couleursUtilisees(report: FleetStatsReport): Promise<Set<string>> {
  const vues = new Set<string>();
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const proto = PDFDocument.prototype as any;
  const espions = ['fillColor', 'strokeColor', 'fill', 'stroke', 'fillAndStroke'].map((nom) => {
    const vrai = proto[nom];
    return jest.spyOn(proto, nom).mockImplementation(function (this: any, ...args: any[]) {
      for (const a of args) if (typeof a === 'string' && a.startsWith('#')) vues.add(a.toLowerCase());
      return vrai.apply(this, args);
    });
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
  try {
    await new ReportPdfService().generate(report);
  } finally {
    espions.forEach((e) => e.mockRestore());
  }
  return vues;
}

/** Le vert domine-t-il dans cette couleur ? */
function estVerte(hex: string): boolean {
  const n = hex.length === 4
    ? hex.slice(1).split('').map((c) => parseInt(c + c, 16))
    : [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [r, v, b] = n as [number, number, number];
  return v > r + 12 && v > b + 12;
}

describe('PDF — le document est monochrome', () => {
  /**
   * ⚠️ « ENLÈVE LE VERT COMPLÈTEMENT ». Un premier passage l'avait seulement RÉDUIT : le nom de
   * la marque et le fond des neuf cartes étaient repassés en neutre, mais il restait un segment
   * de filet vert sous l'en-tête et un repère vert sur le bandeau d'état vide.
   *
   * Ce test ne liste pas les endroits où le vert a été retiré — il interdit la TEINTE, partout.
   * C'est la seule forme qui tienne : une palette se réintroduit toujours par un endroit
   * auquel on n'avait pas pensé, et sûrement pas par celui qu'on vient de corriger.
   *
   * Les mentions ambre (`#fffbeb`, `#92400e`) restent : elles ne sont pas décoratives, elles
   * signalent une note de méthode — et elles ne sont pas vertes.
   */
  it('aucune teinte verte, nulle part', async () => {
    const vertes = [...await couleursUtilisees(makeReport())].filter(estVerte);

    expect(vertes).toEqual([]);
  });

  it('le rapport plein non plus — les tableaux ne réintroduisent rien', async () => {
    const vertes = [...await couleursUtilisees(REPORT_LONG)].filter(estVerte);

    expect(vertes).toEqual([]);
  });

  /** Contre-épreuve du détecteur : il doit reconnaître le vert de marque et sa version sombre. */
  it('le détecteur reconnaît bien un vert', () => {
    expect(estVerte('#10E0A0')).toBe(true);
    expect(estVerte('#0B8F68')).toBe(true);
    expect(estVerte('#111827')).toBe(false);
    expect(estVerte('#fffbeb')).toBe(false);
    expect(estVerte('#9AA3AC')).toBe(false);
  });
});

describe('PDF — les cartes s’éteignent quand il n’y a rien dedans', () => {
  /**
   * « 0.0 km » composé en noir franc a l'aplomb d'une mesure : neuf cartes de zéros donnaient à
   * une semaine sans le moindre trajet le même poids visuel qu'une semaine à dix mille
   * kilomètres. Le bandeau du haut le dit déjà — mais un lecteur qui parcourt la page en
   * diagonale ne lit pas le bandeau, il lit les gros chiffres.
   *
   * Les valeurs restent ÉCRITES (le document est une pièce d'archive) : elles cessent seulement
   * de se faire passer pour des données.
   */
  it('zéro trajet : le fond et l’encre des cartes passent en éteint', async () => {
    const vides = await couleursUtilisees(makeReport());

    expect(vides.has('#fafbfb')).toBe(true);
    expect(vides.has('#9aa3ac')).toBe(true);
  });

  it('dès qu’un trajet existe, les cartes reprennent leur encre pleine', async () => {
    const pleines = await couleursUtilisees(REPORT_LONG);

    expect(pleines.has('#fafbfb')).toBe(false);
    expect(pleines.has('#9aa3ac')).toBe(false);
    expect(pleines.has('#f6f7f8')).toBe(true);
  });
});

describe('PDF — le logo de la marque', () => {
  it('le document embarque le logo', async () => {
    const { buffer } = await rendu(makeReport());

    expect(contientUneImage(buffer)).toBe(true);
  });

  /**
   * ⚠️ LE CHEMIN EST VÉRIFIÉ ICI PARCE QU'IL EST SILENCIEUX AILLEURS. Le service tolère
   * l'absence du fichier — un rapport sans logo vaut mieux qu'un rapport qui n'existe pas —,
   * mais cette tolérance rend un renommage de l'asset INVISIBLE : le logo disparaîtrait des
   * rapports sans qu'aucun test ne rougisse et sans qu'aucune erreur ne soit levée.
   *
   * C'est exactement la forme du défaut du logo des e-mails : personne ne voit une image qui
   * manque tant que personne ne compare.
   */
  it('le fichier est là où le service le cherche', () => {
    expect(existsSync(CHEMIN_LOGO)).toBe(true);
  });

  it('le nom de la marque reste écrit à côté', async () => {
    // L'image porte la marque, le texte porte le nom : un lecteur dont le visualiseur
    // n'affiche pas les images doit toujours savoir de qui vient le document.
    const { text } = await rendu(makeReport());

    expect(text).toContain('Vizyo Tracky');
  });
});

describe('PDF — quand il n’y a rien à dire, le document le dit', () => {
  /**
   * Une semaine sans trajet donnait une page de « 0 », « 0.0 km », « 0.0 h », puis un grand
   * blanc. Le document ne mentait pas, mais rien n'y distinguait « la flotte n'a pas roulé »
   * de « le rapport n'a pas su calculer » — et l'un des deux est une panne.
   */
  it('zéro trajet : le fait est écrit, en tête de document', async () => {
    const { text } = await rendu(makeReport());

    expect(text).toContain('Aucun trajet sur cette période');
    expect(text).toContain('ce n’est pas une erreur de calcul');
  });

  it('le parc est nommé : on sait sur quoi porte ce zéro', async () => {
    const { text } = await rendu(makeReport());

    expect(text).toContain('Aucun des 2 véhicules du parc n’a transmis de trajet');
  });

  /**
   * ⚠️ LES INDICATEURS RESTENT IMPRIMÉS. Le document est une pièce d'archive : « la semaine du
   * 31/08 est à zéro » est une information, et la retirer laisserait un trou dans la série que
   * le client compare d'une semaine sur l'autre.
   */
  it('les indicateurs sont quand même là — on ajoute la phrase, on ne retire pas le chiffre', async () => {
    const { text } = await rendu(makeReport());

    expect(text).toContain('Indicateurs clés');
    expect(text).toContain('TRAJETS');
  });

  it('sous filtre conducteur, la phrase parle de LUI, pas du parc', async () => {
    const { text } = await rendu(makeReport(), { driverLabel: 'Conducteur : Sohaib Hamanni' });

    expect(text).toContain('Aucun trajet ne lui est attribué');
    expect(text).not.toContain('du parc n’a transmis de trajet');
  });

  it('dès qu’un trajet existe, aucune phrase d’état vide', async () => {
    const { text } = await rendu(REPORT_LONG);

    expect(text).not.toContain('Aucun trajet sur cette période');
  });

  /**
   * ⚠️ NE PAS REDIRE L'ENCART AMBRE. Celui-là explique une BASE DE CALCUL et n'apparaît que si
   * quelque chose est exclu ; celui-ci énonce un FAIT. Quand les deux se suivent, la cause
   * (« vérifiez les boîtiers ») n'est écrite qu'une fois — par l'encart ambre, qui la porte
   * déjà avec les plaques concernées.
   */
  it('quand l’encart ambre explique déjà les boîtiers, l’état vide ne le répète pas', async () => {
    const avecDormants = makeReport({
      vehicles: {
        total: 2, activeDuringPeriod: 0, exploited: 0, dormant: 0, withoutTracker: 2,
        dormantVehicles: [], idleVehicles: [], idleTotal: 0, hiddenByPrivacy: 0,
      },
    });

    const { text } = await rendu(avecDormants);

    expect(text).toContain('Aucun trajet sur cette période');
    expect(text).not.toContain('vérifiez l’alimentation et la connexion');
  });

  it('parc sain et pourtant zéro trajet : là, on dit quoi vérifier', async () => {
    // Aucun encart ambre ne viendra : sans cette ligne, le document constaterait sans aider.
    const { text } = await rendu(makeReport());

    expect(text).toContain('vérifiez l’alimentation et la connexion');
  });
});
