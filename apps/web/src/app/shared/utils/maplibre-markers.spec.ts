import {
  buildVehicleMarkerEl,
  markerInk,
  OFFLINE_MARKER_COLOR,
  GPS_LOST_MARKER_COLOR,
  speedColor,
  updateVehicleMarkerEl,
  type VehicleMarkerData,
} from './maplibre-markers';
import { BANDES_VITESSE } from './couleurs-carte';
import { getVehicleSvg } from './vehicle-icons';

/**
 * L'ENCRE de l'icône sur la pastille — reprise en SVG du 2026-08-12.
 *
 * La planche pose une encre très sombre sur ses fonds vifs. Mesuré au navigateur :
 * du blanc sur `#10E0A0` donne 1,72:1, l'encre sombre 10,44:1. Mais la planche ne
 * montre que des véhicules EN MOUVEMENT : sur `#5C746C` (« à l'arrêt », déjà sombre)
 * l'encre sombre retombe à 3,85 quand le blanc y donne 5,04.
 *
 * Ce test tient la règle sur TOUTE la palette, pas sur les couleurs de la planche.
 */
describe('markerInk — l’icône reste lisible sur les six fonds de la palette', () => {
  const canal = (v: number) => { const c = v / 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (hex: string) => {
    const h = hex.replace('#', '');
    const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
    return 0.2126 * canal(parseInt(n.slice(0, 2), 16))
      + 0.7152 * canal(parseInt(n.slice(2, 4), 16))
      + 0.0722 * canal(parseInt(n.slice(4, 6), 16));
  };
  const contraste = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)];
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  };

  /**
   * ⚠️ Les CINQ bandes de vitesse, pas quatre. La cinquième (« plus de 140 km/h », rouge
   * foncé) est celle qu'une table écrite à la main oublie : elle n'existait pas quand cette
   * table a été écrite, et rien ne l'aurait signalé.
   */
  const PALETTE: Array<[string, string]> = [
    ...BANDES_VITESSE.map((b): [string, string] => [b.libelle, b.couleur]),
    ['hors ligne', OFFLINE_MARKER_COLOR],
    ['GPS perdu', GPS_LOST_MARKER_COLOR],
  ];

  it('la table lue est bien celle à cinq bandes', () => {
    expect(PALETTE.length).toBe(7);
  });

  for (const [nom, fond] of PALETTE) {
    it(`passe 4,5:1 sur ${nom} (${fond})`, () => {
      expect(contraste(markerInk(fond), fond)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it('choisit le BLANC sur un fond sombre et une teinte sombre sur un fond clair', () => {
    expect(markerInk('#5C746C')).toBe('#FFFFFF');
    expect(markerInk('#10E0A0')).not.toBe('#FFFFFF');
  });
});

/**
 * UNE SEULE ÉCHELLE DE VITESSE, demandée par le propriétaire le 2026-09-07 :
 * 1–65 vert, 66–100 orange, 101–140 rouge, au-delà rouge foncé.
 *
 * `speedColor` est l'entrée historique des marqueurs et de la mini-carte : elle doit
 * répondre exactement comme la source unique de `couleurs-carte.ts`, sinon la pastille du
 * véhicule et la traînée sous ses roues se contredisent au même instant.
 */
describe('speedColor — la seule échelle de vitesse', () => {
  it('🔴 65 km/h est encore vert, 66 devient orange', () => {
    expect(speedColor(65)).toBe('#10E0A0');
    expect(speedColor(66)).toBe('#F59E0B');
  });

  it('🔴 100 km/h est encore orange, 101 devient rouge', () => {
    expect(speedColor(100)).toBe('#F59E0B');
    expect(speedColor(101)).toBe('#EF4444');
  });

  it('🔴 140 km/h est encore rouge, 141 devient rouge foncé', () => {
    expect(speedColor(140)).toBe('#EF4444');
    expect(speedColor(141)).toBe('#991B1B');
  });

  it('0 km/h et les vitesses négatives sont « à l’arrêt »', () => {
    expect(speedColor(0)).toBe('#5C746C');
    expect(speedColor(-3)).toBe('#5C746C');
  });
});

/**
 * Icône du marqueur véhicule.
 *
 * Bug 2026-07-20 : toute la flotte s'affichait en FLÈCHES. Les positions arrivent par WebSocket
 * (rapide) alors que le type du véhicule vient d'un appel HTTP → le marqueur naissait avec le repli
 * « OTHER » (flèche), et `updateVehicleMarkerEl` ne redessinait jamais l'icône malgré son
 * commentaire qui l'affirmait. Les véhicules restaient donc des flèches jusqu'au rechargement.
 */
describe('updateVehicleMarkerEl — icône du véhicule', () => {
  /**
   * Le navigateur ré-sérialise le SVG (`<path/>` devient `<path></path>`), donc comparer des
   * chaînes brutes échouerait pour rien. On passe les deux côtés par le même moteur de rendu.
   */
  function normalizeSvg(markup: string): string {
    const probe = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    probe.innerHTML = markup;
    return probe.innerHTML.trim();
  }
  // La pastille est un SVG depuis le 2026-08-12 : l'icône est le groupe interne.
  const iconNode = (el: HTMLElement) => el.querySelector('.tracky-marker__icone > g')!;
  const iconOf = (el: HTMLElement) => iconNode(el).innerHTML.trim();

  function data(over: Partial<VehicleMarkerData> = {}): VehicleMarkerData {
    return {
      trackerId: 't-1',
      vehicleId: 'v-1',
      type: 'OTHER',
      plate: '',
      speedKmh: 0,
      heading: 0,
      ignition: false,
      ...over,
    } as VehicleMarkerData;
  }

  it('remplace la flèche par la bonne icône quand le type arrive après coup', () => {
    // Marqueur créé AVANT que la fiche véhicule soit chargée → repli « OTHER ».
    const el = buildVehicleMarkerEl(data());
    expect(el.getAttribute('data-vehicle-type')).toBe('OTHER');
    expect(iconOf(el)).toBe(normalizeSvg(getVehicleSvg('OTHER')));

    // La fiche arrive : c'est une camionnette.
    updateVehicleMarkerEl(el, data({ type: 'VAN' }));

    expect(el.getAttribute('data-vehicle-type')).toBe('VAN');
    expect(iconOf(el)).toBe(normalizeSvg(getVehicleSvg('VAN')));
    expect(iconOf(el)).not.toBe(normalizeSvg(getVehicleSvg('OTHER'))); // plus de flèche
  });

  it('ne touche pas au DOM quand le type est inchangé (mise à jour la plus fréquente)', () => {
    const el = buildVehicleMarkerEl(data({ type: 'CAR' }));
    const g = iconNode(el);
    const before = g.innerHTML;

    updateVehicleMarkerEl(el, data({ type: 'CAR', speedKmh: 50, heading: 90 }));

    expect(g.innerHTML).toBe(before);
    expect(iconNode(el)).toBe(g); // même nœud, pas de recréation
  });

  it('ne fait pivoter l\'icône que pour la flèche (une voiture doit rester droite)', () => {
    const car = buildVehicleMarkerEl(data({ type: 'CAR' }));
    updateVehicleMarkerEl(car, data({ type: 'CAR', heading: 135 }));
    expect(iconNode(car).getAttribute('transform')).toBeNull();

    const other = buildVehicleMarkerEl(data({ type: 'OTHER' }));
    updateVehicleMarkerEl(other, data({ type: 'OTHER', heading: 135 }));
    expect(iconNode(other).getAttribute('transform')).toContain('135');
  });

  /**
   * La pastille est UN SVG depuis le 2026-08-12 (ligne B1). Ce test tient la promesse
   * du commentaire : les formes sont dans le SVG, pas empilées en div.
   */
  it('dessine la pastille en SVG, pas en pile de div', () => {
    const el = buildVehicleMarkerEl(data({ type: 'CAR', plate: 'AA-111-BB' }));
    const svg = el.querySelector('svg.tracky-marker__pastille');
    expect(svg).not.toBeNull();
    for (const sel of ['.tracky-marker__pulse', '.tracky-marker__cap', '.tracky-marker__anneau',
      '.tracky-marker__coeur', '.tracky-marker__icone', '.tracky-marker__acc']) {
      expect(svg!.querySelector(sel)).withContext(sel).not.toBeNull();
    }
    // Une SEULE écriture de couleur : sur le conteneur, pas recopiée dans les formes.
    expect(el.style.getPropertyValue('--tracky-color')).toBeTruthy();
    expect(el.querySelector('[style*="background"]')).toBeNull();
  });

  it('affiche la plaque quand elle arrive après la création du marqueur', () => {
    const el = buildVehicleMarkerEl(data()); // créé sans plaque → pas d'élément plaque
    expect(el.querySelector('.tracky-marker__plate')).toBeNull();

    updateVehicleMarkerEl(el, data({ plate: 'GS-138-LT', speedKmh: 42 }));

    // Planche Carte : l'étiquette porte « plaque · vitesse ».
    expect(el.querySelector('.tracky-marker__plate')!.textContent).toBe('GS-138-LT · 42');
    // …mais le nom accessible ne suit PAS la vitesse, sinon un lecteur d'écran
    // réannonce le marqueur à chaque trame.
    expect(el.getAttribute('aria-label')).toBe('Vehicule GS-138-LT');
  });

  /**
   * Incident FS-253, transposé à l'étiquette : hors direct, la vitesse est un SOUVENIR.
   * La planche l'écrit elle-même « AZ-330-PB · hors ligne ».
   */
  describe('étiquette — jamais une vitesse périmée', () => {
    const labelOf = (el: HTMLElement) => el.querySelector('.tracky-marker__plate')!.textContent;

    it('affiche la vitesse quand la télémétrie est fraîche', () => {
      const el = buildVehicleMarkerEl(data({ plate: 'AA-111-BB', speedKmh: 72 }));
      expect(labelOf(el)).toBe('AA-111-BB · 72');
    });

    /**
     * Relevé au navigateur le 2026-08-12 : une pastille ROUGE (donc `colorSpeedKmh` > 90)
     * portait « TE002ST · 18 ». La couleur et le chiffre doivent venir du MÊME nombre,
     * sinon le marqueur se contredit lui-même.
     */
    it('affiche la vitesse qui donne la COULEUR, pas la vitesse brute du boîtier', () => {
      const el = buildVehicleMarkerEl(data({ plate: 'TE002ST', speedKmh: 0, colorSpeedKmh: 96 }));
      expect(labelOf(el)).toBe('TE002ST · 96');
    });

    /**
     * Relevé au navigateur : une pastille VERTE portait « TE001ST · 0 ». À 0,4 km/h,
     * `speedColor` répond « en mouvement » (> 0) alors que l'étiquette arrondit à 0.
     * La couleur doit partir du MÊME nombre arrondi que le chiffre affiché.
     */
    it('n’affiche pas « 0 » sur une pastille de mouvement (arrondi sous 1 km/h)', () => {
      const el = buildVehicleMarkerEl(data({ plate: 'TE001ST', speedKmh: 0.4 }));
      expect(labelOf(el)).toBe('TE001ST · 0');
      // 0,4 s'arrondit à 0 → la pastille doit être celle de l'ARRÊT, pas du mouvement.
      expect(el.style.getPropertyValue('--tracky-color').toLowerCase()).toBe(speedColor(0).toLowerCase());
    });

    it('affiche « hors ligne » au lieu du chiffre dès que la position est figée', () => {
      for (const stale of [{ offline: true }, { gpsLost: true }, { parkedDeadZone: true }]) {
        const el = buildVehicleMarkerEl(data({ plate: 'AZ-330-PB', speedKmh: 88, ...stale }));
        expect(labelOf(el)).withContext(JSON.stringify(stale)).toBe('AZ-330-PB · hors ligne');
      }
    });

    it('bascule vers « hors ligne » en direct quand le boîtier se tait', () => {
      const el = buildVehicleMarkerEl(data({ plate: 'AZ-330-PB', speedKmh: 88 }));
      expect(labelOf(el)).toBe('AZ-330-PB · 88');

      updateVehicleMarkerEl(el, data({ plate: 'AZ-330-PB', speedKmh: 88, offline: true }));

      expect(labelOf(el)).toBe('AZ-330-PB · hors ligne');
    });
  });

  /**
   * Incident FS-253 : garé 5 jours dans un parking souterrain, la pastille de contact restait
   * VERTE parce que la dernière trame (vieille de 5 jours) disait `ignition: true`.
   */
  describe('pastille de contact (ACC) — ne jamais affirmer sur une donnée périmée', () => {
    const accClasses = (el: HTMLElement) => Array.from(el.querySelector('.tracky-marker__acc')!.classList);

    it('affiche « inconnu » (ni vert ni gris plein) quand le véhicule est garé sous terre', () => {
      const el = buildVehicleMarkerEl(data({ type: 'CAR', ignition: true, gpsLost: true, parkedDeadZone: true }));
      expect(accClasses(el)).toContain('tracky-acc--unknown');
      expect(accClasses(el)).not.toContain('tracky-acc--on');
    });

    it('affiche « inconnu » quand le GPS est perdu ou le boîtier hors-ligne', () => {
      for (const stale of [{ gpsLost: true }, { offline: true }]) {
        const el = buildVehicleMarkerEl(data({ type: 'CAR', ignition: true, ...stale }));
        expect(accClasses(el)).toContain('tracky-acc--unknown');
        expect(accClasses(el)).not.toContain('tracky-acc--on');
      }
    });

    it('bascule de vert à inconnu quand la télémétrie devient périmée (mise à jour live)', () => {
      const el = buildVehicleMarkerEl(data({ type: 'CAR', ignition: true }));
      expect(accClasses(el)).toContain('tracky-acc--on');

      updateVehicleMarkerEl(el, data({ type: 'CAR', ignition: true, gpsLost: true, parkedDeadZone: true }));

      expect(accClasses(el)).toContain('tracky-acc--unknown');
      expect(accClasses(el)).not.toContain('tracky-acc--on');
    });

    it('reste fidèle quand la donnée est FRAÎCHE (vert si contact mis, gris si coupé)', () => {
      const on = buildVehicleMarkerEl(data({ type: 'CAR', ignition: true }));
      expect(accClasses(on)).toContain('tracky-acc--on');

      const off = buildVehicleMarkerEl(data({ type: 'CAR', ignition: false }));
      expect(accClasses(off)).toContain('tracky-acc--off');
      expect(accClasses(off)).not.toContain('tracky-acc--unknown');
    });
  });

  it('chaque type connu a bien une icône distincte de la flèche', () => {
    const arrow = getVehicleSvg('OTHER');
    for (const type of ['CAR', 'TRUCK', 'VAN', 'MOTORCYCLE', 'BICYCLE', 'BUS', 'CONSTRUCTION']) {
      expect(getVehicleSvg(type)).not.toBe(arrow);
    }
  });
});
