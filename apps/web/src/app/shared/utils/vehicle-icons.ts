/**
 * Vehicle type SVG icons (viewBox 0 0 24 24, fill)
 * Designed to be displayed white on colored background in Leaflet markers
 */

export interface VehicleTypeInfo {
  key: string;
  label: string;
  svg: string; // SVG path(s) inside viewBox="0 0 24 24"
}

export const VEHICLE_TYPES: VehicleTypeInfo[] = [
  {
    key: 'CAR',
    label: 'Voiture',
    svg: '<path d="M19 17h2l.5-2h-1.2L18 7H6L3.7 15H2.5L3 17h2m14 0H5m14 0a2 2 0 100-4 2 2 0 000 4M5 17a2 2 0 100-4 2 2 0 000 4"/><path d="M5 13h14l-1.5-6h-11L5 13z"/>',
  },
  {
    key: 'TRUCK',
    label: 'Camion',
    svg: '<path d="M1 12h15V5H1v7zm15 0h5l3 4v3h-2m-6-7v7m-6 0H4m12 0a2 2 0 100-4 2 2 0 000 4M7 19a2 2 0 100-4 2 2 0 000 4"/><rect x="1" y="5" width="15" height="7" rx="1"/>',
  },
  {
    key: 'VAN',
    label: 'Camionnette',
    svg: '<path d="M3 17h1m16 0h1V12l-3-5H5V17m0 0a2 2 0 104 0M5 17a2 2 0 114 0m0 0h6m0 0a2 2 0 104 0m-4 0a2 2 0 114 0"/>',
  },
  {
    key: 'MOTORCYCLE',
    label: 'Moto',
    svg: '<circle cx="5" cy="17" r="3"/><circle cx="19" cy="17" r="3"/><path d="M5 14l4-7h4l2 3h4M9 7l3 7m5 0l-2-3"/>',
  },
  {
    key: 'BICYCLE',
    label: 'Velo',
    svg: '<circle cx="6" cy="17" r="3"/><circle cx="18" cy="17" r="3"/><path d="M6 17l3-7h6l3 7M12 5l-3 5m3-5l3 5m-3-5v2"/>',
  },
  {
    key: 'BUS',
    label: 'Bus',
    svg: '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M3 10h18M7 18v2m10-2v2M7 7h0m4 0h0m4 0h0m4 0h0"/><circle cx="7" cy="15" r="1"/><circle cx="17" cy="15" r="1"/>',
  },
  {
    key: 'CONSTRUCTION',
    label: 'Engin',
    svg: '<path d="M5 18h3m8 0h3M7 18a2 2 0 104 0H7zm6 0a2 2 0 104 0h-4z"/><path d="M5 14V8l3-3h4l2 3h4v6"/><path d="M14 8l4 0v6"/>',
  },
  {
    key: 'OTHER',
    label: 'Autre',
    svg: '<path d="M12 2 L5 20 L12 15 L19 20 Z"/>',
  },
];

/** Récupérer le SVG path(s) pour un type de véhicule */
export function getVehicleSvg(type: string): string {
  return VEHICLE_TYPES.find((t) => t.key === type)?.svg ?? VEHICLE_TYPES[VEHICLE_TYPES.length - 1].svg;
}

/** Récupérer le label pour un type */
export function getVehicleTypeLabel(type: string): string {
  return VEHICLE_TYPES.find((t) => t.key === type)?.label ?? 'Autre';
}
