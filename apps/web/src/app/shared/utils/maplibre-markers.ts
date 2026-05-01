import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import { getVehicleSvg } from './vehicle-icons';

export function speedColor(speed: number): string {
  if (speed <= 0) return '#5C746C';
  if (speed <= 50) return '#10E0A0';
  if (speed <= 90) return '#F59E0B';
  return '#EF4444';
}

export interface VehicleMarkerData {
  trackerId: string;
  vehicleId: string;
  type: string;
  plate?: string;
  speedKmh: number;
  heading: number;
  ignition: boolean;
  active?: boolean;
  /** Vrai si la position vient d'une hydratation REST (pas d'un live WS). */
  hydrated?: boolean;
}

/**
 * Cree l'element HTML d'un marker vehicule.
 *
 * Architecture en deux couches :
 * - couche externe (`.tracky-marker`) : tournee selon le heading via `transform`.
 * - couche interne (icone vehicule) : compense la rotation pour rester droite,
 *   sauf pour le type OTHER (fleche) qui DOIT pivoter.
 *
 * Pulse anime en CSS pour le vehicule actif (suivi).
 * Indicateur ACC ON/OFF en bas a droite.
 * Plaque flottante en dessous (masquable par CSS .tracky-marker--no-plate).
 */
export function buildVehicleMarkerEl(data: VehicleMarkerData): HTMLElement {
  const color = speedColor(data.speedKmh);
  const ignClass = data.ignition ? 'tracky-acc--on' : 'tracky-acc--off';
  const activeClass = data.active ? 'tracky-marker--active' : '';
  const hydClass = data.hydrated ? 'tracky-marker--hydrated' : '';
  const isArrow = data.type === 'OTHER';
  const headingDeg = Math.round(data.heading || 0);
  const svgContent = getVehicleSvg(data.type);

  // Pour les types vehicule (CAR, TRUCK, etc.), l'icone reste droite : on pivote
  // uniquement la fleche externe (.tracky-marker__heading-ring). Pour OTHER,
  // l'icone interne pivote aussi pour que la fleche pointe le sens de marche.
  const iconRotate = isArrow ? `rotate(${headingDeg}deg)` : 'none';

  const el = document.createElement('div');
  el.className = `tracky-marker ${activeClass} ${hydClass}`.trim();
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', data.plate ? `Vehicule ${data.plate}` : 'Vehicule');
  el.setAttribute('data-tracker-id', data.trackerId);
  el.setAttribute('data-vehicle-id', data.vehicleId);
  el.style.setProperty('--tracky-color', color);
  el.style.setProperty('--tracky-heading', `${headingDeg}deg`);
  el.innerHTML = `
    <div class="tracky-marker__pulse"></div>
    <div class="tracky-marker__heading-ring"></div>
    <div class="tracky-marker__core" style="background:${color}">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none"
           stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
           style="transform:${iconRotate};filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3))">
        ${svgContent}
      </svg>
    </div>
    <div class="tracky-marker__acc ${ignClass}"></div>
    ${data.plate ? `<div class="tracky-marker__plate">${escapeHtml(data.plate)}</div>` : ''}
  `;
  return el;
}

/**
 * Met a jour un marker existant sans le recreer (preserve l'animation pulse,
 * la reference DOM, les listeners) :
 * - couleur (fond `tracky-marker__core`)
 * - rotation heading (var CSS `--tracky-heading`)
 * - indicateur ACC
 * - active/hydrated flags
 *
 * Si la plaque ou le type changent, on recree (rare).
 */
export function updateVehicleMarkerEl(el: HTMLElement, data: VehicleMarkerData): void {
  const color = speedColor(data.speedKmh);
  const headingDeg = Math.round(data.heading || 0);
  el.style.setProperty('--tracky-color', color);
  el.style.setProperty('--tracky-heading', `${headingDeg}deg`);

  const core = el.querySelector<HTMLElement>('.tracky-marker__core');
  if (core) core.style.background = color;

  // Pour OTHER, on pivote aussi l'icone interne. Pour les autres, on garde droite.
  const isArrow = data.type === 'OTHER';
  const svg = el.querySelector<SVGElement>('.tracky-marker__core svg');
  if (svg) (svg as unknown as HTMLElement).style.transform = isArrow ? `rotate(${headingDeg}deg)` : 'none';

  const acc = el.querySelector('.tracky-marker__acc');
  if (acc) {
    acc.classList.toggle('tracky-acc--on', data.ignition);
    acc.classList.toggle('tracky-acc--off', !data.ignition);
  }

  el.classList.toggle('tracky-marker--active', !!data.active);
  el.classList.toggle('tracky-marker--hydrated', !!data.hydrated);
}

/**
 * Cree un Marker MapLibre attache a la carte avec l'element vehicule.
 *
 * V1.8 — l'element est wrappe dans un conteneur intermediaire. MapLibre ecrit
 * son `transform: translate(...)` en style INLINE sur l'element qu'on lui passe ;
 * appliquer une transition CSS ou un scale sur ce meme element entre en conflit
 * (le inline transform ecrase le scale, et la transition CSS anime malencontreusement
 * le translate de MapLibre, faisant deriver les markers pendant le zoom et donnant
 * l'impression que les markers ne bougent pas en live).
 *
 * Architecture :
 *   - wrapper (passe a MapLibre) : recoit le translate GPS, dimensions = celles du child
 *   - child .tracky-marker (notre visuel) : libre d'avoir scale, transitions, rotations
 *
 * `rotationAlignment: 'viewport'` garde le marker lisible quand la carte pivote.
 * La rotation visuelle du heading est portee par la couche interne (CSS var).
 */
export function attachVehicleMarker(
  map: MlMap,
  el: HTMLElement,
  lat: number,
  lng: number,
): MlMarker {
  const wrapper = document.createElement('div');
  // Le wrapper hérite naturellement de la taille du child (.tracky-marker = 56x56),
  // ce qui permet a anchor:'center' (translate -50%, -50%) de centrer correctement.
  wrapper.style.cssText = 'will-change:transform';
  wrapper.appendChild(el);
  return new maplibregl.Marker({
    element: wrapper,
    anchor: 'center',
    rotationAlignment: 'viewport',
    pitchAlignment: 'viewport',
    subpixelPositioning: true,
  })
    .setLngLat([lng, lat])
    .addTo(map);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' :
    c === '<' ? '&lt;' :
    c === '>' ? '&gt;' :
    c === '"' ? '&quot;' :
    '&#39;',
  );
}
