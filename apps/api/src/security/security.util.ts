/** Distance en km entre deux points (formule de haversine). */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Masque l'e-mail : « y•••@gmail.com » — assez pour reconnaître sa boîte sans l'exposer. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '•••';
  const at = email.indexOf('@');
  if (at < 1) return '•••';
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const head = local.slice(0, 1);
  const dots = '•'.repeat(Math.max(2, Math.min(local.length - 1, 5)));
  return `${head}${dots}@${domain}`;
}

/** Libellé lisible d'un appareil à partir du User-Agent (best-effort). */
export function deviceLabelFromUa(uaStr: string | null | undefined): string | null {
  if (!uaStr) return null;
  const browser = /Edg/.test(uaStr)
    ? 'Edge'
    : /Chrome|CriOS/.test(uaStr)
      ? 'Chrome'
      : /Firefox|FxiOS/.test(uaStr)
        ? 'Firefox'
        : /Safari/.test(uaStr)
          ? 'Safari'
          : 'Navigateur';
  const os = /Windows/.test(uaStr)
    ? 'Windows'
    : /Android/.test(uaStr)
      ? 'Android'
      : /iPhone|iPad|iOS/.test(uaStr)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(uaStr)
          ? 'Mac'
          : /Linux/.test(uaStr)
            ? 'Linux'
            : '';
  return os ? `${browser} · ${os}` : browser;
}
