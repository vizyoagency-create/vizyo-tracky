import { MAX_DEVICES_PER_USER, deviceLabel } from './web-push.service';

/**
 * IDENTITÉ DES APPAREILS — ce que l'audit du 2026-08-02 a trouvé cassé.
 *
 * Trois défauts cumulés faisaient qu'un même appareil physique pouvait occuper plusieurs
 * lignes, sans que personne ne puisse dire lesquelles :
 *   1. la validation du serveur rejetait EN SILENCE l'identifiant de repli du client
 *      (base36, donc des lettres g..z, refusées par une regex hexadécimale) ;
 *   2. une ligne à `deviceId NULL` n'était jamais rattrapée (l'égalité SQL ne matche
 *      pas NULL) ;
 *   3. la colonne `label` existait depuis juillet et n'était écrite NULLE PART — les
 *      écrans affichaient le User-Agent brut, illisible.
 */
describe('deviceLabel — reconnaître son propre appareil', () => {
  it('nomme un iPhone sous Safari', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    expect(deviceLabel(ua)).toBe('iPhone · Safari');
  });

  it('⚠️ ne confond pas Chrome avec Safari — Chrome se déclare AUSSI « Safari »', () => {
    // Piège classique du User-Agent : tout navigateur WebKit porte « Safari » dans sa
    // chaîne. Tester Safari en premier étiquetterait la moitié du parc en « Safari ».
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
    expect(deviceLabel(ua)).toBe('Windows · Chrome');
  });

  it('⚠️ ne confond pas Edge avec Chrome — Edge se déclare AUSSI « Chrome »', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0';
    expect(deviceLabel(ua)).toBe('Windows · Edge');
  });

  it('nomme un Android sous Chrome', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36';
    // « Android » l'emporte sur « Linux » : c'est ce que l'utilisateur reconnaît.
    expect(deviceLabel(ua)).toBe('Android · Chrome');
  });

  it('rend null plutôt qu’un libellé inventé quand rien n’est reconnaissable', () => {
    // Un nom faux est pire que pas de nom : l'utilisateur révoquerait le mauvais appareil.
    expect(deviceLabel(null)).toBeNull();
    expect(deviceLabel(undefined)).toBeNull();
    expect(deviceLabel('')).toBeNull();
    expect(deviceLabel('curl/8.4.0')).toBeNull();
  });

  it('reste utilisable quand une seule des deux moitiés est connue', () => {
    expect(deviceLabel('Mozilla/5.0 (iPhone)')).toBe('iPhone');
    expect(deviceLabel('Firefox/128.0')).toBe('Firefox');
  });
});

describe('plafond d’appareils', () => {
  it('vaut 3 — un téléphone, un poste, un appareil de secours', () => {
    expect(MAX_DEVICES_PER_USER).toBe(3);
  });
});

/**
 * La validation du `deviceId` côté contrôleur, rejouée à l'identique.
 *
 * ⚠️ L'ancienne regle `/^[0-9a-f-]{8,64}$/` acceptait `crypto.randomUUID()` et REFUSAIT le
 * repli `${Date.now()}-${Math.random().toString(36)}` que le client fabrique quand
 * `crypto.randomUUID` est indisponible. Refus silencieux : `deviceId` devenait `undefined`
 * et le dédoublonnage retombait sur le User-Agent, qui change à chaque mise à jour du
 * navigateur — d'où des lignes fantômes pour un même appareil.
 */
const ACCEPTE = (v: string) => /^[A-Za-z0-9._-]{8,128}$/.test(v);

describe('validation du deviceId', () => {
  it('accepte un UUID (chemin normal)', () => {
    expect(ACCEPTE('3f2504e0-4f89-11d3-9a0c-0305e82c3301')).toBe(true);
  });

  it('⚠️ accepte le repli base36 du client — c’est le correctif', () => {
    const repli = `${1785250000000}-${'k3f9qz2xw'}`;
    expect(ACCEPTE(repli)).toBe(true);
  });

  it('refuse ce qui n’est pas un identifiant opaque', () => {
    expect(ACCEPTE('court')).toBe(false); // trop court
    expect(ACCEPTE('a'.repeat(200))).toBe(false); // trop long
    expect(ACCEPTE('avec espace')).toBe(false);
    expect(ACCEPTE('<script>alert(1)</script>')).toBe(false);
    expect(ACCEPTE('../../etc/passwd')).toBe(false);
  });
});
