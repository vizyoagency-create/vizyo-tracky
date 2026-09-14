import { decrireAgent, hoteDuReferrer, provenanceLisible } from './visiteur';

/**
 * Ce qu'on retient d'un visiteur — et surtout ce qu'on n'en retient pas. Chaque test lit une
 * chaîne réelle et vérifie qu'il n'en sort qu'une FAMILLE (mobile / iOS / Safari), jamais la
 * chaîne elle-même.
 */
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; SM-S921B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36';
const ANDROID_SAMSUNG = 'Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A536B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36';
const WINDOWS_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0';
const MAC_FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:126.0) Gecko/20100101 Firefox/126.0';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/125.0.0.0 Mobile/15E148 Safari/604.1';
const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const WHATSAPP = 'WhatsApp/2.23.20.0 A';
const SAFELINKS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/42.0.2311.135 Safari/537.36 Edge/12.246 Mozilla/5.0 (compatible; Google-Safety; +http://www.google.com/bot.html)';

describe('visiteur — décrire un appareil sans garder son user-agent', () => {
  it.each([
    [IPHONE_SAFARI, { device: 'mobile', os: 'iOS', browser: 'Safari', robot: false }],
    [ANDROID_CHROME, { device: 'mobile', os: 'Android', browser: 'Chrome', robot: false }],
    [ANDROID_SAMSUNG, { device: 'mobile', os: 'Android', browser: 'Samsung Internet', robot: false }],
    [WINDOWS_EDGE, { device: 'desktop', os: 'Windows', browser: 'Edge', robot: false }],
    [MAC_FIREFOX, { device: 'desktop', os: 'macOS', browser: 'Firefox', robot: false }],
    [IPAD, { device: 'tablet', os: 'iPadOS', browser: 'Chrome', robot: false }],
    [ANDROID_TABLET, { device: 'tablet', os: 'Android', browser: 'Chrome', robot: false }],
  ])('%s', (ua, attendu) => {
    expect(decrireAgent(ua)).toEqual(attendu);
  });

  it('reconnaît les robots de prévisualisation et les scanners de liens', () => {
    expect(decrireAgent(WHATSAPP).robot).toBe(true);
    expect(decrireAgent(SAFELINKS).robot).toBe(true);
    expect(decrireAgent('curl/8.4.0').robot).toBe(true);
    expect(decrireAgent(IPHONE_SAFARI).robot).toBe(false);
  });

  it('une chaîne vide ne devine rien', () => {
    expect(decrireAgent('')).toEqual({ device: null, os: null, browser: null, robot: false });
    expect(decrireAgent(undefined)).toEqual({ device: null, os: null, browser: null, robot: false });
  });
});

describe('visiteur — du referrer, seulement l’hôte', () => {
  it('garde l’hôte et jette le chemin, la requête et le fragment', () => {
    expect(hoteDuReferrer('https://mail.google.com/mail/u/0/#inbox/FMfcgz?token=secret')).toBe('mail.google.com');
  });
  it('null pour une ouverture directe, une URL malformée ou un schéma inconnu', () => {
    expect(hoteDuReferrer('')).toBeNull();
    expect(hoteDuReferrer(undefined)).toBeNull();
    expect(hoteDuReferrer('pas une url')).toBeNull();
    expect(hoteDuReferrer('ftp://x.y/z')).toBeNull();
  });
  it('une application Android (android-app://) donne son paquet — c’est la provenance cherchée', () => {
    expect(hoteDuReferrer('android-app://com.google.android.gm/')).toBe('com.google.android.gm');
    expect(provenanceLisible('com.google.android.gm', null)).toBe('Gmail (application)');
    expect(provenanceLisible('com.whatsapp', null)).toBe('WhatsApp');
    expect(provenanceLisible('com.inconnu.appli', null)).toBe('com.inconnu.appli');
  });
});

describe('visiteur — une provenance lisible', () => {
  it('nomme les messageries connues et laisse l’hôte brut sinon', () => {
    expect(provenanceLisible(null, 'app-tracky.vizyoagency.com')).toBe('Ouverture directe (SMS, messagerie…)');
    expect(provenanceLisible('mail.google.com', null)).toBe('Gmail');
    expect(provenanceLisible('outlook.live.com', null)).toBe('Outlook');
    expect(provenanceLisible('web.whatsapp.com', null)).toBe('WhatsApp Web');
    expect(provenanceLisible('app-tracky.vizyoagency.com', 'app-tracky.vizyoagency.com')).toBe('Depuis la page elle-même');
    expect(provenanceLisible('intranet.client.fr', null)).toBe('intranet.client.fr');
  });
});
