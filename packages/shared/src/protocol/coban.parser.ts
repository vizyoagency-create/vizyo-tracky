import type {
  CobanAlarmType,
  CobanFrame,
  CobanNoFixFrame,
  CobanPositionFrame,
  CobanUnknownFrame,
} from './coban.types';
import { knotsToKph, nmeaToDecimal } from './coban.utils';

const LOGIN_RE = /^##,imei:(\d{15}),A$/;
const HEARTBEAT_RE = /^\d{15}$/;

function unknown(raw: string, reason: string): CobanUnknownFrame {
  return { type: 'unknown', raw, reason };
}

/**
 * Trame d'un boîtier VIVANT mais SANS fix GPS valide (flag non-A/V ou coordonnées
 * absentes : rapport LBS sans lock satellite, émis en intérieur / démarrage à froid).
 * Distincte d'`unknown` pour que le dispatcher rafraîchisse lastSeenAt (→ « en attente
 * GPS ») au lieu de la jeter en silence — c'est ce qui rendait ces boîtiers invisibles.
 */
function noFix(imei: string, alarm: CobanAlarmType, deviceTime: Date | null, raw: string): CobanNoFixFrame {
  return { type: 'no_fix', imei, alarm, deviceTime, raw };
}

export function decodeAlarm(value: string): CobanAlarmType {
  const v = value.toLowerCase().trim();
  if (v === 'tracker') return 'none';
  if (v === 'help me') return 'sos';
  if (v === 'low battery') return 'low_battery';
  if (v === 'stockade') return 'geofence';
  if (v === 'move') return 'movement';
  if (v === 'speed') return 'overspeed';
  if (v === 'door alarm') return 'door';
  if (v === 'ac alarm') return 'power_cut';
  if (v === 'accident alarm') return 'accident';
  if (v === 'collision') return 'collision';
  if (v === 'sensor alarm') return 'vibration';
  if (v === 'bonnet alarm') return 'bonnet';
  if (v === 'footbrake alarm') return 'foot_brake';
  if (v === 'brake' || v === 'brake alarm') return 'harsh_braking';
  if (v === 'accelerate') return 'harsh_acceleration';
  if (v === 'sharp turn') return 'harsh_turn';
  if (v === 'tow alarm' || v === 'tow') return 'tow';
  if (v === 'remove alarm' || v === 'pull alarm' || v === 'tamper' || v === 'dt') return 'tamper';
  if (v === 'fatigue alarm' || v === 'fatigue') return 'fatigue';
  if (v === 'illegal ignition alarm' || v === 'illegal ignition') return 'illegal_ignition';
  if (v === 'no data alarm' || v === 'gps dead' || v === 'gps lost') return 'gps_lost';
  if (v === 'idle alarm' || v === 'it' || v === 'idle') return 'idle_alert';
  if (v === 'acc on' || v === 'kt') return 'acc_on';
  if (v === 'acc off' || v === 'jt') return 'acc_off';
  if (v === 'et') return 'low_battery';
  if (v === 'rfid') return 'rfid';
  if (v === 'dtc') return 'dtc';
  if (v.startsWith('t:')) return 'temperature';
  if (v.startsWith('oil')) return 'fuel';
  // Fallback: numbered alarms (1 alarm, 2 alarm, 3 alarm) → vibration sensor variants
  if (/^\d+ alarm$/.test(v)) return 'vibration';
  return 'unknown';
}

function parseLocalDate(raw: string): Date | null {
  if (raw.includes('/')) {
    const match = raw.match(/^(\d{2})\/(\d{2})\/(\d{2})\s*(\d{2})(\d{2})(\d{2})$/);
    if (!match) return null;
    const [, yy, mm, dd, hh, mi, ss] = match;
    return new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss)));
  }
  if (raw.length >= 12) {
    const yy = raw.slice(0, 2);
    const mm = raw.slice(2, 4);
    const dd = raw.slice(4, 6);
    const hh = raw.slice(6, 8);
    const mi = raw.slice(8, 10);
    const ss = raw.slice(10, 12);
    return new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss)));
  }
  return null;
}

const DAY_MS = 86_400_000;

/**
 * Corrige la date d'un timestamp construit en melangeant une DATE locale (champ
 * date du boitier) et une HEURE UTC (champ temps GPS). Autour de minuit, la date
 * UTC peut etre decalee de +/-1 jour par rapport a la date locale. On retient le
 * decalage de jour (-1/0/+1) qui minimise l'ecart a l'heure locale complete —
 * l'offset timezone reel etant forcement le plus petit (< 12h en pratique). #12.
 */
function reconcileUtcDateAroundMidnight(candidate: Date, localFull: Date): Date {
  let best = candidate;
  let bestDelta = Math.abs(candidate.getTime() - localFull.getTime());
  for (const shiftMs of [-DAY_MS, DAY_MS]) {
    const alt = new Date(candidate.getTime() + shiftMs);
    const delta = Math.abs(alt.getTime() - localFull.getTime());
    if (delta < bestDelta) {
      best = alt;
      bestDelta = delta;
    }
  }
  return best;
}

function decodeRegularPosition(raw: string): CobanFrame {
  const parts = raw.split(',');

  if (parts.length < 7) return unknown(raw, 'too_few_fields');

  const imeiField = parts[0];
  if (!imeiField || !imeiField.startsWith('imei:')) return unknown(raw, 'missing_imei_prefix');
  const imei = imeiField.slice(5);
  if (!/^\d{15}$/.test(imei)) return unknown(raw, 'invalid_imei');

  const alarm = decodeAlarm(parts[1] ?? '');
  const localDateRaw = parts[2] ?? '';
  const rfid = parts[3] || undefined;
  const utcTimeRaw = parts[5] ?? '';
  const validFlag = parts[6] ?? '';

  // Pas de flag GPS A/V (souvent 'L' ou vide sur un rapport LBS sans lock satellite) →
  // boîtier vivant mais sans fix : on le signale comme tel plutôt que de le jeter.
  if (validFlag !== 'A' && validFlag !== 'V') return noFix(imei, alarm, parseLocalDate(localDateRaw), raw);

  const latRaw = parts[7] ?? '';
  const latHemi = parts[8] ?? '';
  const lonRaw = parts[9] ?? '';
  const lonHemi = parts[10] ?? '';

  if (!latRaw || !lonRaw) return noFix(imei, alarm, parseLocalDate(localDateRaw), raw);
  if (latHemi !== 'N' && latHemi !== 'S') return unknown(raw, 'invalid_hemisphere');
  if (lonHemi !== 'E' && lonHemi !== 'W') return unknown(raw, 'invalid_hemisphere');

  let latitude: number;
  let longitude: number;
  try {
    latitude = nmeaToDecimal(latRaw, latHemi as 'N' | 'S');
    longitude = nmeaToDecimal(lonRaw, lonHemi as 'E' | 'W');
  } catch {
    return unknown(raw, 'invalid_coordinate_format');
  }

  if (isNaN(latitude) || isNaN(longitude)) return unknown(raw, 'invalid_coordinate_format');

  const speedRaw = (parts[11] ?? '').replace(/[;\s]/g, '');
  const speedKnots = parseFloat(speedRaw);
  const speedKph = isNaN(speedKnots) ? 0 : knotsToKph(speedKnots);

  let deviceTime: Date;
  if (utcTimeRaw && utcTimeRaw.length >= 6) {
    const hh = utcTimeRaw.slice(0, 2);
    const mi = utcTimeRaw.slice(2, 4);
    const ss = utcTimeRaw.slice(4, 6);
    const dateBase = parseLocalDate(localDateRaw);
    if (dateBase) {
      // parts[2] = date+heure LOCALES du boitier ; parts[5] = heure UTC (GPS). On
      // combine la date locale avec l'heure UTC puis on corrige le jour autour de
      // minuit (la date UTC peut differer de la date locale de +/-1 jour). cf #12.
      const candidate = new Date(Date.UTC(
        dateBase.getUTCFullYear(), dateBase.getUTCMonth(), dateBase.getUTCDate(),
        Number(hh), Number(mi), Number(ss),
      ));
      deviceTime = reconcileUtcDateAroundMidnight(candidate, dateBase);
    } else {
      deviceTime = new Date();
    }
  } else {
    const parsed = parseLocalDate(localDateRaw);
    deviceTime = parsed ?? new Date();
  }

  const courseRaw = (parts[12] ?? '').replace(/[;\s]/g, '');
  const altRaw = (parts[13] ?? '').replace(/[;\s]/g, '');

  const result: CobanPositionFrame = {
    type: 'position',
    imei,
    alarm,
    deviceTime,
    valid: validFlag === 'A',
    latitude,
    longitude,
    speedKph,
    raw,
  };

  if (courseRaw) {
    const c = parseFloat(courseRaw);
    if (!isNaN(c)) result.course = c;
  }
  if (altRaw) {
    const a = parseFloat(altRaw);
    if (!isNaN(a)) result.altitude = a;
  }
  if (rfid) result.rfid = rfid;

  const ignRaw = parts[14] ?? '';
  if (ignRaw === '0' || ignRaw === '1') result.ignition = ignRaw === '1';

  const doorRaw = parts[15] ?? '';
  if (doorRaw === '0' || doorRaw === '1') result.door = doorRaw === '1';

  const fuel1Raw = (parts[16] ?? '').replace('%', '');
  if (fuel1Raw) {
    const f = parseFloat(fuel1Raw);
    if (!isNaN(f)) result.fuel1 = f;
  }

  const fuel2Raw = (parts[17] ?? '').replace('%', '');
  if (fuel2Raw) {
    const f = parseFloat(fuel2Raw);
    if (!isNaN(f)) result.fuel2 = f;
  }

  const tempRaw = (parts[18] ?? '').replace(/[;\s]/g, '');
  if (tempRaw) {
    const t = parseFloat(tempRaw);
    if (!isNaN(t)) result.temperature = t;
  }

  return result;
}

function decodeAlternativePosition(raw: string): CobanFrame {
  const cleaned = raw.endsWith('*') ? raw.slice(0, -1) : raw;
  const parts = cleaned.split(',');

  if (parts.length < 12) return unknown(raw, 'alt_too_few_fields');

  const imeiField = parts[0];
  if (!imeiField || !imeiField.startsWith('imei:')) return unknown(raw, 'missing_imei_prefix');
  const imei = imeiField.slice(5);
  if (!/^\d{15}$/.test(imei)) return unknown(raw, 'invalid_imei');

  const alarm = decodeAlarm(parts[2] ?? '');
  const timeRaw = parts[5] ?? '';
  const dateRaw = parts[6] ?? '';

  let deviceTime: Date;
  if (dateRaw.length >= 6 && timeRaw.length >= 6) {
    const dd = dateRaw.slice(0, 2);
    const mm = dateRaw.slice(2, 4);
    const yy = dateRaw.slice(4, 6);
    const hh = timeRaw.slice(0, 2);
    const mi = timeRaw.slice(2, 4);
    const ss = timeRaw.slice(4, 6);
    deviceTime = new Date(Date.UTC(2000 + Number(yy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss)));
  } else {
    deviceTime = new Date();
  }

  const gpsStatus = parts[8] ?? '';
  const valid = gpsStatus === 'A' || gpsStatus.startsWith('A');

  const latRaw = parts[9] ?? '';
  const lonRaw = parts[10] ?? '';
  const latitude = parseFloat(latRaw);
  const longitude = parseFloat(lonRaw);
  if (isNaN(latitude) || isNaN(longitude)) return unknown(raw, 'invalid_coordinate_format');

  const speedKph = parseFloat(parts[11] ?? '0') || 0;

  const result: CobanPositionFrame = {
    type: 'position',
    imei,
    alarm,
    deviceTime,
    valid,
    latitude,
    longitude,
    speedKph,
    raw,
  };

  const courseRaw = parts[12] ?? '';
  if (courseRaw) {
    const c = parseFloat(courseRaw);
    if (!isNaN(c)) result.course = c;
  }

  const altRaw = parts[13] ?? '';
  if (altRaw) {
    const a = parseFloat(altRaw);
    if (!isNaN(a)) result.altitude = a;
  }

  const satRaw = parts[15] ?? '';
  const ignRaw = parts[16] ?? '';
  if (ignRaw === '0' || ignRaw === '1') result.ignition = ignRaw === '1';

  return result;
}

export function decodeFrame(raw: string): CobanFrame {
  const trimmed = raw.trim().replace(/;$/, '').trim();

  if (!trimmed) return unknown(raw, 'empty');

  const loginMatch = trimmed.match(LOGIN_RE);
  if (loginMatch) {
    return { type: 'login', imei: loginMatch[1]!, raw };
  }

  if (HEARTBEAT_RE.test(trimmed)) {
    return { type: 'heartbeat', imei: trimmed, raw };
  }

  if (trimmed.startsWith('imei:')) {
    if (raw.includes('*')) {
      return decodeAlternativePosition(trimmed);
    }
    if (trimmed.includes(',OBD,')) {
      return unknown(raw, 'obd_not_implemented');
    }
    return decodeRegularPosition(trimmed);
  }

  return unknown(raw, 'unrecognized');
}
