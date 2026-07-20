import * as maplibregl from 'maplibre-gl';
import type { Map as MlMap, Marker as MlMarker } from 'maplibre-gl';
import { getVehicleSvg } from './vehicle-icons';
import { findBrand } from './vehicle-brands';

export function speedColor(speed: number): string {
  if (speed <= 0) return '#5C746C';
  if (speed <= 50) return '#10E0A0';
  if (speed <= 90) return '#F59E0B';
  return '#EF4444';
}

/** Couleur d'un marqueur hors-ligne (cf. légende carte « Hors-ligne »). */
export const OFFLINE_MARKER_COLOR = '#9ca3af';
/** Incident FS-253 — couleur « GPS perdu » (boîtier vivant mais sans position fraîche). Rouge
 *  = à traiter, distinct du gris hors-ligne ET du vert-vitesse (on ne le montre PAS comme actif). */
export const GPS_LOST_MARKER_COLOR = '#ef4444';

/**
 * Couleur de fond du cœur du marqueur :
 * parking souterrain confirmé (gris « à l'arrêt ») > GPS perdu réel (rouge) > hors-ligne (gris) > couleur-vitesse.
 * Le parking souterrain confirmé PRIME sur le rouge : c'est une perte GPS NORMALE (véhicule garé sous terre),
 * on ne l'affiche donc PAS en rouge alarmant mais en gris « éteint », comme demandé.
 */
function markerColor(data: VehicleMarkerData): string {
  if (data.parkedDeadZone) return OFFLINE_MARKER_COLOR;
  if (data.gpsLost) return GPS_LOST_MARKER_COLOR;
  return data.offline ? OFFLINE_MARKER_COLOR : speedColor(data.colorSpeedKmh ?? data.speedKmh);
}

export interface VehicleMarkerData {
  trackerId: string;
  vehicleId: string;
  type: string;
  plate?: string;
  /** Marque (texte libre). Sert à afficher le logo de marque sur le marqueur. */
  brand?: string | null;
  speedKmh: number;
  heading: number;
  ignition: boolean;
  active?: boolean;
  /** Vrai si la position vient d'une hydratation REST (pas d'un live WS). */
  hydrated?: boolean;
  /**
   * Vrai si le boîtier est hors-ligne (dernier signal trop ancien). Le marqueur
   * est alors rendu en GRIS (couleur « hors-ligne » de la légende) et estompé,
   * au lieu de la couleur-vitesse — sinon un véhicule débranché reste affiché en
   * vert « actif » à sa dernière position connue.
   */
  offline?: boolean;
  /**
   * Incident FS-253 — boîtier VIVANT mais sans position GPS fraîche (« GPS perdu »). Le marqueur
   * est rendu en ROUGE et estompé (comme hors-ligne) : sa position est FIGÉE, il ne « roule » pas.
   */
  gpsLost?: boolean;
  /**
   * Zones mortes GPS (2026-07) — véhicule GPS-perdu MAIS dans un parking souterrain CONFIRMÉ.
   * Rendu en GRIS « à l'arrêt / éteint » (pas en rouge) : la perte de GPS y est normale.
   */
  parkedDeadZone?: boolean;
  /**
   * Vitesse (km/h) a utiliser pour la COULEUR uniquement. Permet d'afficher une
   * couleur de mouvement (vert/orange) basee sur la vitesse robuste derivee du
   * deplacement, meme quand le boitier rapporte `speedKmh = 0` en roulant
   * (sinon le marker flashe en gris). Defaut : `speedKmh`.
   */
  colorSpeedKmh?: number;
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
  const color = markerColor(data);
  const ignClass = data.ignition ? 'tracky-acc--on' : 'tracky-acc--off';
  const activeClass = data.active ? 'tracky-marker--active' : '';
  const hydClass = data.hydrated ? 'tracky-marker--hydrated' : '';
  const offlineClass = data.offline || data.gpsLost || data.parkedDeadZone ? 'tracky-marker--offline' : '';
  const isArrow = data.type === 'OTHER';
  const headingDeg = Math.round(data.heading || 0);
  const svgContent = getVehicleSvg(data.type);
  const brandInfo = findBrand(data.brand);
  const logoUrl = brandInfo ? `logos/brands/${brandInfo.slug}.png` : null;
  const brandDarkClass = brandInfo?.darkBg ? ' tracky-marker__brand--dark' : '';

  // Pour les types vehicule (CAR, TRUCK, etc.), l'icone reste droite : on pivote
  // uniquement la fleche externe (.tracky-marker__heading-ring). Pour OTHER,
  // l'icone interne pivote aussi pour que la fleche pointe le sens de marche.
  const iconRotate = isArrow ? `rotate(${headingDeg}deg)` : 'none';

  const el = document.createElement('div');
  el.className = `tracky-marker ${activeClass} ${hydClass} ${offlineClass}`.replace(/\s+/g, ' ').trim();
  el.setAttribute('role', 'button');
  el.setAttribute('aria-label', data.plate ? `Vehicule ${data.plate}` : 'Vehicule');
  el.setAttribute('data-tracker-id', data.trackerId);
  el.setAttribute('data-vehicle-id', data.vehicleId);
  // Type RENDU (≠ type courant) : permet à updateVehicleMarkerEl de détecter qu'il doit
  // redessiner l'icône. Cf. le bug corrigé dans cette fonction de mise à jour.
  el.setAttribute('data-vehicle-type', data.type ?? '');
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
    ${logoUrl ? `<div class="tracky-marker__brand${brandDarkClass}"><img src="${escapeHtml(logoUrl)}" alt="" /></div>` : ''}
    ${data.plate ? `<div class="tracky-marker__plate">${escapeHtml(data.plate)}</div>` : ''}
  `;
  // Si le PNG du logo n'existe pas (pas encore exporté), on retire le badge au
  // lieu d'afficher une image cassée. Pas de handler inline (compat CSP).
  const logoImg = el.querySelector<HTMLImageElement>('.tracky-marker__brand img');
  if (logoImg) {
    logoImg.addEventListener('error', () => {
      logoImg.closest('.tracky-marker__brand')?.remove();
    });
  }
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
 * ⚠️ Le TYPE peut changer après coup : les positions arrivent par WebSocket (rapide) alors que la
 * fiche véhicule vient d'un appel HTTP. Un marqueur est donc souvent créé AVANT de connaître son
 * type, avec le repli « OTHER » (flèche). Cette fonction doit donc redessiner l'icône quand le type
 * arrive — sans ça (bug 2026-07-20) toute la flotte restait en flèches jusqu'au rechargement de la
 * page, alors que les véhicules étaient bien typés en base.
 */
export function updateVehicleMarkerEl(el: HTMLElement, data: VehicleMarkerData): void {
  const color = markerColor(data);
  const headingDeg = Math.round(data.heading || 0);
  el.style.setProperty('--tracky-color', color);
  el.style.setProperty('--tracky-heading', `${headingDeg}deg`);

  const core = el.querySelector<HTMLElement>('.tracky-marker__core');
  if (core) core.style.background = color;

  // Pour OTHER, on pivote aussi l'icone interne. Pour les autres, on garde droite.
  const isArrow = data.type === 'OTHER';
  const svg = el.querySelector<SVGElement>('.tracky-marker__core svg');
  if (svg) {
    // Le type a-t-il changé depuis le dernier rendu ? (typiquement : OTHER → CAR/VAN/TRUCK)
    const rendered = el.getAttribute('data-vehicle-type') ?? '';
    const current = data.type ?? '';
    if (rendered !== current) {
      svg.innerHTML = getVehicleSvg(current);
      el.setAttribute('data-vehicle-type', current);
    }
    (svg as unknown as HTMLElement).style.transform = isArrow ? `rotate(${headingDeg}deg)` : 'none';
  }

  // La plaque aussi peut arriver après coup (même course WebSocket/HTTP). Elle peut même être
  // ABSENTE du DOM si le marqueur a été créé sans plaque → on la crée alors.
  if (data.plate) {
    const plateEl = el.querySelector<HTMLElement>('.tracky-marker__plate');
    if (!plateEl) {
      const created = document.createElement('div');
      created.className = 'tracky-marker__plate';
      created.textContent = data.plate;
      el.appendChild(created);
      el.setAttribute('aria-label', `Vehicule ${data.plate}`);
    } else if (plateEl.textContent !== data.plate) {
      plateEl.textContent = data.plate;
      el.setAttribute('aria-label', `Vehicule ${data.plate}`);
    }
  }

  const acc = el.querySelector('.tracky-marker__acc');
  if (acc) {
    acc.classList.toggle('tracky-acc--on', data.ignition);
    acc.classList.toggle('tracky-acc--off', !data.ignition);
  }

  el.classList.toggle('tracky-marker--active', !!data.active);
  el.classList.toggle('tracky-marker--hydrated', !!data.hydrated);
  el.classList.toggle('tracky-marker--offline', !!(data.offline || data.gpsLost || data.parkedDeadZone));
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
