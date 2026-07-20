import { buildVehicleMarkerEl, updateVehicleMarkerEl, type VehicleMarkerData } from './maplibre-markers';
import { getVehicleSvg } from './vehicle-icons';

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
  const iconOf = (el: HTMLElement) => el.querySelector('.tracky-marker__core svg')!.innerHTML.trim();

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
    const svg = el.querySelector('.tracky-marker__core svg')!;
    const before = svg.innerHTML;

    updateVehicleMarkerEl(el, data({ type: 'CAR', speedKmh: 50, heading: 90 }));

    expect(svg.innerHTML).toBe(before);
    expect(el.querySelector('.tracky-marker__core svg')).toBe(svg); // même nœud, pas de recréation
  });

  it('ne fait pivoter l\'icône que pour la flèche (une voiture doit rester droite)', () => {
    const car = buildVehicleMarkerEl(data({ type: 'CAR' }));
    updateVehicleMarkerEl(car, data({ type: 'CAR', heading: 135 }));
    expect((car.querySelector('.tracky-marker__core svg') as HTMLElement).style.transform).toBe('none');

    const other = buildVehicleMarkerEl(data({ type: 'OTHER' }));
    updateVehicleMarkerEl(other, data({ type: 'OTHER', heading: 135 }));
    expect((other.querySelector('.tracky-marker__core svg') as HTMLElement).style.transform).toContain('135deg');
  });

  it('affiche la plaque quand elle arrive après la création du marqueur', () => {
    const el = buildVehicleMarkerEl(data()); // créé sans plaque → pas d'élément plaque
    expect(el.querySelector('.tracky-marker__plate')).toBeNull();

    updateVehicleMarkerEl(el, data({ plate: 'GS-138-LT' }));

    expect(el.querySelector('.tracky-marker__plate')!.textContent).toBe('GS-138-LT');
    expect(el.getAttribute('aria-label')).toBe('Vehicule GS-138-LT');
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
