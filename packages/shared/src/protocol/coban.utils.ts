export function nmeaToDecimal(value: string, hemisphere: 'N' | 'S' | 'E' | 'W'): number {
  const numeric = parseFloat(value);
  if (isNaN(numeric) || value.trim() === '') {
    throw new Error(`Invalid NMEA coordinate value: "${value}"`);
  }
  const degrees = Math.floor(numeric / 100);
  const minutes = numeric - degrees * 100;
  let decimal = degrees + minutes / 60;
  if (hemisphere === 'S' || hemisphere === 'W') decimal = -decimal;
  return decimal;
}

export function knotsToKph(knots: number): number {
  return Math.round(knots * 1.852 * 1000) / 1000;
}

export function formatFrequency(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  if (hours > 0) return String(hours).padStart(2, '0') + 'h';
  const minutes = Math.floor(seconds / 60);
  if (minutes > 0) return String(minutes).padStart(2, '0') + 'm';
  return String(seconds).padStart(2, '0') + 's';
}
