import { Injectable, Logger } from '@nestjs/common';
import * as geoip from 'geoip-lite';

export interface GeoLocation {
  lat: number | null;
  lng: number | null;
  city: string | null;
  region: string | null;
  country: string | null;
}

const EMPTY: GeoLocation = { lat: null, lng: null, city: null, region: null, country: null };

/**
 * Géolocalisation d'une IP au niveau ville/région, via une base LOCALE (geoip-lite,
 * données MaxMind GeoLite2 embarquées) : AUCUNE donnée n'est envoyée à un tiers.
 * Suffisant pour « zone de connexion habituelle » et la carte admin. Renvoie des
 * champs nuls pour une IP privée / non localisable.
 */
@Injectable()
export class GeoipService {
  private readonly logger = new Logger(GeoipService.name);

  lookup(ip: string | null | undefined): GeoLocation {
    if (!ip) return EMPTY;
    // Normalise IPv4-mapped IPv6 (::ffff:x.x.x.x), enlève un éventuel zone-id/port.
    const clean = ip.replace(/^::ffff:/i, '').split('%')[0].split(',')[0].trim();
    if (!clean || clean === '::1' || isPrivateOrLocal(clean)) return EMPTY;
    try {
      const r = geoip.lookup(clean);
      if (!r) return EMPTY;
      const ll = Array.isArray(r.ll) ? r.ll : [null, null];
      return {
        lat: typeof ll[0] === 'number' ? ll[0] : null,
        lng: typeof ll[1] === 'number' ? ll[1] : null,
        city: r.city || null,
        region: r.region || null,
        country: r.country || null,
      };
    } catch (e) {
      this.logger.warn(`geoip lookup a échoué: ${String(e)}`);
      return EMPTY;
    }
  }
}

function isPrivateOrLocal(ip: string): boolean {
  return (
    /^127\./.test(ip) ||
    /^10\./.test(ip) ||
    /^192\.168\./.test(ip) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ||
    /^169\.254\./.test(ip) ||
    ip.startsWith('fc') ||
    ip.startsWith('fd') ||
    ip.startsWith('fe80')
  );
}
