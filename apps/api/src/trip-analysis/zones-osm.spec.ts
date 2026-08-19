import { REGIONS_OSM, couvre, couvertureParRegion, cellulesOrphelines, planTelechargement } from './zones-osm';

/**
 * ── CE QUE CE MODULE DOIT GARANTIR ───────────────────────────────────────────────────
 *
 * Interroger Overpass pour 220 000 portions de route s'est soldé par deux IP bannies en une
 * journée. La sortie est de télécharger l'extrait OSM des régions parcourues et de résoudre en
 * local. Encore faut-il choisir les bonnes régions — et surtout REMARQUER quand la flotte roule
 * là où aucun extrait ne couvre, au lieu de laisser ces trajets sans limites sans explication.
 *
 * Les coordonnées ci-dessous sont réelles : Toulouse concentre 61,5 % des portions à résoudre,
 * Barcelone moins de 1 %.
 */
const TOULOUSE = { lat: 43.6045, lng: 1.4442 };
const MONTPELLIER = { lat: 43.6109, lng: 3.8763 };
const BORDEAUX = { lat: 44.8378, lng: -0.5792 };
const BARCELONE = { lat: 41.3874, lng: 2.1686 };
const OSLO = { lat: 59.9139, lng: 10.7522 };

const region = (id: string) => REGIONS_OSM.find((r) => r.id === id)!;

describe('Catalogue des régions OSM', () => {
  it('chaque région porte une URL d’extrait et une emprise cohérente', () => {
    for (const r of REGIONS_OSM) {
      expect(r.pbf).toMatch(/^https:\/\/download\.geofabrik\.de\/.+\.osm\.pbf$/);
      expect(r.emprise.minLat).toBeLessThan(r.emprise.maxLat);
      expect(r.emprise.minLng).toBeLessThan(r.emprise.maxLng);
      expect(r.tailleMo).toBeGreaterThan(0);
    }
  });

  it('les villes de la zone d’exploitation tombent dans la bonne région', () => {
    expect(couvre(region('midi-pyrenees'), TOULOUSE.lat, TOULOUSE.lng)).toBe(true);
    expect(couvre(region('languedoc-roussillon'), MONTPELLIER.lat, MONTPELLIER.lng)).toBe(true);
    expect(couvre(region('aquitaine'), BORDEAUX.lat, BORDEAUX.lng)).toBe(true);
    expect(couvre(region('cataluna'), BARCELONE.lat, BARCELONE.lng)).toBe(true);
  });

  it('un point hors zone n’est couvert par aucune région', () => {
    for (const r of REGIONS_OSM) expect(couvre(r, OSLO.lat, OSLO.lng)).toBe(false);
  });

  /**
   * ⚠️ LE CAS QUI A FAIT TOMBER LA PREMIÈRE VERSION.
   *
   * Toulouse est à 1,4442 de longitude ; l'emprise RECTANGULAIRE d'Aquitaine va jusqu'à 1,451.
   * Avec un simple test de rectangle, Aquitaine « couvrait » donc Toulouse — et le choix
   * glouton partait télécharger 281 Mo pour une région qui, en réalité, ne contient pas la
   * ville où se concentrent 61,5 % des portions à résoudre. Le découpage réel est un polygone.
   */
  it('⚠️ Toulouse n’appartient QU’À Midi-Pyrénées, malgré le rectangle d’Aquitaine', () => {
    const dedans = REGIONS_OSM.filter((r) => couvre(r, TOULOUSE.lat, TOULOUSE.lng)).map((r) => r.id);
    expect(dedans).toEqual(['midi-pyrenees']);
    // Le rectangle, lui, l'attrapait bien : c'est exactement pour ça qu'il ne décide plus seul.
    const aqui = region('aquitaine').emprise;
    expect(TOULOUSE.lng).toBeLessThan(aqui.maxLng);
    expect(TOULOUSE.lat).toBeGreaterThan(aqui.minLat);
  });
});

describe('Couverture', () => {
  it('classe les régions par nombre de cellules couvertes', () => {
    const cellules = [TOULOUSE, TOULOUSE, TOULOUSE, MONTPELLIER, BARCELONE];
    const c = couvertureParRegion(cellules);
    expect(c[0]!.region.id).toBe('midi-pyrenees');
    expect(c[0]!.cellules).toBe(3);
  });

  it('n’annonce pas une région qui ne couvrirait rien', () => {
    const c = couvertureParRegion([BORDEAUX]);
    expect(c.map((x) => x.region.id)).not.toContain('cataluna');
  });
});

describe('Cellules orphelines — le signal « la flotte roule ailleurs »', () => {
  it('⚠️ un point hors de toute région est SIGNALÉ, pas ignoré', () => {
    const orphelines = cellulesOrphelines([TOULOUSE, OSLO, BARCELONE]);
    expect(orphelines).toHaveLength(1);
    expect(orphelines[0]).toEqual(OSLO);
  });

  it('zone d’exploitation connue → aucune orpheline', () => {
    expect(cellulesOrphelines([TOULOUSE, MONTPELLIER, BORDEAUX, BARCELONE])).toHaveLength(0);
  });
});

describe('Plan de téléchargement', () => {
  const beaucoup = (c: { lat: number; lng: number }, n: number) => Array.from({ length: n }, () => c);

  it('⚠️ commence par la région qui couvre le plus — Toulouse d’abord, comme dans les faits', () => {
    const plan = planTelechargement([...beaucoup(TOULOUSE, 5000), ...beaucoup(BARCELONE, 800)], 500);
    expect(plan[0]!.region.id).toBe('midi-pyrenees');
    expect(plan[0]!.gain).toBe(5000);
  });

  it('⚠️ ne tire pas 281 Mo pour une poignée de portions : Overpass suffit pour ça', () => {
    const plan = planTelechargement([...beaucoup(TOULOUSE, 5000), ...beaucoup(BORDEAUX, 30)], 500);
    expect(plan.map((p) => p.region.id)).not.toContain('aquitaine');
  });

  it('ne compte JAMAIS deux fois une cellule couverte par deux régions', () => {
    // Toulouse tombe dans l'emprise rectangulaire de Midi-Pyrénées ET d'Aquitaine.
    const plan = planTelechargement(beaucoup(TOULOUSE, 5000), 500);
    const total = plan.reduce((s, p) => s + p.gain, 0);
    expect(total).toBe(5000);
    expect(plan).toHaveLength(1); // la seconde région n'apporterait rien de neuf
  });

  it('aucune cellule → aucun téléchargement', () => {
    expect(planTelechargement([], 500)).toHaveLength(0);
  });

  it('que des orphelines → aucun téléchargement, et elles restent visibles', () => {
    expect(planTelechargement(beaucoup(OSLO, 9000), 500)).toHaveLength(0);
    expect(cellulesOrphelines(beaucoup(OSLO, 3))).toHaveLength(3);
  });

  it('le plan couvre bien plusieurs régions quand la flotte est dispersée', () => {
    const plan = planTelechargement(
      [...beaucoup(TOULOUSE, 4000), ...beaucoup(BARCELONE, 2000), ...beaucoup(BORDEAUX, 1500)],
      500,
    );
    const ids = plan.map((p) => p.region.id);
    expect(ids).toContain('midi-pyrenees');
    expect(ids).toContain('cataluna');
    expect(plan.reduce((s, p) => s + p.gain, 0)).toBe(7500);
  });
});
