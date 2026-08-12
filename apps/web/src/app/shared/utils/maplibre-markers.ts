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

function canalLineaire(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Luminance relative WCAG d'un hexadécimal `#rrggbb`. */
function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  return 0.2126 * canalLineaire(r) + 0.7152 * canalLineaire(g) + 0.0722 * canalLineaire(b);
}

/**
 * L'ENCRE de l'icône, posée sur le fond coloré de la pastille.
 *
 * La planche pose une encre très sombre sur ses fonds vifs (`#04130D` sur le vert,
 * `#1A1204` sur l'ambre) — et elle a raison : du blanc sur `#10E0A0` donne **1,72:1**,
 * l'encre sombre **10,44:1**. Mesuré au navigateur le 2026-08-12.
 *
 * ⚠️ Mais une encre sombre FIXE ne convient pas à toute la palette : sur `#5C746C`
 * (la couleur « à l'arrêt », déjà sombre), elle retombe à **3,85** alors que le blanc
 * y donnait **5,04**. C'est une RÉGRESSION que la planche ne pouvait pas voir — elle
 * ne montre que des véhicules en mouvement.
 *
 * D'où le choix par LUMINANCE, et non par principe : la teinte sombre sur les fonds
 * clairs, le blanc sur les fonds sombres. `marker-ink.spec` vérifie que les six
 * couleurs de la palette passent 4,5:1.
 */
export function markerInk(color: string): string {
  const l = luminance(color);
  if (l < 0.18) return '#FFFFFF';
  // Teinte très sombre de la couleur ELLE-MÊME (12 %), comme la planche.
  const h = color.replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const mix = (i: number) => Math.round(parseInt(n.slice(i, i + 2), 16) * 0.12).toString(16).padStart(2, '0');
  return `#${mix(0)}${mix(2)}${mix(4)}`;
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
/**
 * La télémétrie de ce véhicule est-elle PÉRIMÉE ? (hors-ligne, GPS perdu, garé sous terre)
 *
 * Dans ces trois cas la dernière trame peut dater de plusieurs jours : sa vitesse ET son état de
 * contact sont des souvenirs, pas un état courant. On ne doit donc RIEN en affirmer — cf.
 * `accState()`.
 */
function isStale(data: VehicleMarkerData): boolean {
  return !!(data.offline || data.gpsLost || data.parkedDeadZone);
}

/**
 * État affiché du contact (ACC).
 *
 * ⚠️ Incident FS-253 (2026-07-20) : un véhicule garé dans un parking souterrain depuis 5 jours
 * affichait une pastille VERTE « contact mis » — parce que sa dernière trame, vieille de 5 jours,
 * disait `ignition: true`. Le cœur du marqueur passait bien en gris, mais la pastille continuait
 * d'affirmer que le véhicule tournait.
 *
 * Règle : quand la télémétrie est périmée, l'état du contact est **INCONNU**. On ne dit ni
 * « allumé » (mensonge) ni « éteint » (affirmation tout aussi infondée) — on l'affiche en neutre.
 */
function accState(data: VehicleMarkerData): 'on' | 'off' | 'unknown' {
  if (isStale(data)) return 'unknown';
  return data.ignition ? 'on' : 'off';
}

/**
 * La vitesse AFFICHÉE du marqueur — arrondie, et unique.
 *
 * ⚠️ Elle sert à la fois à la COULEUR et à l'ÉTIQUETTE. Relevé au navigateur le
 * 2026-08-12 : une pastille VERTE portait « TE001ST · 0 ». À 0,4 km/h, `speedColor`
 * répond « en mouvement » (> 0) alors que l'étiquette arrondit à « 0 » — le même
 * marqueur disait deux choses. On arrondit donc AVANT de choisir la couleur.
 */
function vitesseAffichee(data: VehicleMarkerData): number {
  return Math.round(data.colorSpeedKmh ?? data.speedKmh ?? 0);
}

function markerColor(data: VehicleMarkerData): string {
  if (data.parkedDeadZone) return OFFLINE_MARKER_COLOR;
  if (data.gpsLost) return GPS_LOST_MARKER_COLOR;
  return data.offline ? OFFLINE_MARKER_COLOR : speedColor(vitesseAffichee(data));
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
 * Ce que dit l'étiquette sous la pastille : « FT-108-XR · 48 » (planche Carte).
 *
 * ⚠️ Hors direct, la vitesse est un SOUVENIR — c'est l'incident FS-253. La planche
 * l'écrit elle-même : « AZ-330-PB · **hors ligne** », pas « AZ-330-PB · 88 ». On ne
 * met donc un chiffre que quand la télémétrie est fraîche.
 */
export function plateLabel(data: VehicleMarkerData): string {
  if (!data.plate) return '';
  if (isStale(data)) return `${data.plate} · hors ligne`;
  // ⚠️ LA MÊME vitesse que celle qui donne la COULEUR — cf. `vitesseAffichee`.
  // Relevé au navigateur le 2026-08-12 : une pastille ROUGE portait « TE002ST · 18 »
  // parce que la teinte lisait `colorSpeedKmh` et le chiffre `speedKmh`.
  return `${data.plate} · ${vitesseAffichee(data)}`;
}

/**
 * Cree l'element d'un marker vehicule.
 *
 * ⚠️ REPRIS EN SVG le 2026-08-12 (ligne B1 « pastilles de véhicule redessinées »).
 * La pastille était une pile de quatre div aux formes dessinées en CSS (bordures,
 * triangle en `border-*`, `box-shadow`). Elle est maintenant UN SVG : anneau,
 * flèche de cap, cœur, indicateur de contact et icône y sont des formes, nettes à
 * toute densité d'écran et décrites au même endroit.
 *
 * Trois décisions de la planche, et non ses valeurs :
 *
 * 1. **La couleur est portée UNE FOIS** par le conteneur (`--tracky-color` →
 *    `color`), et toutes les formes la reprennent en `currentColor`. Avant, elle
 *    était recopiée dans un style en ligne du cœur ET dans le triangle CSS.
 * 2. **L'icône passe en ENCRE SOMBRE** sur le fond vif, au lieu du blanc. Du blanc
 *    sur `#10E0A0` est illisible ; la planche pose `#04130D` sur le vert et
 *    `#1A1204` sur l'ambre — une teinte très sombre de la couleur elle-même, ce que
 *    la feuille reproduit en `color-mix`.
 * 3. **Pas de flèche de cap quand la position est figée** : un véhicule hors ligne
 *    ou GPS perdu n'a pas de direction à montrer. La planche omet le repère
 *    directionnel sur `AZ-330-PB · hors ligne`.
 *
 * L'étiquette (texte) et le logo de marque (image) restent en HTML : ils ne gagnent
 * rien à passer en SVG et y perdraient le rendu de police et l'ellipse.
 */
export function buildVehicleMarkerEl(data: VehicleMarkerData): HTMLElement {
  const color = markerColor(data);
  const ignClass = `tracky-acc--${accState(data)}`;
  const activeClass = data.active ? 'tracky-marker--active' : '';
  const hydClass = data.hydrated ? 'tracky-marker--hydrated' : '';
  const offlineClass = data.offline || data.gpsLost || data.parkedDeadZone ? 'tracky-marker--offline' : '';
  const isArrow = data.type === 'OTHER';
  const headingDeg = Math.round(data.heading || 0);
  const svgContent = getVehicleSvg(data.type);
  const brandInfo = findBrand(data.brand);
  const logoUrl = brandInfo ? `logos/brands/${brandInfo.slug}.png` : null;
  const brandDarkClass = brandInfo?.darkBg ? ' tracky-marker__brand--dark' : '';

  // Pour les types vehicule (CAR, TRUCK, etc.), l'icone reste droite : seule la
  // fleche de cap pivote. Pour OTHER, l'icone EST la fleche et doit pivoter aussi.
  const iconRotate = isArrow ? `rotate(${headingDeg} 12 12)` : '';

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
  el.style.setProperty('--tracky-ink', markerInk(color));
  el.style.setProperty('--tracky-heading', `${headingDeg}deg`);
  el.innerHTML = `
    <svg class="tracky-marker__pastille" viewBox="0 0 56 56" width="56" height="56"
         aria-hidden="true" focusable="false">
      <circle class="tracky-marker__pulse" cx="28" cy="28" r="18" fill="currentColor" />
      <g class="tracky-marker__cap">
        <path class="tracky-marker__fleche" d="M28 2.5 L33.4 13 L22.6 13 Z" fill="currentColor" />
      </g>
      <circle class="tracky-marker__anneau" cx="28" cy="28" r="23" fill="none" />
      <circle class="tracky-marker__coeur" cx="28" cy="28" r="15" fill="currentColor" />
      <g class="tracky-marker__icone" transform="translate(18 18) scale(0.8333)">
        <g transform="${iconRotate}" fill="none" stroke-width="1.8"
           stroke-linecap="round" stroke-linejoin="round">${svgContent}</g>
      </g>
      <circle class="tracky-marker__acc ${ignClass}" cx="40.5" cy="40.5" r="5" />
    </svg>
    ${logoUrl ? `<div class="tracky-marker__brand${brandDarkClass}"><img src="${escapeHtml(logoUrl)}" alt="" /></div>` : ''}
    ${data.plate ? `<div class="tracky-marker__plate">${escapeHtml(plateLabel(data))}</div>` : ''}
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
 * - couleur (une seule écriture : `--tracky-color` sur le conteneur)
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
  // Une SEULE écriture de couleur : toutes les formes du SVG la reprennent en
  // currentColor. Avant, il fallait aussi repeindre le fond du cœur à la main —
  // et un oubli laissait la pastille d'une couleur et sa flèche d'une autre.
  el.style.setProperty('--tracky-color', color);
  el.style.setProperty('--tracky-ink', markerInk(color));
  el.style.setProperty('--tracky-heading', `${headingDeg}deg`);

  // Pour OTHER, l'icone EST la fleche : elle pivote. Pour les autres, elle reste droite.
  const isArrow = data.type === 'OTHER';
  const icone = el.querySelector<SVGGElement>('.tracky-marker__icone > g');
  if (icone) {
    // Le type a-t-il changé depuis le dernier rendu ? (typiquement : OTHER → CAR/VAN/TRUCK)
    const rendered = el.getAttribute('data-vehicle-type') ?? '';
    const current = data.type ?? '';
    if (rendered !== current) {
      icone.innerHTML = getVehicleSvg(current);
      el.setAttribute('data-vehicle-type', current);
    }
    if (isArrow) icone.setAttribute('transform', `rotate(${headingDeg} 12 12)`);
    else icone.removeAttribute('transform');
  }

  // La plaque aussi peut arriver après coup (même course WebSocket/HTTP). Elle peut même être
  // ABSENTE du DOM si le marqueur a été créé sans plaque → on la crée alors.
  if (data.plate) {
    const libelle = plateLabel(data);
    const plateEl = el.querySelector<HTMLElement>('.tracky-marker__plate');
    if (!plateEl) {
      const created = document.createElement('div');
      created.className = 'tracky-marker__plate';
      created.textContent = libelle;
      el.appendChild(created);
    } else if (plateEl.textContent !== libelle) {
      plateEl.textContent = libelle;
    }
    // L'étiquette porte la vitesse, qui change à chaque trame ; le nom accessible ne
    // doit PAS la suivre, sinon un lecteur d'écran réannonce le marqueur en boucle.
    if (el.getAttribute('aria-label') !== `Vehicule ${data.plate}`) {
      el.setAttribute('aria-label', `Vehicule ${data.plate}`);
    }
  }

  const acc = el.querySelector('.tracky-marker__acc');
  if (acc) {
    const state = accState(data);
    acc.classList.toggle('tracky-acc--on', state === 'on');
    acc.classList.toggle('tracky-acc--off', state === 'off');
    acc.classList.toggle('tracky-acc--unknown', state === 'unknown');
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
  //
  // z-index 950 — « les véhicules restent toujours au premier plan » (planche Carte,
  // § Calques & lisibilité). Les repères de lieux montaient jusqu'à 900 et passaient
  // donc DEVANT le véhicule : sur une carte de supervision, ce qu'on surveille prime
  // sur le décor. C'est le WRAPPER qui doit le porter, pas `.tracky-marker` : MapLibre
  // positionne le wrapper, et un z-index posé sur l'enfant ne joue que dans le
  // contexte d'empilement de celui-ci.
  wrapper.style.cssText = 'will-change:transform;z-index:950';
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
