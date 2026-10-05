import {
  buildVehicleMarkerEl,
  markerInk,
  OFFLINE_MARKER_COLOR,
  GPS_LOST_MARKER_COLOR,
  speedColor,
  ACCIDENT_MARKER_COLOR,
  IMMOBILIZED_MARKER_COLOR,
  UNPLUGGED_MARKER_COLOR,
  updateVehicleMarkerEl,
  type VehicleMarkerData,
} from './maplibre-markers';
import { BANDES_VITESSE, COULEURS_CARTE } from './couleurs-carte';
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

/**
 * Boîtier DÉBRANCHÉ déclaré sur la fiche — demande du propriétaire du 05/10/2026 : « l'icône
 * barrée, grisée et rouge », sur la page Carte ET sur la mini-carte de la fiche. Une seule
 * fabrique dessine les deux : ces tests la tiennent pour les deux écrans.
 */
describe('marqueur — boîtier débranché déclaré', () => {
  function data(over: Partial<VehicleMarkerData> = {}): VehicleMarkerData {
    return {
      trackerId: 't-34',
      vehicleId: 'v-34',
      type: 'VAN',
      plate: 'DZ-034-CA',
      speedKmh: 0,
      heading: 0,
      ignition: false,
      ...over,
    } as VehicleMarkerData;
  }
  const labelOf = (el: HTMLElement) => el.querySelector('.tracky-marker__plate')!.textContent;
  const couleurOf = (el: HTMLElement) => el.style.getPropertyValue('--tracky-color').toLowerCase();
  const accClasses = (el: HTMLElement) => Array.from(el.querySelector('.tracky-marker__acc')!.classList);

  it('se dessine grisé, avec sa classe, et SANS l’habillage hors ligne (pas de double estompage)', () => {
    // Cas réel : DZ-034-CA, débranché le 31/08, muet depuis le 21/08 → aussi « hors ligne ».
    const el = buildVehicleMarkerEl(data({ offline: true, unplugged: true }));
    expect(el.classList).toContain('tracky-marker--debranche');
    expect(el.classList).not.toContain('tracky-marker--offline');
    expect(couleurOf(el)).toBe(UNPLUGGED_MARKER_COLOR.toLowerCase());
  });

  it('dit « débranché » à la place d’une vitesse ou de « hors ligne »', () => {
    expect(labelOf(buildVehicleMarkerEl(data({ unplugged: true, speedKmh: 88 })))).toBe('DZ-034-CA · débranché');
    expect(labelOf(buildVehicleMarkerEl(data({ unplugged: true, offline: true })))).toBe('DZ-034-CA · débranché');
  });

  it('prime sur « GPS perdu », sur « garé sous terre » et sur une vitesse fraîche', () => {
    for (const autre of [{ gpsLost: true }, { parkedDeadZone: true, gpsLost: true }, { speedKmh: 72, ignition: true }]) {
      const el = buildVehicleMarkerEl(data({ unplugged: true, ...autre }));
      expect(couleurOf(el)).withContext(JSON.stringify(autre)).toBe(UNPLUGGED_MARKER_COLOR.toLowerCase());
      expect(labelOf(el)).withContext(JSON.stringify(autre)).toBe('DZ-034-CA · débranché');
      // Le contact n'est plus une mesure : ni vert, ni gris plein.
      expect(accClasses(el)).withContext(JSON.stringify(autre)).toContain('tracky-acc--unknown');
    }
  });

  it('le nom accessible dit le boîtier débranché (sans suivre la vitesse)', () => {
    expect(buildVehicleMarkerEl(data({ unplugged: true })).getAttribute('aria-label'))
      .toBe('Vehicule DZ-034-CA, boîtier débranché');
    expect(buildVehicleMarkerEl(data({ speedKmh: 40 })).getAttribute('aria-label')).toBe('Vehicule DZ-034-CA');
  });

  it('se pose puis se lève EN DIRECT, sans reconstruire la pastille', () => {
    const el = buildVehicleMarkerEl(data({ speedKmh: 42, ignition: true }));
    const svg = el.querySelector('svg');
    expect(el.classList).not.toContain('tracky-marker--debranche');
    expect(labelOf(el)).toBe('DZ-034-CA · 42');

    // Le super-admin déclare « Boîtier débranché » sur la fiche.
    updateVehicleMarkerEl(el, data({ speedKmh: 42, ignition: true, unplugged: true }));
    expect(el.classList).toContain('tracky-marker--debranche');
    expect(labelOf(el)).toBe('DZ-034-CA · débranché');
    expect(el.getAttribute('aria-label')).toBe('Vehicule DZ-034-CA, boîtier débranché');

    // …puis le remet « En service » : tout redevient ordinaire.
    updateVehicleMarkerEl(el, data({ speedKmh: 42, ignition: true }));
    expect(el.classList).not.toContain('tracky-marker--debranche');
    expect(labelOf(el)).toBe('DZ-034-CA · 42');
    expect(el.getAttribute('aria-label')).toBe('Vehicule DZ-034-CA');
    expect(couleurOf(el)).toBe(speedColor(42).toLowerCase());
    expect(el.querySelector('svg')).toBe(svg); // même pastille, pas de recréation
  });

  it('remis en service mais toujours muet, il retrouve l’habillage hors ligne', () => {
    const el = buildVehicleMarkerEl(data({ unplugged: true, offline: true }));
    updateVehicleMarkerEl(el, data({ offline: true }));
    expect(el.classList).toContain('tracky-marker--offline');
    expect(labelOf(el)).toBe('DZ-034-CA · hors ligne');
  });

  it('porte les formes de l’« interdit » dès la création, sur TOUS les marqueurs', () => {
    // La mise à jour ne fait que basculer une classe : les formes doivent déjà être là.
    for (const unplugged of [true, false]) {
      const el = buildVehicleMarkerEl(data({ unplugged }));
      for (const sel of ['.tracky-marker__barre', '.tracky-marker__barre-anneau', '.tracky-marker__barre-fond', '.tracky-marker__barre-trait']) {
        expect(el.querySelector(sel)).withContext(`${sel} (unplugged=${unplugged})`).not.toBeNull();
      }
      expect(el.style.getPropertyValue('--tracky-barre').toUpperCase()).toBe(COULEURS_CARTE.debranche);
    }
  });

  /**
   * Le RENDU, avec la feuille globale que Karma charge (`styles.css`, cf. angular.json) : les
   * marqueurs vivent hors d'Angular, c'est la seule feuille qui les atteint. Sans ces tests,
   * une classe renommée d'un côté seulement laisserait la barre invisible sans rien casser.
   */
  describe('rendu par la feuille globale', () => {
    const rgb = (hex: string) => {
      const n = hex.replace('#', '');
      return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`;
    };
    const style = (el: HTMLElement, sel: string) => getComputedStyle(el.querySelector(sel)!);
    let poses: HTMLElement[] = [];
    const poser = (d: VehicleMarkerData) => {
      const el = buildVehicleMarkerEl(d);
      document.body.appendChild(el);
      poses.push(el);
      return el;
    };
    afterEach(() => { poses.forEach((el) => el.remove()); poses = []; });

    it('montre l’anneau et la barre ROUGES de la palette de carte', () => {
      const el = poser(data({ unplugged: true, brand: 'Dacia' }));
      expect(style(el, '.tracky-marker__barre').display).not.toBe('none');
      expect(style(el, '.tracky-marker__barre-trait').stroke).toBe(rgb(COULEURS_CARTE.debranche));
      expect(style(el, '.tracky-marker__barre-anneau').stroke).toBe(rgb(COULEURS_CARTE.debranche));
      // Le liseré blanc sous la barre : c'est lui qui la détache d'un fond satellite.
      expect(style(el, '.tracky-marker__barre-fond').stroke).toBe('rgb(255, 255, 255)');
    });

    it('masque la flèche de cap, le contact, le halo et le logo de marque', () => {
      const el = poser(data({ unplugged: true, brand: 'Dacia', active: true }));
      for (const sel of ['.tracky-marker__cap', '.tracky-marker__acc', '.tracky-marker__pulse']) {
        expect(style(el, sel).display).withContext(sel).toBe('none');
      }
      const logo = el.querySelector('.tracky-marker__brand');
      if (logo) expect(getComputedStyle(logo).display).toBe('none');
    });

    it('estompe le cœur (grisé) sans pâlir l’étiquette', () => {
      const el = poser(data({ unplugged: true, offline: true }));
      expect(Number(style(el, '.tracky-marker__coeur').fillOpacity)).toBeCloseTo(0.55, 2);
      expect(Number(style(el, '.tracky-marker__plate').opacity)).toBe(1);
    });

    it('ne montre AUCUNE barre sur un marqueur ordinaire', () => {
      const el = poser(data({ speedKmh: 30, ignition: true }));
      expect(style(el, '.tracky-marker__barre').display).toBe('none');
    });
  });
});

/**
 * Véhicule IMMOBILISÉ déclaré sur la fiche — demande du propriétaire du 06/10/2026 : « pareil
 * que débranché, avec la clé ». Même fabrique pour la page Carte et la mini-carte de la fiche.
 */
describe('marqueur — véhicule immobilisé déclaré', () => {
  function data(over: Partial<VehicleMarkerData> = {}): VehicleMarkerData {
    return {
      trackerId: 't-998',
      vehicleId: 'v-998',
      type: 'VAN',
      plate: 'HD-998-XY',
      speedKmh: 0,
      heading: 0,
      ignition: false,
      ...over,
    } as VehicleMarkerData;
  }
  const labelOf = (el: HTMLElement) => el.querySelector('.tracky-marker__plate')!.textContent;
  const couleurOf = (el: HTMLElement) => el.style.getPropertyValue('--tracky-color').toLowerCase();

  it('se dessine grisé avec sa classe, sans l’habillage hors ligne, et le dit', () => {
    // Cas réel : HD-998-XY, « Immobilisé — Au garage », boîtier encore vivant au garage.
    const el = buildVehicleMarkerEl(data({ immobilized: true, offline: true }));
    expect(el.classList).toContain('tracky-marker--immobilise');
    expect(el.classList).not.toContain('tracky-marker--offline');
    expect(el.classList).not.toContain('tracky-marker--debranche');
    expect(couleurOf(el)).toBe(IMMOBILIZED_MARKER_COLOR.toLowerCase());
    expect(labelOf(el)).toBe('HD-998-XY · immobilisé');
    expect(el.getAttribute('aria-label')).toBe('Vehicule HD-998-XY, immobilisé');
  });

  it('n’affiche ni vitesse ni vert « en route », même si le boîtier émet au garage', () => {
    const el = buildVehicleMarkerEl(data({ immobilized: true, speedKmh: 31, ignition: true }));
    expect(couleurOf(el)).toBe(IMMOBILIZED_MARKER_COLOR.toLowerCase());
    expect(labelOf(el)).toBe('HD-998-XY · immobilisé');
  });

  it('cède au débranché si les deux sont posés : une seule déclaration habille la pastille', () => {
    const el = buildVehicleMarkerEl(data({ immobilized: true, unplugged: true }));
    expect(el.classList).toContain('tracky-marker--debranche');
    expect(el.classList).not.toContain('tracky-marker--immobilise');
    expect(labelOf(el)).toBe('HD-998-XY · débranché');
  });

  it('se pose puis se lève EN DIRECT, sans reconstruire la pastille', () => {
    const el = buildVehicleMarkerEl(data({ speedKmh: 12, ignition: true }));
    const svg = el.querySelector('svg');
    updateVehicleMarkerEl(el, data({ speedKmh: 12, ignition: true, immobilized: true }));
    expect(el.classList).toContain('tracky-marker--immobilise');
    expect(labelOf(el)).toBe('HD-998-XY · immobilisé');

    updateVehicleMarkerEl(el, data({ speedKmh: 12, ignition: true }));
    expect(el.classList).not.toContain('tracky-marker--immobilise');
    expect(labelOf(el)).toBe('HD-998-XY · 12');
    expect(el.getAttribute('aria-label')).toBe('Vehicule HD-998-XY');
    expect(el.querySelector('svg')).toBe(svg);
  });

  it('porte la clé dès la création, sur TOUS les marqueurs, et la couleur de la palette', () => {
    for (const immobilized of [true, false]) {
      const el = buildVehicleMarkerEl(data({ immobilized }));
      for (const sel of ['.tracky-marker__cle', '.tracky-marker__cle-anneau', '.tracky-marker__cle-badge', '.tracky-marker__cle-trait']) {
        expect(el.querySelector(sel)).withContext(`${sel} (immobilized=${immobilized})`).not.toBeNull();
      }
      expect(el.style.getPropertyValue('--tracky-cle').toUpperCase()).toBe(COULEURS_CARTE.immobilise);
    }
  });

  /** Le RENDU, par la feuille globale que Karma charge — comme pour le débranché. */
  describe('rendu par la feuille globale', () => {
    const rgb = (hex: string) => {
      const n = hex.replace('#', '');
      return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`;
    };
    const style = (el: HTMLElement, sel: string) => getComputedStyle(el.querySelector(sel)!);
    let poses: HTMLElement[] = [];
    const poser = (d: VehicleMarkerData) => {
      const el = buildVehicleMarkerEl(d);
      document.body.appendChild(el);
      poses.push(el);
      return el;
    };
    afterEach(() => { poses.forEach((el) => el.remove()); poses = []; });

    it('montre l’anneau et le badge AMBRE, la clé blanche, et pas la barre rouge', () => {
      const el = poser(data({ immobilized: true }));
      expect(style(el, '.tracky-marker__cle').display).not.toBe('none');
      expect(style(el, '.tracky-marker__cle-anneau').stroke).toBe(rgb(COULEURS_CARTE.immobilise));
      expect(style(el, '.tracky-marker__cle-badge').fill).toBe(rgb(COULEURS_CARTE.immobilise));
      expect(style(el, '.tracky-marker__cle-trait').stroke).toBe('rgb(255, 255, 255)');
      expect(style(el, '.tracky-marker__barre').display).toBe('none');
    });

    it('masque la flèche, le contact (place du badge), le halo et le logo ; estompe le cœur', () => {
      const el = poser(data({ immobilized: true, brand: 'Dacia', active: true, ignition: true }));
      for (const sel of ['.tracky-marker__cap', '.tracky-marker__acc', '.tracky-marker__pulse']) {
        expect(style(el, sel).display).withContext(sel).toBe('none');
      }
      const logo = el.querySelector('.tracky-marker__brand');
      if (logo) expect(getComputedStyle(logo).display).toBe('none');
      expect(Number(style(el, '.tracky-marker__coeur').fillOpacity)).toBeCloseTo(0.55, 2);
    });

    it('ne montre AUCUNE clé sur un marqueur ordinaire', () => {
      const el = poser(data({ speedKmh: 30, ignition: true }));
      expect(style(el, '.tracky-marker__cle').display).toBe('none');
    });
  });
});

/**
 * Véhicule ACCIDENTÉ déclaré sur la fiche — demande du propriétaire du 06/10/2026 : « fais pareil
 * pour accidenté ». Les trois motifs de la fiche ont désormais chacun leur habillage.
 */
describe('marqueur — véhicule accidenté déclaré', () => {
  function data(over: Partial<VehicleMarkerData> = {}): VehicleMarkerData {
    return {
      trackerId: 't-370',
      vehicleId: 'v-370',
      type: 'CAR',
      plate: 'KSR-370',
      speedKmh: 0,
      heading: 0,
      ignition: false,
      ...over,
    } as VehicleMarkerData;
  }
  const labelOf = (el: HTMLElement) => el.querySelector('.tracky-marker__plate')!.textContent;
  const couleurOf = (el: HTMLElement) => el.style.getPropertyValue('--tracky-color').toLowerCase();

  it('se dessine grisé avec sa classe, sans l’habillage hors ligne, et le dit', () => {
    const el = buildVehicleMarkerEl(data({ accident: true, offline: true }));
    expect(el.classList).toContain('tracky-marker--accidente');
    expect(el.classList).not.toContain('tracky-marker--offline');
    expect(couleurOf(el)).toBe(ACCIDENT_MARKER_COLOR.toLowerCase());
    expect(labelOf(el)).toBe('KSR-370 · accidenté');
    expect(el.getAttribute('aria-label')).toBe('Vehicule KSR-370, accidenté');
  });

  it('🔴 une seule déclaration habille la pastille : débranché, puis accidenté, puis immobilisé', () => {
    const tous = buildVehicleMarkerEl(data({ unplugged: true, accident: true, immobilized: true }));
    expect(tous.classList).toContain('tracky-marker--debranche');
    expect(tous.classList).not.toContain('tracky-marker--accidente');
    expect(tous.classList).not.toContain('tracky-marker--immobilise');

    const deux = buildVehicleMarkerEl(data({ accident: true, immobilized: true }));
    expect(deux.classList).toContain('tracky-marker--accidente');
    expect(deux.classList).not.toContain('tracky-marker--immobilise');
    expect(labelOf(deux)).toBe('KSR-370 · accidenté');
  });

  it('se pose puis se lève EN DIRECT, sans reconstruire la pastille', () => {
    const el = buildVehicleMarkerEl(data({ speedKmh: 25, ignition: true }));
    const svg = el.querySelector('svg');
    updateVehicleMarkerEl(el, data({ speedKmh: 25, ignition: true, accident: true }));
    expect(el.classList).toContain('tracky-marker--accidente');
    expect(labelOf(el)).toBe('KSR-370 · accidenté');

    updateVehicleMarkerEl(el, data({ speedKmh: 25, ignition: true }));
    expect(el.classList).not.toContain('tracky-marker--accidente');
    expect(labelOf(el)).toBe('KSR-370 · 25');
    expect(el.querySelector('svg')).toBe(svg);
  });

  it('porte le triangle dès la création, sur TOUS les marqueurs, et la couleur de la palette', () => {
    for (const accident of [true, false]) {
      const el = buildVehicleMarkerEl(data({ accident }));
      for (const sel of ['.tracky-marker__accident', '.tracky-marker__accident-anneau', '.tracky-marker__accident-triangle', '.tracky-marker__accident-signe']) {
        expect(el.querySelector(sel)).withContext(`${sel} (accident=${accident})`).not.toBeNull();
      }
      expect(el.style.getPropertyValue('--tracky-accident').toUpperCase()).toBe(COULEURS_CARTE.accidente);
    }
  });

  describe('rendu par la feuille globale', () => {
    const rgb = (hex: string) => {
      const n = hex.replace('#', '');
      return `rgb(${parseInt(n.slice(0, 2), 16)}, ${parseInt(n.slice(2, 4), 16)}, ${parseInt(n.slice(4, 6), 16)})`;
    };
    const style = (el: HTMLElement, sel: string) => getComputedStyle(el.querySelector(sel)!);
    let poses: HTMLElement[] = [];
    const poser = (d: VehicleMarkerData) => {
      const el = buildVehicleMarkerEl(d);
      document.body.appendChild(el);
      poses.push(el);
      return el;
    };
    afterEach(() => { poses.forEach((el) => el.remove()); poses = []; });

    it('montre l’anneau et le triangle MAGENTA, le « ! » blanc, et ni barre ni clé', () => {
      const el = poser(data({ accident: true }));
      expect(style(el, '.tracky-marker__accident').display).not.toBe('none');
      expect(style(el, '.tracky-marker__accident-anneau').stroke).toBe(rgb(COULEURS_CARTE.accidente));
      expect(style(el, '.tracky-marker__accident-triangle').fill).toBe(rgb(COULEURS_CARTE.accidente));
      expect(style(el, '.tracky-marker__accident-signe').stroke).toBe('rgb(255, 255, 255)');
      expect(style(el, '.tracky-marker__barre').display).toBe('none');
      expect(style(el, '.tracky-marker__cle').display).toBe('none');
    });

    it('masque la flèche, le contact, le halo et le logo ; estompe le cœur', () => {
      const el = poser(data({ accident: true, brand: 'Dacia', active: true, ignition: true }));
      for (const sel of ['.tracky-marker__cap', '.tracky-marker__acc', '.tracky-marker__pulse']) {
        expect(style(el, sel).display).withContext(sel).toBe('none');
      }
      const logo = el.querySelector('.tracky-marker__brand');
      if (logo) expect(getComputedStyle(logo).display).toBe('none');
      expect(Number(style(el, '.tracky-marker__coeur').fillOpacity)).toBeCloseTo(0.55, 2);
    });

    it('ne montre AUCUN triangle sur un marqueur ordinaire', () => {
      const el = poser(data({ speedKmh: 30, ignition: true }));
      expect(style(el, '.tracky-marker__accident').display).toBe('none');
    });
  });
});
