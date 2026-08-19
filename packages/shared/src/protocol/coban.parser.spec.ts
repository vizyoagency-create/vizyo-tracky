import { decodeFrame, decodeAlarm } from './coban.parser';
import { nmeaToDecimal, knotsToKph } from './coban.utils';
import type { CobanNoFixFrame, CobanPositionFrame, CobanUnknownFrame } from './coban.types';

describe('decodeFrame', () => {
  // 1. Login packet
  it('should parse login packet', () => {
    const f = decodeFrame('##,imei:865328021056352,A;');
    expect(f.type).toBe('login');
    if (f.type === 'login') expect(f.imei).toBe('865328021056352');
  });

  // 2. Heartbeat
  it('should parse naked heartbeat', () => {
    const f = decodeFrame('865328021056352;');
    expect(f.type).toBe('heartbeat');
    if (f.type === 'heartbeat') expect(f.imei).toBe('865328021056352');
  });

  // 3. Real position frame from spec §9.1
  it('should parse real position frame with correct coordinates', () => {
    const raw = 'imei:864035050002451,tracker,201223064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,;';
    const f = decodeFrame(raw);
    expect(f.type).toBe('position');
    const p = f as CobanPositionFrame;
    expect(p.imei).toBe('864035050002451');
    expect(p.alarm).toBe('none');
    expect(p.valid).toBe(true);
    expect(p.latitude).toBeCloseTo(19.595107, 4);
    expect(p.longitude).toBeCloseTo(-98.999073, 4);
    expect(p.speedKph).toBeCloseTo(0.046, 3);
  });

  // 4. Position with SOS alarm
  it('should parse help me alarm as sos', () => {
    const raw = 'imei:864035050002451,help me,201223064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,;';
    const f = decodeFrame(raw) as CobanPositionFrame;
    expect(f.alarm).toBe('sos');
  });

  // 5. Position with valid=V
  it('should parse valid=V as false', () => {
    const raw = 'imei:864035050002451,tracker,201223064947,,F,064947,V,1935.70640,N,09859.94436,W,0.025,;';
    const f = decodeFrame(raw) as CobanPositionFrame;
    expect(f.valid).toBe(false);
  });

  // 6. Southern hemisphere → negative latitude
  it('should produce negative latitude for S hemisphere', () => {
    const raw = 'imei:864035050002451,tracker,201223064947,,F,064947,A,3400.00000,S,09859.94436,W,0.025,;';
    const f = decodeFrame(raw) as CobanPositionFrame;
    expect(f.latitude).toBeLessThan(0);
  });

  // 7. Western hemisphere → negative longitude
  it('should produce negative longitude for W hemisphere', () => {
    const raw = 'imei:864035050002451,tracker,201223064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,;';
    const f = decodeFrame(raw) as CobanPositionFrame;
    expect(f.longitude).toBeLessThan(0);
  });

  // 8. Date with slash format
  it('should parse local_date with slash format', () => {
    const raw = 'imei:864035050002451,tracker,20/12/23 064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,;';
    const f = decodeFrame(raw) as CobanPositionFrame;
    expect(f.type).toBe('position');
    expect(f.deviceTime.getUTCFullYear()).toBe(2020);
  });

  // 8b. Local date + UTC time straddling midnight -> UTC date corrected (#12)
  it('should reconcile the UTC date when local date and UTC time straddle midnight', () => {
    // Boitier UTC+2 : heure locale 01:00 le 14/06, mais heure UTC = 23:00 le 13/06.
    // Date locale=140614, heure UTC=230000 -> l'instant UTC reel est le 13/06 23:00.
    const raw = 'imei:864035050002451,tracker,260614010000,,F,230000,A,1935.70640,N,09859.94436,W,0.025,;';
    const f = decodeFrame(raw) as CobanPositionFrame;
    expect(f.type).toBe('position');
    expect(f.deviceTime.toISOString()).toBe('2026-06-13T23:00:00.000Z');
  });

  // 9. Empty utc_time → no crash
  it('should handle empty utc_time without crashing', () => {
    const raw = 'imei:864035050002451,tracker,201223064947,,F,,A,1935.70640,N,09859.94436,W,0.025,;';
    const f = decodeFrame(raw);
    expect(f.type).toBe('position');
  });

  // 10. Protocol 18 fields (ignition, door, fuel)
  it('should parse protocol 18 extended fields', () => {
    const raw = 'imei:864035050002451,tracker,201223064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,,100,1,0,80.00%,20.00%,-5;';
    const f = decodeFrame(raw) as CobanPositionFrame;
    expect(f.ignition).toBe(true);
    expect(f.door).toBe(false);
    expect(f.fuel1).toBe(80);
    expect(f.fuel2).toBe(20);
    expect(f.temperature).toBe(-5);
  });

  // 11. Malformed: missing IMEI → Unknown (no throw)
  it('should return Unknown for position with missing IMEI', () => {
    const raw = 'imei:,tracker,201223064947,,F,064947,A,1935.70640,N,09859.94436,W,0.025,;';
    const f = decodeFrame(raw);
    expect(f.type).toBe('unknown');
    expect((f as CobanUnknownFrame).reason).toBe('invalid_imei');
  });

  // 12. Alternative position (ends with *)
  it('should parse alternative position format', () => {
    const raw = 'imei:864035050002451,something,tracker,0,0.0,064947,231220,100,A,19.595107,-98.999073,45.5,180,500,1.2,8,1,0,0*';
    const f = decodeFrame(raw);
    expect(f.type).toBe('position');
    const p = f as CobanPositionFrame;
    expect(p.latitude).toBeCloseTo(19.595107, 4);
    expect(p.longitude).toBeCloseTo(-98.999073, 4);
    expect(p.speedKph).toBeCloseTo(45.5, 1);
  });

  // 13. Empty frame → Unknown
  it('should return Unknown for empty frame', () => {
    const f = decodeFrame('');
    expect(f.type).toBe('unknown');
    expect((f as CobanUnknownFrame).reason).toBe('empty');
  });

  // 14. Garbage → Unknown
  it('should return Unknown for unrecognized frame', () => {
    const f = decodeFrame('garbage123');
    expect(f.type).toBe('unknown');
    expect((f as CobanUnknownFrame).reason).toBe('unrecognized');
  });

  // 15. OBD frame → Unknown
  it('should return Unknown for OBD frame', () => {
    const raw = 'imei:864035050002451,OBD,201223064947,12345,0.5,0.4,100,60,50,90,30,1500,12.4,P0301;';
    const f = decodeFrame(raw);
    expect(f.type).toBe('unknown');
    expect((f as CobanUnknownFrame).reason).toBe('obd_not_implemented');
  });

  // 16. Invalid valid flag (not A or V) → no_fix : boîtier vivant SANS lock GPS.
  it('should return no_fix for invalid valid flag (boîtier vivant sans lock GPS)', () => {
    const raw = 'imei:864035050002451,tracker,201223064947,,F,064947,X,1935.70640,N,09859.94436,W,0.025,;';
    const f = decodeFrame(raw);
    expect(f.type).toBe('no_fix');
    expect((f as CobanNoFixFrame).imei).toBe('864035050002451');
  });

  // 16b. Vraie trame LBS sans fix (rapport antenne-relais "...,L,,,<cell>,...") → no_fix.
  it('should return no_fix for a real LBS no-lock frame', () => {
    const raw = 'imei:864035054757027,tracker,260620044013,100%,L,,,c22,,6764c47,,,,,0,0,0.00%,,;';
    const f = decodeFrame(raw);
    expect(f.type).toBe('no_fix');
    expect((f as CobanNoFixFrame).imei).toBe('864035054757027');
  });

  // 17. Non-numeric latitude → Unknown (no throw)
  it('should return Unknown for non-numeric latitude', () => {
    const raw = 'imei:864035050002451,tracker,201223064947,,F,064947,A,INVALID,N,09859.94436,W,0.025,;';
    const f = decodeFrame(raw);
    expect(f.type).toBe('unknown');
    expect((f as CobanUnknownFrame).reason).toBe('invalid_coordinate_format');
  });
});

describe('decodeAlarm', () => {
  // 18. Temperature alarm
  it('should decode T:23.5 as temperature', () => {
    expect(decodeAlarm('T:23.5')).toBe('temperature');
  });

  // 19. Fuel alarm
  it('should decode oil 45 as fuel', () => {
    expect(decodeAlarm('oil 45')).toBe('fuel');
  });
});

describe('nmeaToDecimal', () => {
  // 20. Standard north coordinate
  it('should convert 1935.70640 N to ~19.5951', () => {
    expect(nmeaToDecimal('1935.70640', 'N')).toBeCloseTo(19.595107, 4);
  });

  // 21. West coordinate → negative
  it('should convert 09859.94436 W to ~-98.9991', () => {
    expect(nmeaToDecimal('09859.94436', 'W')).toBeCloseTo(-98.999073, 4);
  });
});

describe('knotsToKph', () => {
  // 22. Standard conversion
  it('should convert 0.025 knots to 0.046 km/h', () => {
    expect(knotsToKph(0.025)).toBeCloseTo(0.046, 3);
  });
});

/**
 * ── LA BATTERIE, ET POURQUOI ELLE DÉCIDE DE TOUT ─────────────────────────────────────
 *
 * Trames RÉELLES du parc, relevées le 2026-08-19. Le 4e champ y porte « 100% » — un
 * pourcentage de batterie, que le parseur rangeait dans le champ RFID et perdait donc.
 *
 * Sans cette valeur, une alarme `ac alarm` est indistinguable entre :
 *   — un boîtier réellement débranché (batterie qui se vide, urgence réelle) ;
 *   — un boîtier câblé sur du +12V commuté dont on vient de couper le contact
 *     (batterie pleine, véhicule au parking, aucune importance).
 *
 * Faute de les séparer, 202 alertes CRITIQUES sont parties en 24 h pour deux véhicules
 * garés la nuit. C'est ce que ces tests empêchent de revenir.
 */
describe('coban.parser — la batterie du 4e champ', () => {
  const TRAME_AC = 'imei:864035054756177,ac alarm,260819005830,100%,F,005830.000,A,4340.05575,N,00126.35421,E,,,,0,0,0.00%,,';
  const TRAME_POS = 'imei:864035054756177,tracker,260819010410,100%,F,010410.000,A,4340.05575,N,00126.35421,E,,,,0,0,0.00';

  it('lit le pourcentage sur une trame d’alarme reelle', () => {
    const f = decodeFrame(TRAME_AC);
    expect(f.type).toBe('position');
    if (f.type !== 'position') return;
    expect(f.batteryPercent).toBe(100);
    expect(f.alarm).toBe('power_cut');
  });

  it('le lit aussi sur une position ordinaire', () => {
    const f = decodeFrame(TRAME_POS);
    if (f.type !== 'position') return;
    expect(f.batteryPercent).toBe(100);
  });

  it('⚠️ ne le range PLUS dans le champ RFID', () => {
    // C'etait le defaut : « 100% » atterrissait dans `rfid`, donc la valeur existait
    // mais aucun code metier ne pouvait s'en servir.
    const f = decodeFrame(TRAME_AC);
    if (f.type !== 'position') return;
    expect(f.rfid).toBeUndefined();
  });

  it('un VRAI badge RFID reste un badge', () => {
    // On teste la FORME, pas le firmware : sans le signe pourcent, c'est un badge.
    const f = decodeFrame('imei:864035054756177,rfid,260819010410,A1B2C3D4,F,010410.000,A,4340.05575,N,00126.35421,E,,,,0,0,0.00');
    if (f.type !== 'position') return;
    expect(f.rfid).toBe('A1B2C3D4');
    expect(f.batteryPercent).toBeUndefined();
  });

  it('champ vide : ni batterie ni badge, et surtout pas zero', () => {
    // `0 %` signifierait « batterie a plat » et declencherait une alerte a tort.
    const f = decodeFrame('imei:864035054756177,tracker,260819010410,,F,010410.000,A,4340.05575,N,00126.35421,E,,,,0,0,0.00');
    if (f.type !== 'position') return;
    expect(f.batteryPercent).toBeUndefined();
    expect(f.rfid).toBeUndefined();
  });

  it('un pourcentage aberrant est borne a 100', () => {
    const f = decodeFrame('imei:864035054756177,tracker,260819010410,255%,F,010410.000,A,4340.05575,N,00126.35421,E,,,,0,0,0.00');
    if (f.type !== 'position') return;
    expect(f.batteryPercent).toBe(100);
  });
});
