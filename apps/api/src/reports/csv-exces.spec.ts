import { ReportCsvService } from './report-csv.service';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * LE CSV COMPTE LES EXCÈS, LUI AUSSI — MAIS EN FIN DE LIGNE
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * L'écran, le PDF (ses DEUX tableaux) et le classeur (ses quatre feuilles) comptent les excès.
 * Le CSV des trajets, non : il s'arrêtait à 23 colonnes, dont aucune ne parlait de vitesse
 * au-delà de `max_speed_kmh` — c'est-à-dire d'une pointe, pas d'un dépassement de limite.
 *
 * ── POURQUOI À LA FIN, ET POURQUOI C'EST BIEN LEUR PLACE ─────────────────────────────────
 *
 * Les 23 colonnes historiques sont un CONTRAT : des scripts et des imports les lisent.
 * Insérer au milieu décalerait tout pour qui lit par POSITION ; ajouter à la fin ne change
 * rien, ni pour eux, ni pour qui lit par nom d'en-tête.
 *
 * ⚠️ Le lot du filtre conducteur avait tranché l'INVERSE — la marque du filtre irait dans le
 * NOM du fichier, pas dans une colonne. Ce n'est pas une contradiction : il s'agissait alors
 * de décrire le FICHIER ENTIER, et une colonne qui répète la même valeur sur toutes les lignes
 * n'est pas une donnée. Un compte d'excès, lui, change à chaque ligne — c'est exactement ce
 * qu'une colonne porte, et la raison d'être d'un CSV qu'on trie.
 */
const FLEET_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FROM = new Date('2026-06-01T00:00:00.000Z');
const TO = new Date('2026-07-01T00:00:00.000Z');

const TRAJETS = [
  {
    id: 't1', startedAt: new Date('2026-06-02T08:00:00.000Z'), endedAt: new Date('2026-06-02T08:30:00.000Z'),
    durationSeconds: 1800, distanceKm: 12.4, maxSpeed: 92, avgSpeed: 41, positionCount: 30,
    startLat: 43.6, startLng: 1.44, endLat: 43.61, endLng: 1.45, notes: null, notesUpdatedAt: null,
    driverId: null, driverSource: null, driver: null, notesUpdatedBy: null,
    vehicle: { plate: 'AB-123-CD', groups: [] },
  },
  {
    id: 't2', startedAt: new Date('2026-06-03T08:00:00.000Z'), endedAt: new Date('2026-06-03T08:20:00.000Z'),
    durationSeconds: 1200, distanceKm: 7.5, maxSpeed: 118, avgSpeed: 38, positionCount: 20,
    startLat: 43.6, startLng: 1.44, endLat: 43.62, endLng: 1.46, notes: null, notesUpdatedAt: null,
    driverId: null, driverSource: null, driver: null, notesUpdatedBy: null,
    vehicle: { plate: 'AB-123-CD', groups: [] },
  },
];

const EXCES = [{ tripId: 't2', vehicleId: 'v1', driverId: null, exces: 4, pire: 26.42 }];

function service(opts: { queryRaw?: unknown } = {}) {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const prisma: any = { trip: { findMany: jest.fn().mockResolvedValue(TRAJETS) } };
  if ('queryRaw' in opts) prisma.$queryRaw = opts.queryRaw;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return new ReportCsvService(prisma);
}

/** L'en-tête et les lignes du CSV, découpés au point-virgule. */
function lignes(corps: string): string[][] {
  return corps.trim().split(/\r?\n/).map((l) => l.split(';'));
}

describe('CSV des trajets — les excès, en fin de ligne', () => {
  it('les deux colonnes existent, et elles ferment la marche', async () => {
    const svc = service({ queryRaw: jest.fn().mockResolvedValue(EXCES) });

    const res = await svc.trips(FLEET_ID, FROM, TO);
    const [entete] = lignes(res.body);

    // ⚠️ LES DEUX DERNIÈRES, et dans cet ordre : c'est ce qui garantit que les 23 colonnes
    // historiques gardent leur position. Un script qui lisait la colonne 12 la lit encore.
    expect(entete!.slice(-2)).toEqual(['speeding_count', 'worst_over_kmh']);
    expect(entete!.length).toBe(25);
    expect(entete!.indexOf('trip_id')).toBe(0);
    expect(entete!.indexOf('notes_updated_at_local')).toBe(22);
  });

  it('un trajet avec excès porte son compte et son pire dépassement', async () => {
    const svc = service({ queryRaw: jest.fn().mockResolvedValue(EXCES) });

    const [entete, ...rangs] = lignes((await svc.trips(FLEET_ID, FROM, TO)).body);
    const iId = entete!.indexOf('trip_id');
    const iCompte = entete!.indexOf('speeding_count');
    const iPire = entete!.indexOf('worst_over_kmh');
    const t2 = rangs.find((r) => r[iId] === 't2')!;

    expect(t2[iCompte]).toBe('4');
    expect(t2[iPire]).toBe('26.4');
  });

  it('un trajet sans excès porte « 0 », et AUCUN pire', async () => {
    // Un 0 dans la colonne du pire se trierait comme une mesure, au milieu de trajets qui en
    // ont vraiment un — et se recopierait tel quel dans le tableur du gestionnaire.
    const svc = service({ queryRaw: jest.fn().mockResolvedValue(EXCES) });

    const [entete, ...rangs] = lignes((await svc.trips(FLEET_ID, FROM, TO)).body);
    const t1 = rangs.find((r) => r[entete!.indexOf('trip_id')] === 't1')!;

    expect(t1[entete!.indexOf('speeding_count')]).toBe('0');
    expect(t1[entete!.indexOf('worst_over_kmh')]).toBe('');
  });

  /**
   * ⚠️ LA DÉGRADATION EST UNE FONCTIONNALITÉ. Le CSV est ce qu'on ouvre quand l'écran ne
   * répond plus : le faire tomber pour une colonne accessoire serait une régression bien plus
   * grave que son absence. Deux colonnes à zéro se remarquent et se comprennent.
   */
  it('la requête échoue : le CSV sort quand même, colonnes à zéro', async () => {
    const svc = service({ queryRaw: jest.fn().mockRejectedValue(new Error('base indisponible')) });

    const [entete, ...rangs] = lignes((await svc.trips(FLEET_ID, FROM, TO)).body);

    expect(rangs.length).toBe(TRAJETS.length);
    expect(rangs[0]![entete!.indexOf('speeding_count')]).toBe('0');
  });

  it('la méthode n’existe même pas : même issue, pas une exception', async () => {
    // Un `.catch()` seul ne rattraperait pas celle-là : elle est SYNCHRONE. Les deux appelants
    // (classeur et CSV) ont fait l'erreur à tour de rôle ; `lireExcesParTrajet` la corrige une
    // fois pour toutes.
    const res = await service().trips(FLEET_ID, FROM, TO);

    expect(lignes(res.body).length).toBe(1 + TRAJETS.length);
  });

  it('le filtre conducteur et le périmètre bornent AUSSI la lecture des excès', async () => {
    /**
     * Sans cela, un CSV au nom d'une personne lui compterait les dépassements de ses collègues
     * — dans un fichier qui survivra à l'écran qui l'a produit.
     */
    const queryRaw = jest.fn().mockResolvedValue([]);
    const D1 = '11111111-1111-4111-8111-111111111111';

    await service({ queryRaw }).trips(FLEET_ID, FROM, TO, ['v1', 'v2'], D1);

    const valeurs: unknown[] = [];
    const descendre = (vs: readonly unknown[]): void => {
      for (const v of vs) {
        if (v && typeof v === 'object' && Array.isArray((v as { values?: unknown }).values)) {
          descendre((v as { values: unknown[] }).values);
        } else valeurs.push(v);
      }
    };
    descendre(queryRaw.mock.calls[0]!.slice(1));

    expect(valeurs).toContain(D1);
    expect(valeurs.some((v) => Array.isArray(v) && v.includes('v2'))).toBe(true);
  });
});
