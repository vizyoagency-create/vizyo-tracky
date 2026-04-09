import * as L from 'leaflet';

export function speedColor(speed: number): string {
  if (speed <= 0) return '#5C746C';
  if (speed <= 50) return '#10E0A0';
  if (speed <= 90) return '#F59E0B';
  return '#EF4444';
}

export function createTrackyIcon(speed: number, heading = 0): L.DivIcon {
  const color = speedColor(speed);
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:44px;height:44px">
      <div style="position:absolute;inset:-4px;border-radius:9999px;background:${color};opacity:0.3;animation:tracky-ping 1.5s cubic-bezier(0,0,0.2,1) infinite"></div>
      <div style="position:relative;width:44px;height:44px;border-radius:9999px;display:flex;align-items:center;justify-content:center;background:${color};border:3px solid white;box-shadow:0 2px 8px rgba(0,0,0,0.4),0 0 20px ${color}60">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="white" style="transform:rotate(${Math.round(heading)}deg);filter:drop-shadow(0 1px 2px rgba(0,0,0,0.3))">
          <path d="M12 2 L5 20 L12 15 L19 20 Z"/>
        </svg>
      </div>
    </div>`,
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });
}
