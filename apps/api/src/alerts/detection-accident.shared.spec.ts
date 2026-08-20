import {
  estSoupconAccident,
  soupconsAccident,
  redigerConstat,
  SILENCE_MIN_MS,
  VITESSE_MIN_KMH,
  VITESSE_MAX_PLAUSIBLE_KMH,
  type EtatBoitier,
} from './detection-accident.shared';

/**
 * ── CE QUE CES TESTS PROTÈGENT ───────────────────────────────────────────────────────
 *
 * La règle qui semble évidente — « chute brutale de vitesse = choc » — est fausse sur ce parc,
 * et la production l'a prouvé : 612 chutes de 50 km/h à zéro en 30 jours, TOUTES suivies d'une
 * reprise de route. Le discriminant n'est pas la chute, c'est le SILENCE qui la suit.
 *
 * Chaque test ci-dessous verrouille une façon de se tromper qu'on a écartée sciemment.
 */
const MAINTENANT = Date.parse('2026-08-20T18:00:00Z');
const ilYA = (ms: number) => new Date(MAINTENANT - ms);

const boitier = (over: Partial<EtatBoitier> = {}): EtatBoitier => ({
  trackerId: 't1',
  plaque: 'AA-123-BB',
  derniereTrameA: ilYA(3 * 3_600_000),
  derniereVitesseKmh: 87,
  lat: 43.6,
  lng: 1.44,
  dejaAlerte: false,
  ...over,
});

describe('estSoupconAccident', () => {
  it('roulait vite ET muet depuis longtemps : les deux ensemble, c est le cas', () => {
    expect(estSoupconAccident(boitier(), MAINTENANT)).toBe(true);
  });

  it('⚠️ muet mais A L ARRET : c est un stationnement, pas un choc', () => {
    expect(estSoupconAccident(boitier({ derniereVitesseKmh: 0 }), MAINTENANT)).toBe(false);
  });

  it('⚠️ roulait mais TOUJOURS BAVARD : rien ne s est passe', () => {
    expect(estSoupconAccident(boitier({ derniereTrameA: ilYA(5 * 60_000) }), MAINTENANT)).toBe(false);
  });

  it('une manoeuvre de parking ne compte pas comme « il roulait »', () => {
    expect(estSoupconAccident(boitier({ derniereVitesseKmh: VITESSE_MIN_KMH - 1 }), MAINTENANT)).toBe(false);
    expect(estSoupconAccident(boitier({ derniereVitesseKmh: VITESSE_MIN_KMH }), MAINTENANT)).toBe(true);
  });

  it('le silence doit atteindre le seuil, pas s en approcher', () => {
    expect(estSoupconAccident(boitier({ derniereTrameA: ilYA(SILENCE_MIN_MS - 1000) }), MAINTENANT)).toBe(false);
    expect(estSoupconAccident(boitier({ derniereTrameA: ilYA(SILENCE_MIN_MS) }), MAINTENANT)).toBe(true);
  });

  it('⚠️ une vitesse ABERRANTE est ecartee : 1,7 % des points d un boitier du parc le sont', () => {
    // Sans ce garde-fou, un seul point faux ferait croire qu un vehicule a l arret roulait
    // a 250 km/h juste avant de se taire — et fabriquerait un accident de toutes pieces.
    expect(estSoupconAccident(boitier({ derniereVitesseKmh: VITESSE_MAX_PLAUSIBLE_KMH + 1 }), MAINTENANT)).toBe(false);
    expect(estSoupconAccident(boitier({ derniereVitesseKmh: VITESSE_MAX_PLAUSIBLE_KMH }), MAINTENANT)).toBe(true);
  });

  it('⚠️ vitesse INCONNUE : on ne conclut pas — l inconnu n est pas un zero', () => {
    expect(estSoupconAccident(boitier({ derniereVitesseKmh: null }), MAINTENANT)).toBe(false);
    expect(estSoupconAccident(boitier({ derniereVitesseKmh: NaN }), MAINTENANT)).toBe(false);
  });

  it('un boitier qui n a JAMAIS parle ne prouve rien', () => {
    expect(estSoupconAccident(boitier({ derniereTrameA: null }), MAINTENANT)).toBe(false);
  });

  it('⚠️ deja alerte : on ne repete pas la meme alerte a chaque passage', () => {
    // Sans cette garde, un boitier definitivement mort produirait une alerte CRITICAL a
    // chaque examen, indefiniment — et rendrait le centre d alertes illisible, ce qui est
    // exactement le probleme qu on vient de corriger pour les coupures d alimentation.
    expect(estSoupconAccident(boitier({ dejaAlerte: true }), MAINTENANT)).toBe(false);
  });
});

describe('redigerConstat', () => {
  it('decrit ce qu on OBSERVE et laisse la verification a l humain', () => {
    const texte = redigerConstat(boitier(), MAINTENANT);
    expect(texte).toContain('AA-123-BB');
    expect(texte).toContain('87 km/h');
    expect(texte).toContain('3,0 h');
    expect(texte).toContain('à vérifier sur place');
    // ⚠️ Ne JAMAIS affirmer « accident détecté » : la premiere fois que le motif sera une
    // coupure d alimentation, celui qui recoit l alerte cessera de croire les suivantes.
    expect(texte.toLowerCase()).not.toContain('accident détecté');
  });

  it('reste lisible quand la plaque est inconnue', () => {
    expect(redigerConstat(boitier({ plaque: null }), MAINTENANT)).toContain('Un véhicule');
  });
});

describe('soupconsAccident', () => {
  it('ne garde que les cas reels et les classe du plus rapide au plus lent', () => {
    const r = soupconsAccident(
      [
        boitier({ trackerId: 'lent', derniereVitesseKmh: 42 }),
        boitier({ trackerId: 'arrete', derniereVitesseKmh: 0 }),
        boitier({ trackerId: 'rapide', derniereVitesseKmh: 118 }),
        boitier({ trackerId: 'bavard', derniereTrameA: ilYA(60_000) }),
      ],
      MAINTENANT,
    );
    expect(r.map((x) => x.trackerId)).toEqual(['rapide', 'lent']);
    expect(r[0].silenceMs).toBe(3 * 3_600_000);
    expect(r[0].lat).toBe(43.6);
  });

  it('rend une liste vide quand tout va bien — le cas le plus frequent', () => {
    expect(soupconsAccident([boitier({ derniereVitesseKmh: 0 })], MAINTENANT)).toEqual([]);
    expect(soupconsAccident([], MAINTENANT)).toEqual([]);
  });
});
