import { RecuperationService } from './recuperation.service';

/**
 * ── CE QUE CET ÉCRAN DOIT EMPÊCHER ───────────────────────────────────────────────────
 *
 * Pendant des semaines, 98,8 % du cache des limites de vitesse était marqué « inconnu » à
 * tort. Les trois quarts des trajets ne pouvaient donc mathématiquement porter aucun excès, et
 * le score de conduite moyen affichait 93,4/100 — un chiffre qui ne mesurait rien. Rien ne le
 * montrait, faute d'un écran comparant « ce qu'on aurait dû enrichir » à « ce qu'on a enrichi ».
 *
 * D'où la règle testée ici : ON COMPTE, ON N'ESTIME PAS. Et quand le dénominateur n'existe pas,
 * on affiche un volume nu plutôt qu'un taux inventé.
 */
function service(n: Partial<Record<string, number>> = {}) {
  const c = (v = 0) => jest.fn().mockResolvedValue(v);
  const prisma = {
    trip: { count: c(n['trajets'] ?? 0) },
    tripAnalysis: {
      count: jest
        .fn()
        .mockResolvedValueOnce(n['analyses'] ?? 0)
        .mockResolvedValueOnce(n['limites'] ?? 0)
        .mockResolvedValueOnce(n['recits'] ?? 0)
        .mockResolvedValueOnce(n['carburant'] ?? 0),
    },
    fleetPlace: { count: c(n['lieux'] ?? 0) },
    tripFuelStop: { count: c(n['stations'] ?? 0) },
    geocodeCache: { count: c(n['geocodages'] ?? 0) },
    speedLimitCache: {
      count: jest.fn().mockResolvedValueOnce(n['cacheTotal'] ?? 0).mockResolvedValueOnce(n['cacheResolu'] ?? 0),
    },
  };
  return new RecuperationService(prisma as never);
}

/** Les chiffres réels du 2026-08-19, avant rattrapage. */
const REEL = {
  trajets: 14156, analyses: 7001, limites: 2559, recits: 2556, carburant: 6418,
  lieux: 11, stations: 461, geocodages: 42, cacheTotal: 22416, cacheResolu: 22312,
};

const ligne = async (svc: RecuperationService, id: string) =>
  (await svc.etat()).lignes.find((l) => l.id === id)!;

describe('Récupération — compter, jamais estimer', () => {
  it('⚠️ le taux est le rapport EXACT obtenu/attendu, pas une moyenne', async () => {
    const l = await ligne(service(REEL), 'analyse');
    expect(l.attendu).toBe(14156);
    expect(l.obtenu).toBe(7001);
    expect(l.taux).toBeCloseTo(49.5, 1); // 7001/14156
  });

  it('⚠️ met en évidence le trou réel : la moitié des trajets n’a aucune analyse', async () => {
    const l = await ligne(service(REEL), 'analyse');
    expect(l.manque).toContain('7');
    expect(l.taux!).toBeLessThan(50);
  });

  it('les limites de vitesse se comparent aux ANALYSES, pas aux trajets bruts', async () => {
    // Un trajet sans analyse ne peut pas avoir de limites : le denominateur serait malhonnete.
    const l = await ligne(service(REEL), 'limites');
    expect(l.attendu).toBe(REEL.analyses);
    expect(l.obtenu).toBe(REEL.limites);
  });
});

describe('Récupération — ne pas inventer un dénominateur', () => {
  it('⚠️ les lieux saisis à la main n’ont NI attendu NI taux', async () => {
    const l = await ligne(service(REEL), 'lieux-flotte');
    expect(l.attendu).toBeNull();
    expect(l.taux).toBeNull();
    expect(l.obtenu).toBe(11);
    expect(l.role).toContain('nombre attendu');
  });

  it('stations et géocodages affichent un volume nu, sans pourcentage', async () => {
    const svc = service(REEL);
    for (const id of ['stations', 'geocodage']) {
      const l = await ligne(svc, id);
      expect(l.taux).toBeNull();
    }
  });

  it('un dénominateur à zéro ne produit pas une division mais un null', async () => {
    const l = await ligne(service({}), 'analyse');
    expect(l.attendu).toBe(0);
    expect(l.taux).toBeNull();
  });
});

describe('Récupération — lisibilité', () => {
  it('chaque ligne dit à quoi la couche sert et ce qu’on perd sans elle', async () => {
    const { lignes } = await service(REEL).etat();
    for (const l of lignes) {
      expect(l.role.length).toBeGreaterThan(30);
      expect(['Trajets', 'Lieux']).toContain(l.famille);
    }
  });

  it('rien à rattraper → aucun « manque » affiché', async () => {
    const l = await ligne(service({ trajets: 100, analyses: 100 }), 'analyse');
    expect(l.taux).toBe(100);
    expect(l.manque).toBeNull();
  });

  it('porte l’instant de la mesure — un tableau de bord sans date se lit de travers', async () => {
    const { mesureLe } = await service(REEL).etat();
    expect(new Date(mesureLe).getTime()).toBeLessThanOrEqual(Date.now());
  });
});
