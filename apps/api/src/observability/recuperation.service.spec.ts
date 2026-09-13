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
/** T28 — ce que la requête sur la journée close rend ; tout à zéro par défaut. */
interface JourneeClose { total: number; aLaCloture: number; apresCoup: number; sansRecalage: number; origineInconnue: number }

function service(n: Partial<Record<string, number>> = {}, journee: Partial<JourneeClose> = {}) {
  const c = (v = 0) => jest.fn().mockResolvedValue(v);
  const prisma = {
    trip: {
      count: jest
        .fn()
        .mockResolvedValueOnce(n['trajets'] ?? 0)
        .mockResolvedValueOnce(n['horsRetention'] ?? 0)
        // T28 — puis le rattrapage : ce qu'il a recalé, ce qui lui reste.
        .mockResolvedValueOnce(n['rattrapes'] ?? 0)
        .mockResolvedValueOnce(n['resteARecaler'] ?? 0)
        .mockResolvedValue(0),
    },
    // T28 — la journée close se mesure en une requête, avec une comparaison de colonnes que
    // Prisma ne sait pas écrire (la date du recalage contre celle de la clôture).
    $queryRaw: jest.fn().mockResolvedValue([{ total: 0, aLaCloture: 0, apresCoup: 0, sansRecalage: 0, origineInconnue: 0, ...journee }]),
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
  trajets: 11465, horsRetention: 2691, analyses: 7001, limites: 2559, recits: 2556, carburant: 6418,
  lieux: 11, stations: 461, geocodages: 42, cacheTotal: 22416, cacheResolu: 22312,
};

const ligne = async (svc: RecuperationService, id: string) =>
  (await svc.etat()).lignes.find((l) => l.id === id)!;

describe('Récupération — compter, jamais estimer', () => {
  it('⚠️ le taux est le rapport EXACT obtenu/attendu, pas une moyenne', async () => {
    const l = await ligne(service(REEL), 'analyse');
    expect(l.attendu).toBe(11465);
    expect(l.obtenu).toBe(7001);
    expect(l.taux).toBeCloseTo(61.1, 1); // 7001/11465
  });

  it('⚠️ met en évidence le trou réel : des milliers de trajets sans analyse', async () => {
    const l = await ligne(service(REEL), 'analyse');
    expect(l.manque).toContain('4');
    expect(l.taux!).toBeLessThan(70);
  });

  it('les limites de vitesse se comparent aux ANALYSES, pas aux trajets bruts', async () => {
    // Un trajet sans analyse ne peut pas avoir de limites : le denominateur serait malhonnete.
    const l = await ligne(service(REEL), 'limites');
    expect(l.attendu).toBe(REEL.analyses);
    expect(l.obtenu).toBe(REEL.limites);
  });
});

/**
 * ── LE DÉNOMINATEUR NE DOIT PAS CONTENIR L'IMPOSSIBLE ────────────────────────────────
 *
 * Les positions sont purgées au-delà de 60 jours. Relevé du 2026-08-19 : 2 691 trajets
 * antérieurs au 18/06 n'ont plus AUCUN point — vérifié, zéro sur 2 691. Les compter comme
 * « à rattraper » affichait un objectif inatteignable et un taux faussement bas ; les analyser
 * de force aurait produit des analyses vides, indiscernables d'un vrai trajet immobile.
 */
describe('Récupération — l’impossible sort du dénominateur, mais reste visible', () => {
  it('⚠️ les trajets dont les positions sont purgées ne comptent PAS comme un retard', async () => {
    const l = await ligne(service(REEL), 'analyse');
    expect(l.attendu).toBe(11465); // et non 14 156
    expect(l.role).toContain('ENCORE ANALYSABLES');
  });

  it('⚠️ ils ne sont pas cachés pour autant : une ligne dédiée les montre et dit pourquoi', async () => {
    const l = await ligne(service(REEL), 'hors-retention');
    expect(l.obtenu).toBe(2691);
    expect(l.taux).toBeNull(); // pas un retard : un fait
    expect(l.role).toContain('purg');
    expect(l.role).toContain('60 jours');
  });

  it('l’obtenu ne depasse jamais l’attendu, meme si des analyses survivent a la purge', async () => {
    // Une analyse peut rester en base apres la purge de ses positions : le taux ne doit pas
    // depasser 100 %, sinon l'ecran raconte n'importe quoi.
    const l = await ligne(service({ trajets: 100, horsRetention: 50, analyses: 130 }), 'analyse');
    expect(l.obtenu).toBe(100);
    expect(l.taux).toBe(100);
    expect(l.manque).toBeNull();
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

/**
 * ── TRK-016 / T28 — LE RECALAGE SE MESURE À LA CLÔTURE, SUR UNE JOURNÉE CLOSE ──────────
 *
 * Un taux calculé sur `polylineMatched IS NULL` dans une fenêtre glissante mélangeait deux
 * choses : ce que le recalage fait À LA CLÔTURE du trajet, et ce que le rattrapage fait
 * RÉTROACTIVEMENT la nuit suivante. Trois jours de suite, le passé s'est réécrit : le 05/09
 * passait de 132 à 0 trajets sans recalage sans qu'aucun trajet nouveau n'apparaisse — et
 * aucune conclusion sur la qualité du flux neuf n'était décidable.
 *
 * Deux grandeurs, publiées séparément : la qualité À LA CLÔTURE — recalé dans les deux heures
 * qui suivent la fin du trajet, sur la journée CLOSE d'hier, en heure de Paris, un chiffre qui
 * ne bouge plus — et l'AVANCEMENT du rattrapage, qui n'a rien à voir avec elle.
 */
describe('T28 — le recalage à la clôture, sur une journée close', () => {
  it('⚠️ mesure la journée d’HIER en heure de Paris, close et donc immuable — jamais une fenêtre glissante', async () => {
    const svc = service({}, {});
    const maintenant = new Date('2026-09-13T13:00:00Z'); // 15:00 à Paris
    await svc.etat(maintenant);

    const prisma = (svc as unknown as { prisma: { $queryRaw: jest.Mock } }).prisma;
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    // Les bornes passées à la requête : minuit à minuit, heure de Paris, la veille (UTC+2 en septembre).
    const dates = (prisma.$queryRaw.mock.calls[0].slice(1) as unknown[]).filter((v): v is Date => v instanceof Date);
    expect(dates.map((d) => d.toISOString())).toEqual(['2026-09-11T22:00:00.000Z', '2026-09-12T22:00:00.000Z']);
    // Et le délai de clôture est passé en paramètre, en secondes — une seule définition, dans le code.
    expect(prisma.$queryRaw.mock.calls[0].slice(1)).toContain(7200);
  });

  it('la ligne « à la clôture » compte les trajets clôturés ce jour-là qui ont été recalés dans les deux heures', async () => {
    const l = await ligne(service({}, { total: 190, aLaCloture: 171, apresCoup: 11, sansRecalage: 5, origineInconnue: 3 }), 'recalage-cloture');
    expect(l.famille).toBe('Trajets');
    expect(l.attendu).toBe(190);
    expect(l.obtenu).toBe(171);
    expect(l.taux).toBe(90);
    // Ce qui manque est nommé, part par part — c'est la réponse à « pourquoi pas 100 ? ».
    expect(l.manque).toContain('11 recalé(s) après coup');
    expect(l.manque).toContain('5 sans tracé recalé');
    expect(l.manque).toContain('3 d’origine inconnue');
  });

  it('…et son libellé date la journée mesurée : un chiffre sans sa journée se lit de travers', async () => {
    const svc = service({}, { total: 1 });
    const { lignes } = await svc.etat(new Date('2026-09-13T13:00:00Z'));
    expect(lignes.find((l) => l.id === 'recalage-cloture')!.libelle).toContain('12/09');
  });

  it('une journée sans trajet : ni taux ni manque, mais la ligne reste — l’absence est une information', async () => {
    const l = await ligne(service({}, {}), 'recalage-cloture');
    expect(l.attendu).toBe(0);
    expect(l.taux).toBeNull();
    expect(l.manque).toBeNull();
  });

  it('la ligne « rattrapage » est une AUTRE grandeur : ce qu’il a recalé sur ce qu’il avait à faire', async () => {
    const l = await ligne(service({ rattrapes: 300, resteARecaler: 12_400 }), 'recalage-rattrapage');
    expect(l.attendu).toBe(12_700);
    expect(l.obtenu).toBe(300);
    expect(l.taux).toBe(2.4);
    // fr-FR sépare les milliers d'une espace fine insécable : on teste le sens, pas l'octet.
    expect(l.manque).toMatch(/^12.400 restant\(s\)$/);
  });

  it('les deux lignes disent d’où viennent leurs chiffres et pourquoi elles sont séparées', async () => {
    const { lignes } = await service(REEL).etat();
    const cloture = lignes.find((l) => l.id === 'recalage-cloture')!;
    const rattrapage = lignes.find((l) => l.id === 'recalage-rattrapage')!;
    expect(cloture.role).toContain('deux heures');
    expect(cloture.role).toContain('journée close');
    expect(rattrapage.role).toContain('13/09');
  });
});
