import { appliquerPlateforme, detecterPlateforme } from './platform';

/**
 * Les 3 ecarts iOS/Android sont VOLONTAIRES (B1 § « Le systeme de reference »).
 * Ces tests protegent la detection qui les declenche : si elle se trompe, un
 * iPhone recoit la geometrie Android, et l'application parait etrangere.
 */
describe('detecterPlateforme', () => {
  const nav = (userAgent: string, maxTouchPoints = 0) =>
    ({ userAgent, maxTouchPoints }) as Navigator;

  it.each([
    ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'],
    ['iPod', 'Mozilla/5.0 (iPod touch; CPU iPhone OS 16_0 like Mac OS X)'],
    ['iPad ancien', 'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X)'],
  ])('%s -> ios', (_cas, ua) => {
    expect(detecterPlateforme(nav(ua))).toBe('ios');
  });

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
    const doc = { body: { classList: { add: jest.fn(), remove: jest.fn() } } } as unknown as Document;
    const p = appliquerPlateforme(doc, { userAgent: 'iPhone', maxTouchPoints: 5 } as Navigator);
    expect(p).toBe('ios');
    expect(doc.body.classList.remove).toHaveBeenCalledWith('plat-ios', 'plat-android', 'plat-bureau');
    expect(doc.body.classList.add).toHaveBeenCalledWith('plat-ios');
  });
});
