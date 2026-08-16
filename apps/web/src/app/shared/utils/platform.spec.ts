import { appliquerPlateforme, detecterPlateforme } from './platform';

/**
 * Les 3 ecarts iOS/Android sont VOLONTAIRES (B1 § « Le systeme de reference »).
 * Ces tests protegent la detection qui les declenche : si elle se trompe, un
 * iPhone recoit la geometrie Android, et l'application parait etrangere.
 */
describe('detecterPlateforme', () => {
  const nav = (userAgent: string, maxTouchPoints = 0) =>
    ({ userAgent, maxTouchPoints }) as Navigator;

  // `it.each` est une API Jest ; le web tourne sous Karma/Jasmine, qui ne la connaît
  // pas. Une simple boucle fait le même travail et compile sur les deux runners.
  const AGENTS_IOS: [string, string][] = [
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'],
    ['iPod', 'Mozilla/5.0 (iPod touch; CPU iPhone OS 16_0 like Mac OS X)'],
    ['iPad ancien', 'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X)'],
  ];
  for (const [cas, ua] of AGENTS_IOS) {
    it(`${cas} -> ios`, () => {
      expect(detecterPlateforme(nav(ua))).toBe('ios');
    });
  }

  it('iPadOS 13+ se declare MacIntel — sans le test tactile, il passerait pour un bureau', () => {
    // Le piege classique : Apple a aligne l'UA de l'iPad sur celui du Mac. Seul
    // `maxTouchPoints` les distingue.
    expect(detecterPlateforme(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) MacIntel', 5))).toBe('ios');
  });

  it('un vrai Mac reste un bureau', () => {
    expect(detecterPlateforme(nav('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) MacIntel', 0))).toBe('bureau');
  });

  it('Android -> android', () => {
    expect(detecterPlateforme(nav('Mozilla/5.0 (Linux; Android 14; Pixel 8)'))).toBe('android');
  });

  it('Windows -> bureau', () => {
    expect(detecterPlateforme(nav('Mozilla/5.0 (Windows NT 10.0; Win64; x64)'))).toBe('bureau');
  });

  it('un agent vide ne plante pas et retombe sur bureau', () => {
    expect(detecterPlateforme({ userAgent: '' } as Navigator)).toBe('bureau');
  });
});

describe('appliquerPlateforme', () => {
  it('pose une seule classe et retire les autres', () => {
    // ⚠️ `jasmine`, pas `jest`. L'API est côté serveur (Jest), le web tourne sous
    // Karma/Jasmine. Un `jest.fn()` ici ne casse pas CE test : il casse la COMPILATION
    // de toute la suite web — `ng test` s'arrête sur « Cannot find name 'jest' » avant
    // d'exécuter quoi que ce soit. Le défaut est resté invisible parce que la
    // vérification du dépôt s'arrête à `ng build` (cf. RÈGLE 7, « ce que pnpm verify
    // ne couvre pas : le frontend »).
    const doc = {
      body: { classList: { add: jasmine.createSpy('add'), remove: jasmine.createSpy('remove') } },
    } as unknown as Document;
    const p = appliquerPlateforme(doc, { userAgent: 'iPhone', maxTouchPoints: 5 } as Navigator);
    expect(p).toBe('ios');
    expect(doc.body.classList.remove).toHaveBeenCalledWith('plat-ios', 'plat-android', 'plat-bureau');
    expect(doc.body.classList.add).toHaveBeenCalledWith('plat-ios');
  });
});
