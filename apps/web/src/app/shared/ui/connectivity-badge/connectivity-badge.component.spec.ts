import { DORMANT_STOP_COUNTING_MS, getVehiclePresenceState, type VehiclePresenceState } from '@vizyo/tracky-shared';
import { connectivityMeta, connectivityTitle } from './connectivity-badge.component';

/**
 * Le bug que ces tests existent pour empêcher : `connectivityMeta` et `connectivityTitle`
 * se terminent tous deux par `case 'NOT_CONFIGURED': default:`. Ajouter l'état `DORMANT`
 * à l'union SANS lui écrire de `case` ne casse RIEN à la compilation — le dormant tombe
 * dans le `default` et s'affiche « Non configuré », c'est-à-dire « jamais installé », le
 * contraire exact de « il parlait et s'est tu ». Aucune erreur, aucun avertissement : le
 * seul filet possible est ce test.
 */
describe('connectivityMeta / connectivityTitle — état DORMANT', () => {
  it('rend un libellé ET une couleur DIFFÉRENTS de NOT_CONFIGURED (pas de repli silencieux)', () => {
    const dormant = connectivityMeta('DORMANT');
    const notConfigured = connectivityMeta('NOT_CONFIGURED');

    expect(dormant.label).not.toBe(notConfigured.label);
    expect(dormant.color).not.toBe(notConfigured.color);
    expect(dormant.bg).not.toBe(notConfigured.bg);
    expect(dormant.icon).not.toBe(notConfigured.icon);
    // Le libellé doit NOMMER l'état, pas juste être « différent » par accident.
    expect(dormant.label).toContain('Dormant');
  });

  it("porte l'ancienneté du silence dans le libellé quand elle est fournie", () => {
    // Cas réel de production : FV-941-LZ, muet depuis 89 jours.
    expect(connectivityMeta('DORMANT', '89 j').label).toBe('Dormant · 89 j');
    // Sans ancienneté connue : dégradé propre, jamais « Dormant · null ».
    expect(connectivityMeta('DORMANT').label).toBe('Dormant');
    expect(connectivityMeta('DORMANT', null).label).toBe('Dormant');
  });

  it("n'écrase aucun état existant (le dormant est un état de PLUS, pas un remplacement)", () => {
    expect(connectivityMeta('ONLINE').label).toBe('En ligne');
    expect(connectivityMeta('OFFLINE').label).toBe('Hors ligne');
    expect(connectivityMeta('PARKED').label).toBe('Stationné');
    expect(connectivityMeta('NOT_CONFIGURED').label).toBe('Non configuré');
    // Violet dormant ≠ ambre hors-ligne : deux silences, deux urgences, deux couleurs.
    expect(connectivityMeta('DORMANT').color).not.toBe(connectivityMeta('OFFLINE').color);
  });

  /**
   * Les couleurs étaient six hexadécimaux figés : elles ne suivaient pas le thème clair
   * et redéfinissaient des jetons qui existaient déjà. Une valeur en dur ne casse rien —
   * elle s'affiche, simplement dans la mauvaise teinte, et personne ne le remarque tant
   * qu'on développe en thème sombre. D'où ce test, qui rend le retour en arrière visible.
   */
  it('ne rend AUCUNE couleur en dur : tout passe par un jeton', () => {
    const states: VehiclePresenceState[] = [
      'ONLINE', 'AWAITING_GPS', 'GPS_LOST', 'PARKED', 'OFFLINE', 'DORMANT', 'NOT_CONFIGURED',
    ];
    for (const s of states) {
      const m = connectivityMeta(s);
      for (const [champ, valeur] of Object.entries({ color: m.color, bg: m.bg, border: m.border })) {
        expect(`${s}.${champ} = ${valeur}`).not.toMatch(/#[0-9a-f]{3,8}|rgba?\(/i);
        expect(valeur).toContain('var(--texte-');
      }
    }
  });

  it('réserve le contour tireté au seul « Non configuré »', () => {
    const states: VehiclePresenceState[] = [
      'ONLINE', 'AWAITING_GPS', 'GPS_LOST', 'PARKED', 'OFFLINE', 'DORMANT',
    ];
    // « Stationné » et « Non configuré » partagent le gris : les deux sont calmes. Seul
    // le contour dit lequel est un état de terrain et lequel est une absence d'installation.
    expect(connectivityMeta('NOT_CONFIGURED').borderStyle).toBe('dashed');
    expect(connectivityMeta('PARKED').color).toBe(connectivityMeta('NOT_CONFIGURED').color);
    expect(connectivityMeta('PARKED').borderStyle).toBe('solid');
    for (const s of states) expect(connectivityMeta(s).borderStyle).toBe('solid');
  });

  it('donne une infobulle propre au dormant, distincte de « non configuré »', () => {
    const dormant = connectivityTitle('DORMANT', '89 j');
    expect(dormant).not.toBe(connectivityTitle('NOT_CONFIGURED'));
    expect(dormant).toContain('89 j');
    // On explique qu'il n'y a RIEN à réactiver : la dormance est dérivée à la lecture.
    expect(dormant).toContain('dès la première trame');
  });

  it('couvre tous les états de présence : aucun ne retombe sur « Non configuré » par hasard', () => {
    const states: VehiclePresenceState[] = [
      'ONLINE', 'AWAITING_GPS', 'GPS_LOST', 'PARKED', 'OFFLINE', 'DORMANT', 'NOT_CONFIGURED',
    ];
    const labels = states.map((s) => connectivityMeta(s).label);
    // 7 états → 7 libellés distincts. Un état oublié ferait doublon avec « Non configuré ».
    expect(new Set(labels).size).toBe(states.length);
  });
});

describe('badge de présence — bout en bout depuis le tri-état partagé', () => {
  it("affiche « Dormant · 89 j » pour un boîtier muet depuis 89 jours (cas FV-941-LZ)", () => {
    const now = Date.now();
    const lastSeenAt = new Date(now - 89 * 24 * 3600 * 1000).toISOString();
    const state = getVehiclePresenceState({ trackerId: 'tr-1', lastSeenAt }, now);

    expect(state).toBe('DORMANT');
    expect(connectivityMeta(state, '89 j').label).toBe('Dormant · 89 j');
  });

  it("laisse un véhicule de TEST sans boîtier en « Non configuré » (TEST-001-XX n'est pas dormant)", () => {
    const now = Date.now();
    const state = getVehiclePresenceState({ trackerId: null, lastSeenAt: null }, now);

    expect(state).toBe('NOT_CONFIGURED');
    expect(connectivityMeta(state).label).toBe('Non configuré');
  });

  it('utilise bien le seuil COUNTING (7 j) pour l\'AFFICHAGE, pas celui des commandes (72 h)', () => {
    const now = Date.now();
    // 4 jours de silence : au-delà des 72 h qui bloquent les COMMANDES, mais un
    // stationnement de pont/congés reste plausible → on n'affiche PAS « Dormant ».
    const fourDays = new Date(now - 4 * 24 * 3600 * 1000).toISOString();
    expect(getVehiclePresenceState({ trackerId: 'tr-1', lastSeenAt: fourDays }, now)).not.toBe('DORMANT');

    // Juste au-delà de 7 j : là, plus aucun stationnement légitime ne l'explique.
    const past = new Date(now - DORMANT_STOP_COUNTING_MS - 60_000).toISOString();
    expect(getVehiclePresenceState({ trackerId: 'tr-1', lastSeenAt: past }, now)).toBe('DORMANT');
  });
});
