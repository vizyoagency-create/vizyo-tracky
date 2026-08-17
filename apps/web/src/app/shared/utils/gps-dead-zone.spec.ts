import {
  deadZoneDureeTypiqueLabel,
  deadZoneEstSilencieuse,
  deadZonePeriodeLabel,
} from './gps-dead-zone';

/**
 * ── CE QUE CES TESTS VERROUILLENT ────────────────────────────────────────────────────
 *
 * Le compteur de passages d'une zone morte est le SEUL chiffre que l'exploitant a pour
 * juger si un lieu est un passage régulier — un parking qu'on emprunte tous les jours —
 * ou une coïncidence. Il ne peut pas en juger sans l'échelle de temps : « 9 passages »
 * décrit deux réalités opposées selon qu'ils tiennent en un mois ou en un an.
 *
 * On verrouille donc les quatre paliers, et surtout les deux bornes qui produisent une
 * phrase absurde si on les rate : zéro étendue (« sur 0 jour ») et le passage unique,
 * qui n'a pas d'étendue du tout.
 */
describe('deadZonePeriodeLabel — l’échelle du compteur de passages', () => {
  /** Formateur figé : on teste la PHRASE, pas le calcul de date relative de l'appelant. */
  const relatif = () => 'il y a 2 h';

  const zone = (occurrences: number, premier: string, dernier: string) => ({
    occurrences,
    firstSeenAt: premier,
    lastSeenAt: dernier,
  });

  it('un passage unique n’a pas d’étendue : on ne dit que sa date', () => {
    // ⚠️ Sans ce cas, la formule rendrait « sur 0 jour » — qui se lit comme un bug
    // d'affichage, pas comme une information.
    const t = deadZonePeriodeLabel(zone(1, '2026-08-17T08:00:00Z', '2026-08-17T08:00:00Z'), relatif);
    expect(t).toBe('dernière il y a 2 h');
  });

  it('plusieurs passages le même jour le disent, plutôt que d’annoncer « 0 jour »', () => {
    const t = deadZonePeriodeLabel(zone(3, '2026-08-17T06:00:00Z', '2026-08-17T20:00:00Z'), relatif);
    expect(t).toBe('dernière il y a 2 h, toutes le même jour');
  });

  it('en jours tant que la période tient dans le mois — c’est l’échelle utile au quotidien', () => {
    const t = deadZonePeriodeLabel(zone(9, '2026-07-25T08:00:00Z', '2026-08-17T08:00:00Z'), relatif);
    expect(t).toBe('sur 23 jours · dernière il y a 2 h');
  });

  it('singulier à un jour : « sur 1 jour », jamais « sur 1 jours »', () => {
    const t = deadZonePeriodeLabel(zone(2, '2026-08-16T08:00:00Z', '2026-08-17T08:00:00Z'), relatif);
    expect(t).toBe('sur 1 jour · dernière il y a 2 h');
  });

  it('bascule en mois au-delà de trente jours — neuf pertes sur un an ne sont pas une habitude', () => {
    const t = deadZonePeriodeLabel(zone(9, '2025-08-17T08:00:00Z', '2026-08-17T08:00:00Z'), relatif);
    expect(t).toBe('sur 12 mois · dernière il y a 2 h');
  });

  it('le cas réel de production : FS-253-HR, 9 pertes à Toulouse', () => {
    // Données observées le 2026-08-17 sur la base de production : c'est la phrase que
    // l'exploitant lira sur sa fiche véhicule.
    const t = deadZonePeriodeLabel(zone(9, '2026-06-30T12:00:00Z', '2026-08-12T17:25:00Z'), relatif);
    expect(t).toBe('sur 1 mois · dernière il y a 2 h');
  });
});

/**
 * ── LE SILENCE PROMIS DOIT ÊTRE LE SILENCE RÉEL ──────────────────────────────────────
 *
 * L'écran affiche « aucune alerte ici ». Cette phrase engage : si une alerte tombe quand
 * même, l'exploitant cesse de croire l'écran — et il a raison. Ces tests alignent la
 * promesse sur la règle du serveur (`gps-integrity`), où le silence est INCONDITIONNEL
 * sur un parking, mais plafonné dans le temps sur les autres zones dites normales.
 */
describe('deadZoneEstSilencieuse — ne promettre que ce que le serveur tient', () => {
  it('un parking souterrain reconnu est silencieux sans condition de durée', () => {
    expect(deadZoneEstSilencieuse({ status: 'CONFIRMED_BENIGN', label: 'UNDERGROUND_PARKING' })).toBe(true);
  });

  it('un parking couvert aussi — le ciel manque de la même façon', () => {
    expect(deadZoneEstSilencieuse({ status: 'CONFIRMED_BENIGN', label: 'COVERED_PARKING' })).toBe(true);
  });

  it('⚠️ une zone « normale » SANS être un parking ne l’est PAS : le plafond y reste actif', () => {
    // C'est le cas qui rendait la promesse fausse : l'opérateur a dit « normal » sans dire
    // pourquoi, la durée porte donc encore de l'information, et l'alerte revient au-delà.
    expect(deadZoneEstSilencieuse({ status: 'CONFIRMED_BENIGN', label: 'OTHER' })).toBe(false);
    expect(deadZoneEstSilencieuse({ status: 'CONFIRMED_BENIGN', label: 'UNKNOWN' })).toBe(false);
  });

  it('un tunnel confirmé normal n’est pas traité comme un parking — on ne l’a pas décidé', () => {
    expect(deadZoneEstSilencieuse({ status: 'CONFIRMED_BENIGN', label: 'TUNNEL' })).toBe(false);
  });

  it('une zone récurrente ou suspecte alerte, même étiquetée parking', () => {
    expect(deadZoneEstSilencieuse({ status: 'RECURRING', label: 'UNDERGROUND_PARKING' })).toBe(false);
    expect(deadZoneEstSilencieuse({ status: 'SUSPECT', label: 'UNDERGROUND_PARKING' })).toBe(false);
    expect(deadZoneEstSilencieuse({ status: 'LEARNING', label: 'UNKNOWN' })).toBe(false);
  });
});

/**
 * ── TRK-028 : LA DURÉE TYPIQUE, EN CLAIR ─────────────────────────────────────────────
 *
 * C'est la phrase qui répond à la question du conducteur inquiet : « il est où ? ».
 * « Environ 3 h » suffit à rassurer ; « 3 h 12 » suggère une précision que la médiane de
 * quelques épisodes n'a pas, et invite à comparer deux valeurs incomparables.
 */
describe('deadZoneDureeTypiqueLabel — un ordre de grandeur, pas un chronomètre', () => {
  it('se tait quand rien n’a été mesuré — pas de durée inventée', () => {
    expect(deadZoneDureeTypiqueLabel(null)).toBeNull();
    expect(deadZoneDureeTypiqueLabel(0)).toBeNull();
    expect(deadZoneDureeTypiqueLabel(-5)).toBeNull();
  });

  it('sous une heure : arrondi aux 5 minutes', () => {
    expect(deadZoneDureeTypiqueLabel(23)).toBe('environ 25 min');
    expect(deadZoneDureeTypiqueLabel(47)).toBe('environ 45 min');
  });

  it('jamais « environ 0 min » : le plancher est 5', () => {
    // Un épisode très court arrondirait à zéro — « le signal revient environ 0 min
    // après » ne veut rien dire.
    expect(deadZoneDureeTypiqueLabel(2)).toBe('environ 5 min');
  });

  it('en heures au-delà, au demi près tant que ça reste lisible', () => {
    expect(deadZoneDureeTypiqueLabel(180)).toBe('environ 3 h');
    expect(deadZoneDureeTypiqueLabel(195)).toBe('environ 3 h 30');
    expect(deadZoneDureeTypiqueLabel(200)).toBe('environ 3 h 30');
  });

  it('à l’heure pleine passé dix heures — le demi n’apporte plus rien', () => {
    expect(deadZoneDureeTypiqueLabel(700)).toBe('environ 12 h');
  });

  it('en jours au-delà de deux : un véhicule au parking pour le week-end', () => {
    expect(deadZoneDureeTypiqueLabel(4320)).toBe('environ 3 jours');
  });
});
