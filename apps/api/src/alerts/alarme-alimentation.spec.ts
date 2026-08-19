import type { CobanPositionFrame } from '@vizyo/tracky-shared';
import { analyserAlimentation, messageCoupure, SEUIL_BATTERIE_COUPURE } from './alarme-alimentation';

/**
 * Ce que ces tests empêchent de revenir : 202 alertes CRITIQUES « Alimentation coupée »
 * en 24 h, pour DEUX véhicules garés la nuit (relevé du 2026-08-19). Aucune n'était
 * utile. Un client qui reçoit ça cesse de lire nos alertes — et la vraie coupure, le
 * jour où elle arrive, se noie dans le bruit que nous avons créé.
 */
function trame(p: Partial<CobanPositionFrame> = {}): CobanPositionFrame {
  return {
    type: 'position',
    imei: '864035054756177',
    alarm: 'power_cut',
    deviceTime: new Date('2026-08-19T00:58:30Z'),
    valid: true,
    latitude: 43.6676,
    longitude: 1.4392,
    speedKph: 0,
    raw: 'imei:864035054756177,ac alarm,260819005830,100%,F,...',
    ...p,
  };
}

/**
 * ── LA CAUSE PREMIERE : C'EST NOUS QUI COUPONS ───────────────────────────────────────
 *
 * Releve du 2026-08-19 sur DZ-034-CA : horaire 08:00-22:00, le planificateur envoie CUT
 * a 22:00, le boitier constate la perte du +12V et emet 156 `ac alarm` entre 00:57 et
 * 08:52. L'application transformait sa PROPRE action en 156 alertes critiques au client.
 */
describe('analyserAlimentation — ne pas s’alarmer de sa propre coupure', () => {
  it('⚠️ moteur coupe par l’automatisation : AUCUNE alerte, quelle que soit la batterie', () => {
    for (const b of [100, 40, 5, undefined]) {
      const a = analyserAlimentation(trame({ batteryPercent: b }), { moteurCoupeParNous: true });
      expect(a.verdict).toBe('coupure_commandee');
      expect(a.alerter).toBe(false);
    }
  });

  it('le motif dit QUI a coupe — sinon l’exploitant cherche une panne', () => {
    const a = analyserAlimentation(trame({ batteryPercent: 100 }), { moteurCoupeParNous: true });
    expect(a.motif).toContain('commandée par l');
  });

  it('moteur RETABLI : on retrouve le comportement normal', () => {
    const a = analyserAlimentation(trame({ batteryPercent: 40 }), { moteurCoupeParNous: false });
    expect(a.verdict).toBe('coupure_reelle');
    expect(a.alerter).toBe(true);
  });
});

describe('analyserAlimentation — separer la panne du stationnement', () => {
  it('⚠️ LE CAS REEL : batterie 100 %, vehicule a l’arret — AUCUNE alerte', () => {
    // La trame exacte qui a produit 153 alertes sur DZ-034-CA.
    const a = analyserAlimentation(trame({ batteryPercent: 100 }));
    expect(a.verdict).toBe('contact_coupe');
    expect(a.alerter).toBe(false);
  });

  it('batterie juste au seuil : toujours pas d’alerte', () => {
    const a = analyserAlimentation(trame({ batteryPercent: SEUIL_BATTERIE_COUPURE }));
    expect(a.alerter).toBe(false);
  });

  it('⚠️ un point sous le seuil : la batterie se vide, on ALERTE', () => {
    // C'est la frontiere qui compte : elle doit se franchir dans le bon sens.
    const a = analyserAlimentation(trame({ batteryPercent: SEUIL_BATTERIE_COUPURE - 1 }));
    expect(a.verdict).toBe('coupure_reelle');
    expect(a.alerter).toBe(true);
  });

  it('batterie effondree : coupure franche', () => {
    const a = analyserAlimentation(trame({ batteryPercent: 12 }));
    expect(a.verdict).toBe('coupure_reelle');
    expect(a.alerter).toBe(true);
    expect(a.motif).toContain('12 %');
  });

  it('⚠️ batterie INCONNUE : on alerte, le doute ne doit pas faire taire', () => {
    // Choix inverse de celui des zones mortes GPS, et deliberement : là c'etait une
    // absence de position, ici c'est peut-etre un arrachage.
    const a = analyserAlimentation(trame({ batteryPercent: undefined }));
    expect(a.verdict).toBe('indetermine');
    expect(a.alerter).toBe(true);
  });

  it('le motif NOMME la raison, il ne dit pas « anomalie »', () => {
    expect(analyserAlimentation(trame({ batteryPercent: 100 })).motif).toContain('contact coupé');
    expect(analyserAlimentation(trame({ batteryPercent: 40 })).motif).toContain('seuil');
  });
});

/**
 * Les 202 alertes envoyées portaient un message VIDE : « Alimentation coupée », rien
 * d'autre. Impossible de juger sans aller chercher ailleurs — donc on ne juge pas, on
 * subit. Le message doit porter de quoi decider.
 */
describe('messageCoupure — de quoi juger sans aller chercher', () => {
  it('porte la batterie ET l’etat du vehicule', () => {
    const f = trame({ batteryPercent: 42, speedKph: 0, ignition: false });
    const m = messageCoupure(analyserAlimentation(f), f);
    expect(m).toContain('42 %');
    expect(m).toContain('arrêt');
  });

  it('distingue un vehicule qui roule — la coupure n’a pas le meme sens', () => {
    const f = trame({ batteryPercent: 42, speedKph: 68, ignition: true });
    const m = messageCoupure(analyserAlimentation(f), f);
    expect(m).toContain('mouvement');
  });

  it('batterie inconnue : on le dit, on n’invente pas un chiffre', () => {
    const f = trame({ batteryPercent: undefined });
    expect(messageCoupure(analyserAlimentation(f), f)).toContain('inconnu');
  });

  it('n’est JAMAIS vide — c’etait le defaut des 202 alertes', () => {
    for (const b of [undefined, 0, 50, 100]) {
      const f = trame({ batteryPercent: b });
      expect(messageCoupure(analyserAlimentation(f), f).length).toBeGreaterThan(30);
    }
  });
});
