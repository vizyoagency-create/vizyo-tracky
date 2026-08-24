import { encodeCommand } from './coban.encoder';
import { formatFrequency, TCP_MAX_FREQUENCY_S } from './coban.utils';

const IMEI = '864035050002451';

describe('encodeCommand', () => {
  // 1. engine_stop
  it('should encode engine_stop', () => {
    expect(encodeCommand(IMEI, { type: 'engine_stop' }))
      .toBe(`**,imei:${IMEI},J;`);
  });

  // 2. engine_resume
  it('should encode engine_resume', () => {
    expect(encodeCommand(IMEI, { type: 'engine_resume' }))
      .toBe(`**,imei:${IMEI},K;`);
  });

  // 3. alarm_arm
  it('should encode alarm_arm', () => {
    expect(encodeCommand(IMEI, { type: 'alarm_arm' }))
      .toBe(`**,imei:${IMEI},L;`);
  });

  // 4. alarm_disarm
  it('should encode alarm_disarm', () => {
    expect(encodeCommand(IMEI, { type: 'alarm_disarm' }))
      .toBe(`**,imei:${IMEI},M;`);
  });

  // 5. position_single
  it('should encode position_single', () => {
    expect(encodeCommand(IMEI, { type: 'position_single' }))
      .toBe(`**,imei:${IMEI},B;`);
  });

  // 6. position_periodic 30s
  it('should encode position_periodic 30s', () => {
    expect(encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 30 }))
      .toBe(`**,imei:${IMEI},C,30s;`);
  });

  // 7. TRK-045 — 120s n'est PAS exprimable : `02m` serait lu « 2 secondes ».
  //    Ce test attendait `,C,02m;` jusqu'au 2026-08-24. Il verrouillait le défaut.
  it('TRK-045 — refuse 120s au lieu d\'émettre `02m` (lu 2 s par le firmware)', () => {
    expect(() => encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 120 }))
      .toThrow(/non exprimable en TCP: 120s/);
  });

  // 8. TRK-045 — idem pour l'heure : `01h` serait lu « 1 seconde ».
  it('TRK-045 — refuse 3600s au lieu d\'émettre `01h` (lu 1 s par le firmware)', () => {
    expect(() => encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 3600 }))
      .toThrow(/non exprimable en TCP: 3600s/);
  });

  // 9. TRK-045 — 90 s tient sur deux chiffres : plus de troncature vers `01m` (= 1 s).
  it('should encode position_periodic 90s as 90s (plus de troncature vers 01m)', () => {
    expect(encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 90 }))
      .toBe(`**,imei:${IMEI},C,90s;`);
  });

  // 9 bis. TRK-045 — LE CAS DU CANARI du 2026-08-24 : `300s` a un troisième chiffre,
  // le firmware échoue à l'analyser et retombe sur son défaut de 60 s. On a mesuré
  // 9 écarts, tous multiples de 60, là où 300 s était demandé.
  it('TRK-045 — refuse 300s (trois chiffres : le boîtier retombe à 60 s)', () => {
    expect(() => encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 300 }))
      .toThrow(/non exprimable en TCP: 300s/);
  });

  // 9 ter. Le plafond exact, et le plancher matériel du GPS403D.
  it('encode le plafond 99s et le minimum matériel 20s', () => {
    expect(encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 99 }))
      .toBe(`**,imei:${IMEI},C,99s;`);
    expect(encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 20 }))
      .toBe(`**,imei:${IMEI},C,20s;`);
  });

  // 10. position_stop
  it('should encode position_stop', () => {
    expect(encodeCommand(IMEI, { type: 'position_stop' }))
      .toBe(`**,imei:${IMEI},D;`);
  });

  // 11. request_photo → 160
  it('should encode request_photo with numeric 160', () => {
    expect(encodeCommand(IMEI, { type: 'request_photo' }))
      .toBe(`**,imei:${IMEI},160;`);
  });

  // 12. sos_ack
  it('should encode sos_ack', () => {
    expect(encodeCommand(IMEI, { type: 'sos_ack' }))
      .toBe(`**,imei:${IMEI},E;`);
  });

  // 13. custom
  it('should encode custom command', () => {
    expect(encodeCommand(IMEI, { type: 'custom', raw: 'F,1000m' }))
      .toBe(`**,imei:${IMEI},F,1000m;`);
  });

  // 14. Invalid IMEI (14 digits) → throw
  it('should throw on invalid IMEI', () => {
    expect(() => encodeCommand('12345678901234', { type: 'engine_stop' }))
      .toThrow('Invalid IMEI');
  });

  // 15. position_periodic frequency=0 → throw
  it('should throw on frequency=0', () => {
    expect(() => encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 0 }))
      .toThrow('Invalid frequency');
  });

  // 16. position_periodic frequency=100000 → throw
  it('should throw on frequency>86400', () => {
    expect(() => encodeCommand(IMEI, { type: 'position_periodic', frequencySeconds: 100000 }))
      .toThrow('Invalid frequency');
  });
});

describe('formatFrequency', () => {
  it('should format 30 as 30s', () => expect(formatFrequency(30)).toBe('30s'));
  it('should format 5 as 05s', () => expect(formatFrequency(5)).toBe('05s'));

  // ══ TRK-045 — les quatre formes MESURÉES en production le 2026-08-24 ══════════════
  // Le firmware lit deux chiffres et jette la lettre d'unité. `02m` vaut donc 2 s et
  // `01h` vaut 1 s : ces deux assertions attendaient exactement ça avant ce jour-là.
  it('TRK-045 — refuse toute valeur au-delà du plafond de 99 s', () => {
    expect(() => formatFrequency(120)).toThrow(/non exprimable en TCP/);
    expect(() => formatFrequency(300)).toThrow(/non exprimable en TCP/);
    expect(() => formatFrequency(3600)).toThrow(/non exprimable en TCP/);
  });

  it('TRK-045 — le message nomme la cause et la limite, pas seulement le refus', () => {
    expect(() => formatFrequency(300)).toThrow(/deux chiffres/);
    expect(() => formatFrequency(300)).toThrow(/maximum est 99s/);
  });

  it('TRK-045 — n\'émet JAMAIS de suffixe `m` ni `h` sur toute la plage utile', () => {
    // La garde structurelle : c'est l'unité jetée par le firmware qui divisait
    // l'intervalle par 60. Aucune valeur acceptable ne doit produire autre chose que `s`.
    for (let s = 1; s <= TCP_MAX_FREQUENCY_S; s += 1) {
      expect(formatFrequency(s)).toMatch(/^\d{2}s$/);
    }
  });

  it('TRK-045 — le plafond vaut 99 s et il est exprimable', () => {
    expect(TCP_MAX_FREQUENCY_S).toBe(99);
    expect(formatFrequency(TCP_MAX_FREQUENCY_S)).toBe('99s');
  });

  it('refuse 0, les négatifs et les non-entiers', () => {
    expect(() => formatFrequency(0)).toThrow(/invalide/);
    expect(() => formatFrequency(-5)).toThrow(/invalide/);
    expect(() => formatFrequency(20.5)).toThrow(/invalide/);
  });
});
