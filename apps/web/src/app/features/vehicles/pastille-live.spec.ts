import { genrePastille, pastilleLiveAutorisee } from './pastille-live';

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * UNE PASTILLE « LIVE » EST UNE AFFIRMATION SUR LE PRÉSENT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Dans la liste des véhicules, la pastille et le badge de connectivité s'excluent : le badge
 * est dans la branche `@else` de la pastille. Afficher la pastille, c'est donc EMPÊCHER le
 * seul élément qui date la donnée de s'afficher.
 *
 * ⚠️ CE FICHIER TIENT UN DÉFAUT LIVRÉ TROIS FOIS, toujours par le même mécanisme : un état de
 * boîtier oublié dans une liste d'interdits. Le troisième — celui qui a motivé l'extraction —
 * a été mesuré en production le 2026-09-07 : `GLA•KC•31` affichait « À l'arrêt · 7 km/h » avec
 * un dernier signal remontant à 108,1 h, soit 4,5 jours.
 *
 * Le test central n'est donc pas « tel état est refusé » mais **« seul un boîtier vivant passe »**.
 * C'est cette formulation qui couvre d'avance le quatrième oubli.
 */

const MINUTE = 60_000;
const HEURE = 60 * MINUTE;
const MAINTENANT = Date.parse('2026-09-07T12:00:00.000Z');

/** Un instant, exprimé en âge depuis `MAINTENANT`. */
const ilYA = (ms: number) => new Date(MAINTENANT - ms).toISOString();

/** Un boîtier vivant et localisé : le cas nominal, dont chaque test ne change qu'une chose. */
const boitierSain = (ageSignal = MINUTE) => ({
  trackerId: 'trk-1',
  lastSeenAt: ilYA(ageSignal),
  lastPositionAt: ilYA(ageSignal),
  lastNoFixAt: null,
  lastIgnition: true,
});

describe('pastilleLiveAutorisee — parler au présent exige une trame du présent', () => {
  it('un boîtier vu il y a une minute : la pastille est légitime', () => {
    expect(pastilleLiveAutorisee(boitierSain(), ilYA(MINUTE), false, MAINTENANT)).toBe(true);
  });

  /**
   * 🔴 LE TEST DE RÉGRESSION — le cas exact mesuré en production. Sans le correctif, la ligne
   * affichait « À l'arrêt · 7 km/h » pour un véhicule muet depuis quatre jours et demi.
   */
  it('🔴 muet depuis 4,5 jours : refusée, alors qu’il n’est NI dormant NI en GPS perdu', () => {
    const gla = {
      trackerId: 'trk-gla',
      lastSeenAt: ilYA(108.1 * HEURE),
      lastPositionAt: ilYA(109.9 * HEURE),
      lastNoFixAt: ilYA(108.1 * HEURE),
      lastIgnition: false,
    };

    // Le témoin qui rend ce test nécessaire : les deux gardes historiques le laissent passer.
    // Dormance = muet > 7 j → 4,5 j n'y entre pas. GPS perdu exige un boîtier qui ÉMET ENCORE
    // (trame `no_fix` de moins de 15 min) → la sienne a 108 h.
    expect(pastilleLiveAutorisee(gla, ilYA(109.9 * HEURE), false, MAINTENANT)).toBe(false);
  });

  it('le seuil est celui du tri-état : 15 min', () => {
    expect(pastilleLiveAutorisee(boitierSain(14 * MINUTE), ilYA(14 * MINUTE), false, MAINTENANT)).toBe(true);
    expect(pastilleLiveAutorisee(boitierSain(16 * MINUTE), ilYA(16 * MINUTE), false, MAINTENANT)).toBe(false);
  });

  it('dormant (muet > 7 j) : refusée — c’est « Dormant · N j » qui doit s’afficher', () => {
    expect(pastilleLiveAutorisee(boitierSain(), ilYA(MINUTE), true, MAINTENANT)).toBe(false);
  });

  /**
   * GPS PERDU : le boîtier PARLE (trame `no_fix` fraîche) mais sa dernière position est
   * périmée — donc sa vitesse est figée. « Vivant » ne suffit pas ici, d'où la garde explicite
   * qui subsiste dans la fonction.
   */
  it('GPS perdu : refusée bien que le boîtier soit vivant', () => {
    const sansFix = {
      trackerId: 'trk-2',
      lastSeenAt: ilYA(MINUTE),
      lastNoFixAt: ilYA(MINUTE),
      lastPositionAt: ilYA(6 * HEURE),
      lastIgnition: true,
    };

    expect(pastilleLiveAutorisee(sansFix, ilYA(6 * HEURE), false, MAINTENANT)).toBe(false);
  });

  /**
   * ⚠️ SANS SNAPSHOT, ON JUGE LA TRAME SUR SON PROPRE ÂGE. Une position poussée en direct est
   * une preuve de fraîcheur en soi : la refuser faute de snapshot serait un recul, et
   * l'accepter sans regarder son âge reproduirait le défaut qu'on corrige.
   */
  it('sans snapshot, c’est l’horodatage de la trame qui décide', () => {
    expect(pastilleLiveAutorisee(null, ilYA(2 * MINUTE), false, MAINTENANT)).toBe(true);
    expect(pastilleLiveAutorisee(null, ilYA(3 * HEURE), false, MAINTENANT)).toBe(false);
    expect(pastilleLiveAutorisee(null, null, false, MAINTENANT)).toBe(false);
  });

  /**
   * ⚠️ LE TEST QUI COUVRE LE QUATRIÈME OUBLI. Il ne nomme aucun état : il affirme que la
   * décision ne dépend QUE de la fraîcheur. Un état de boîtier ajouté demain, quel qu'il soit,
   * sera refusé s'il est muet — sans que personne ait à y penser.
   */
  it('aucun état muet ne passe, quel que soit le reste de la trame', () => {
    const ages = [16 * MINUTE, HEURE, 12 * HEURE, 3 * 24 * HEURE, 6 * 24 * HEURE];
    for (const age of ages) {
      for (const ignition of [true, false, null]) {
        const muet = {
          trackerId: 'trk-x',
          lastSeenAt: ilYA(age),
          lastPositionAt: ilYA(age),
          lastNoFixAt: null,
          lastIgnition: ignition,
        };
        expect(pastilleLiveAutorisee(muet, ilYA(age), false, MAINTENANT))
          .withContext(`muet depuis ${Math.round(age / HEURE)} h, ignition=${ignition}`)
          .toBe(false);
      }
    }
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * « À L'ARRÊT » NE SE DÉDUIT PAS D'UN FIL QU'ON N'A PAS POSÉ
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Sur trois états possibles, un seul exige le fil ACC du boîtier : `idle` — immobile MOTEUR
 * TOURNANT. Les deux autres se lisent sur le GPS.
 *
 * ⚠️ Quand le fil n'est pas raccordé, `ignition` vaut `false` en permanence. Le lire quand même
 * ne donne pas une approximation : il donne l'INVERSE. Mesuré en production le 2026-09-07 :
 * `GA-490-SJ` roulait à 31 km/h et la liste affichait « À l'arrêt ». Six véhicules vivants sur
 * trente avaient `accConnected: false`.
 */
describe('genrePastille — ce que la pastille peut honnêtement affirmer', () => {
  it('🔴 sans fil ACC, un véhicule qui roule est « moving », jamais « stopped »', () => {
    // Le cas exact de GA-490-SJ : le boîtier dit contact coupé, le GPS voit 31 km/h.
    expect(genrePastille({ ignition: false, speedKmh: 31 }, false)).toBe('moving');
  });

  it('sans fil ACC, on n’affirme JAMAIS « idle » — cet état est inconnaissable', () => {
    // Ni à l'arrêt total, ni à vitesse nulle avec un contact qui prétendrait être ON.
    expect(genrePastille({ ignition: false, speedKmh: 0 }, false)).toBe('stopped');
    expect(genrePastille({ ignition: true, speedKmh: 0 }, false)).toBe('stopped');
  });

  it('avec le fil, les trois états restent distingués', () => {
    expect(genrePastille({ ignition: true, speedKmh: 50 }, true)).toBe('moving');
    expect(genrePastille({ ignition: true, speedKmh: 0 }, true)).toBe('idle');
    expect(genrePastille({ ignition: false, speedKmh: 0 }, true)).toBe('stopped');
  });

  /**
   * ⚠️ AVEC LE FIL, ET POURTANT CONTRADICTOIRE : remorquage, roue libre, trame en retard. On
   * croit le GPS — annoncer « à l'arrêt » un véhicule qui se déplace est la seule des deux
   * erreurs qu'un exploitant ne peut pas rattraper.
   */
  it('contact coupé mais mouvement réel : on croit le GPS', () => {
    expect(genrePastille({ ignition: false, speedKmh: 31 }, true)).toBe('moving');
  });

  it('le seuil de 3 km/h sépare le roulage de la dérive GPS', () => {
    expect(genrePastille({ ignition: true, speedKmh: 3 }, true)).toBe('idle');
    expect(genrePastille({ ignition: true, speedKmh: 4 }, true)).toBe('moving');
  });

  /**
   * `accConnected` inconnu (`null`) n'est pas `false` : un boîtier dont on ignore le câblage
   * garde le comportement d'avant, sinon on retirerait `idle` à toute une flotte par prudence
   * mal placée.
   */
  it('fil inconnu (null) : comportement d’origine, `idle` reste possible', () => {
    expect(genrePastille({ ignition: true, speedKmh: 0 }, null)).toBe('idle');
    expect(genrePastille({ ignition: true, speedKmh: 0 }, undefined)).toBe('idle');
  });
});
