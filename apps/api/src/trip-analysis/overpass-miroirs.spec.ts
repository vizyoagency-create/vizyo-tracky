import { PoolMiroirs, estBannissement, ECART_MS, PAUSE_INITIALE_MS, PAUSE_MAX_MS } from './overpass-miroirs';

/**
 * ── CE QUE CES TESTS EMPÊCHENT DE REVENIR ────────────────────────────────────────────
 *
 * Le 2026-08-19, DEUX IP ont été bannies d'`overpass-api.de` en une seule journée : celle du
 * VPS le matin, celle du poste l'après-midi. Même scénario les deux fois — une série de HTTP
 * 429, puis un ECONNREFUSED immédiat. Le code d'alors ne faisait aucune différence entre les
 * deux : il réessayait dans les deux cas, ce qui revenait à insister quand on nous disait de
 * ralentir, puis à tambouriner sur une porte fermée.
 *
 * Toute la politique de cadence vit ici, sans réseau ni horloge réelle, pour être vérifiable.
 */
const MIROIRS = [
  { nom: 'a', url: 'https://a/api' },
  { nom: 'b', url: 'https://b/api' },
  { nom: 'c', url: 'https://c/api' },
];

/** Horloge pilotée : la cadence se raisonne en temps simulé, jamais en attente réelle. */
function horloge(depart = 1_000_000) {
  let t = depart;
  return { lire: () => t, avancer: (ms: number) => { t += ms; } };
}

describe('estBannissement — distinguer « ralentis » de « va-t’en »', () => {
  it('⚠️ un refus de connexion ou un délai dépassé est un BANNISSEMENT', () => {
    for (const m of ['ECONNREFUSED', 'ETIMEDOUT', 'fetch failed', 'This operation was aborted', 'délai dépassé']) {
      expect(estBannissement(m)).toBe(true);
    }
  });

  it('⚠️ un 429 ou un 504 n’en est PAS un : le miroir demande juste à souffler', () => {
    expect(estBannissement('HTTP 429')).toBe(false);
    expect(estBannissement('HTTP 504')).toBe(false);
    expect(estBannissement('erreur applicative Overpass : Query timed out'.replace('timed out', 'trop long'))).toBe(false);
  });
});

describe('PoolMiroirs — rotation', () => {
  it('⚠️ ne retape jamais le même miroir deux fois de suite tant qu’un autre est prêt', () => {
    const h = horloge();
    const pool = new PoolMiroirs(MIROIRS, h.lire);
    const vus: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = pool.choisir()!;
      vus.push(c.miroir.nom);
      pool.succes(c.miroir);
      h.avancer(c.attendreMs + 1);
    }
    for (let i = 1; i < vus.length; i++) expect(vus[i]).not.toBe(vus[i - 1]);
  });

  it('répartit la charge : les trois miroirs servent, aucun n’est délaissé', () => {
    const h = horloge();
    const pool = new PoolMiroirs(MIROIRS, h.lire);
    const compte = new Map<string, number>();
    for (let i = 0; i < 12; i++) {
      const c = pool.choisir()!;
      compte.set(c.miroir.nom, (compte.get(c.miroir.nom) ?? 0) + 1);
      pool.succes(c.miroir);
      h.avancer(c.attendreMs + 1);
    }
    expect(compte.size).toBe(3);
    for (const n of compte.values()) expect(n).toBeGreaterThan(1);
  });

  it('un seul miroir disponible : on le réutilise plutôt que de ne rien faire', () => {
    const h = horloge();
    const pool = new PoolMiroirs([MIROIRS[0]!], h.lire);
    const a = pool.choisir()!;
    pool.succes(a.miroir);
    h.avancer(a.attendreMs + 1);
    expect(pool.choisir()!.miroir.nom).toBe('a');
  });
});

describe('PoolMiroirs — écouter ce que le miroir dit', () => {
  it('⚠️ un 429 RALENTIT ce miroir, il ne l’abandonne pas', () => {
    const h = horloge();
    const pool = new PoolMiroirs(MIROIRS, h.lire);
    const c = pool.choisir()!;
    expect(pool.echec(c.miroir, 'HTTP 429').ecarte).toBe(false);
    // La pause a doublé — le miroir reste dans la rotation, il attendra simplement plus.
    expect(c.miroir.pauseMs).toBe(PAUSE_INITIALE_MS * 2);
    expect(pool.tousEcartes()).toBe(false);
  });

  it('les 429 successifs doublent la pause, sans dépasser le plafond', () => {
    const h = horloge();
    const pool = new PoolMiroirs([MIROIRS[0]!], h.lire);
    const m = pool.choisir()!.miroir;
    for (let i = 0; i < 20; i++) pool.echec(m, 'HTTP 429');
    expect(m.pauseMs).toBe(PAUSE_MAX_MS);
  });

  it('un succès détend la cadence, sans jamais descendre sous la base', () => {
    const h = horloge();
    const pool = new PoolMiroirs([MIROIRS[0]!], h.lire);
    const m = pool.choisir()!.miroir;
    pool.echec(m, 'HTTP 429');
    pool.echec(m, 'HTTP 429');
    const haute = m.pauseMs;
    pool.succes(m);
    expect(m.pauseMs).toBeLessThan(haute);
    for (let i = 0; i < 10; i++) pool.succes(m);
    expect(m.pauseMs).toBe(PAUSE_INITIALE_MS);
  });

  it('⚠️ un ECONNREFUSED ÉCARTE le miroir une heure — on ne harcèle pas une porte fermée', () => {
    const h = horloge();
    const pool = new PoolMiroirs(MIROIRS, h.lire);
    const c = pool.choisir()!;
    expect(pool.echec(c.miroir, 'ECONNREFUSED').ecarte).toBe(true);

    // Il ne ressort pas de la rotation tant que l'écart court…
    for (let i = 0; i < 8; i++) {
      const s = pool.choisir()!;
      expect(s.miroir.nom).not.toBe(c.miroir.nom);
      pool.succes(s.miroir);
      h.avancer(s.attendreMs + 1);
    }
    // …et il y revient une fois l'heure passée : un bannissement expire, il n'est pas définitif.
    h.avancer(ECART_MS);
    const noms = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const s = pool.choisir()!;
      noms.add(s.miroir.nom);
      pool.succes(s.miroir);
      h.avancer(s.attendreMs + 1);
    }
    expect(noms.has(c.miroir.nom)).toBe(true);
  });
});

describe('PoolMiroirs — s’arrêter plutôt que boucler à vide', () => {
  it('⚠️ tous les miroirs bannis → `choisir` renvoie null, l’agent doit s’arrêter', () => {
    const h = horloge();
    const pool = new PoolMiroirs(MIROIRS, h.lire);
    for (let i = 0; i < 3; i++) pool.echec(pool.choisir()!.miroir, 'ECONNREFUSED');
    expect(pool.tousEcartes()).toBe(true);
    expect(pool.choisir()).toBeNull();
  });

  it('un seul miroir encore debout suffit à continuer', () => {
    const h = horloge();
    const pool = new PoolMiroirs(MIROIRS, h.lire);
    pool.echec(MIROIRS[0]! as never, 'ECONNREFUSED');
    pool.echec(MIROIRS[1]! as never, 'ECONNREFUSED');
    expect(pool.tousEcartes()).toBe(false);
    expect(pool.choisir()).not.toBeNull();
  });

  it('le résumé nomme qui est écarté et pour combien de temps', () => {
    const h = horloge();
    const pool = new PoolMiroirs(MIROIRS, h.lire);
    pool.echec(pool.choisir()!.miroir, 'ECONNREFUSED');
    expect(pool.resume()).toContain('ecarte');
    expect(pool.resume()).toContain('min');
  });
});
