import type { ImmobilisationAgendaDto } from '@vizyo/tracky-shared';
import {
  compterEtats,
  drapeauxPastille,
  estAccidente,
  estAuSouterrain,
  estDebranche,
  estImmobilise,
  etatVehicule,
  immobilisationRetenue,
  installationARevoir,
  motifHorsService,
  motSouterrain,
  MOTIF_ACCIDENT,
  MOTIF_DEBRANCHE,
  MOTIF_IMMOBILISE,
  nbAccidentesSurLaCarte,
  nbDebranchesSurLaCarte,
  nbImmobilisesSurLaCarte,
  nbSouterrainsSurLaCarte,
  resumeEtats,
} from './hors-service';

/**
 * Le motif « hors service » vu par la carte : l'instantané temps réel fait foi dès qu'il porte
 * le champ, la liste des véhicules n'est qu'un repli.
 */
describe('motifHorsService — quelle source croire', () => {
  it('retient l’instantané quand il porte le motif', () => {
    expect(motifHorsService({ outOfServiceReason: MOTIF_DEBRANCHE }, { outOfServiceReason: null }))
      .toBe(MOTIF_DEBRANCHE);
  });

  /**
   * Le piège du `??` : remis en service sur la fiche, le véhicule a `null` dans l'instantané
   * rafraîchi, mais la liste chargée à l'ouverture de la carte dit encore « débranché ».
   */
  it('🔴 un `null` de l’instantané (remis en service) l’emporte sur un « débranché » périmé', () => {
    expect(motifHorsService({ outOfServiceReason: null }, { outOfServiceReason: MOTIF_DEBRANCHE }))
      .toBeNull();
  });

  it('se replie sur la liste quand l’instantané ne connaît pas le champ (API d’avant le 05/10)', () => {
    expect(motifHorsService({}, { outOfServiceReason: MOTIF_DEBRANCHE })).toBe(MOTIF_DEBRANCHE);
    expect(motifHorsService(undefined, { outOfServiceReason: MOTIF_DEBRANCHE })).toBe(MOTIF_DEBRANCHE);
  });

  it('rend null quand personne ne sait rien', () => {
    expect(motifHorsService(undefined, undefined)).toBeNull();
    expect(motifHorsService({}, {})).toBeNull();
  });
});

/**
 * La légende « Boîtier débranché (n) » compte ce que la carte MONTRE. Cas réel du 05/10 au soir,
 * vue « Toutes les sociétés » : 4 débranchés déclarés, dont FT-463-TW sans boîtier — 3 marqueurs.
 */
describe('nbDebranchesSurLaCarte', () => {
  const position = { trackerId: 't', lastLat: 43.64, lastLng: 1.45 };

  it('🔴 ne compte pas un débranché qui n’a jamais eu de boîtier ni de position (FT-463-TW)', () => {
    expect(nbDebranchesSurLaCarte([
      { ...position, outOfServiceReason: MOTIF_DEBRANCHE },                 // DZ-034-CA
      { ...position, outOfServiceReason: MOTIF_DEBRANCHE },                 // FS-253-HR
      { ...position, outOfServiceReason: MOTIF_DEBRANCHE },                 // FS-808-CE
      { trackerId: null, lastLat: null, lastLng: null, outOfServiceReason: MOTIF_DEBRANCHE }, // FT-463-TW
    ])).toBe(3);
  });

  it('ne compte pas un boîtier qui n’a encore jamais émis de position', () => {
    expect(nbDebranchesSurLaCarte([{ trackerId: 't', lastLat: null, lastLng: null, outOfServiceReason: MOTIF_DEBRANCHE }])).toBe(0);
  });

  it('ne compte ni les immobilisés ni les véhicules en service', () => {
    expect(nbDebranchesSurLaCarte([
      { ...position, outOfServiceReason: 'IMMOBILIZED' },
      { ...position, outOfServiceReason: null },
      { ...position },
    ])).toBe(0);
  });
});

describe('estDebranche', () => {
  it('ne reconnaît que le boîtier débranché, pas les autres motifs', () => {
    expect(estDebranche('TRACKER_UNPLUGGED')).toBeTrue();
    expect(estDebranche('IMMOBILIZED')).toBeFalse();
    expect(estDebranche('ACCIDENT')).toBeFalse();
    expect(estDebranche(null)).toBeFalse();
    expect(estDebranche(undefined)).toBeFalse();
  });
});

/** Immobilisé (06/10/2026) : même règle, autre motif. */
describe('estImmobilise et nbImmobilisesSurLaCarte', () => {
  const position = { trackerId: 't', lastLat: 43.66, lastLng: 1.42 };

  it('ne reconnaît que le motif « immobilisé »', () => {
    expect(estImmobilise(MOTIF_IMMOBILISE)).toBeTrue();
    expect(estImmobilise(MOTIF_DEBRANCHE)).toBeFalse();
    expect(estImmobilise('ACCIDENT')).toBeFalse();
    expect(estImmobilise(null)).toBeFalse();
  });

  it('compte les immobilisés qui ont une position, et eux seuls', () => {
    expect(nbImmobilisesSurLaCarte([
      { ...position, outOfServiceReason: MOTIF_IMMOBILISE },               // HD-998-XY
      { ...position, outOfServiceReason: MOTIF_IMMOBILISE },               // HM-787-GA
      { trackerId: 't', lastLat: null, lastLng: null, outOfServiceReason: MOTIF_IMMOBILISE },
      { ...position, outOfServiceReason: MOTIF_DEBRANCHE },
    ])).toBe(2);
  });
});

/** Accidenté (06/10/2026) : même règle, troisième motif. */
describe('estAccidente et nbAccidentesSurLaCarte', () => {
  const position = { trackerId: 't', lastLat: 43.6, lastLng: 1.44 };

  it('ne reconnaît que le motif « accidenté »', () => {
    expect(estAccidente(MOTIF_ACCIDENT)).toBeTrue();
    expect(estAccidente(MOTIF_IMMOBILISE)).toBeFalse();
    expect(estAccidente(MOTIF_DEBRANCHE)).toBeFalse();
    expect(estAccidente(null)).toBeFalse();
  });

  it('compte les accidentés qui ont une position, et eux seuls', () => {
    expect(nbAccidentesSurLaCarte([
      { ...position, outOfServiceReason: MOTIF_ACCIDENT },
      { trackerId: null, lastLat: null, lastLng: null, outOfServiceReason: MOTIF_ACCIDENT },
      { ...position, outOfServiceReason: MOTIF_IMMOBILISE },
    ])).toBe(1);
  });
});

/**
 * 06/10/2026 — « un système d'état qui fonctionne dans toute l'app » : la fiche, puis l'agenda, puis
 * le parking souterrain. La règle est partagée avec l'API (`etatIndisponibilite`).
 */
describe('état de disponibilité — fiche, agenda, parking souterrain', () => {
  const maintenance: ImmobilisationAgendaDto = {
    eventId: 'ev-1', type: 'MAINTENANCE', title: 'Pneus',
    startAt: '2026-10-06T07:00:00.000Z', endAt: '2026-10-06T16:00:00.000Z',
  };
  const incident: ImmobilisationAgendaDto = { ...maintenance, eventId: 'ev-2', type: 'INCIDENT', endAt: null };

  it('etatVehicule : la fiche d’abord, puis l’agenda', () => {
    expect(etatVehicule({ outOfServiceReason: MOTIF_IMMOBILISE, immobilisationAgenda: maintenance })).toBe('IMMOBILISE');
    expect(etatVehicule({ outOfServiceReason: null, immobilisationAgenda: maintenance })).toBe('MAINTENANCE');
    expect(etatVehicule({ outOfServiceReason: null, immobilisationAgenda: incident })).toBe('INCIDENT');
    expect(etatVehicule({ outOfServiceReason: null, immobilisationAgenda: null })).toBeNull();
  });

  it('🔴 l’instantané fait foi, `null` compris : une maintenance finie ne ressuscite pas depuis la liste', () => {
    expect(immobilisationRetenue({ immobilisationAgenda: null }, { immobilisationAgenda: maintenance })).toBeNull();
    expect(etatVehicule({ immobilisationAgenda: null }, { immobilisationAgenda: maintenance })).toBeNull();
    // Repli sur la liste quand l'instantané ne porte pas le champ (API d'avant le 06/10).
    expect(etatVehicule({}, { immobilisationAgenda: maintenance })).toBe('MAINTENANCE');
    expect(etatVehicule(undefined, { outOfServiceReason: MOTIF_ACCIDENT })).toBe('ACCIDENTE');
  });

  it('drapeauxPastille : une maintenance pose la clé (agenda), jamais l’immobilisé de la fiche', () => {
    expect(drapeauxPastille('MAINTENANCE')).toEqual({ unplugged: false, accident: false, immobilized: false, agenda: 'MAINTENANCE' });
    expect(drapeauxPastille('INCIDENT').agenda).toBe('INCIDENT');
    expect(drapeauxPastille('IMMOBILISE')).toEqual({ unplugged: false, accident: false, immobilized: true });
    expect(drapeauxPastille('DEBRANCHE').unplugged).toBeTrue();
    expect(drapeauxPastille(null)).toEqual({ unplugged: false, accident: false, immobilized: false });
  });

  describe('estAuSouterrain — HM-769-GA (06/10 : vivant, sans GPS, zone parking validée à 28 m)', () => {
    const MAINTENANT = Date.parse('2026-10-06T08:38:00.000Z');
    const hm769 = {
      presumedParkedZone: 'parking souterrain — Toulouse',
      trackerId: 't-hm769',
      lastSeenAt: '2026-10-06T08:38:00.000Z',     // le boîtier parle
      lastPositionAt: '2026-10-05T15:49:00.000Z', // dernier fix : la veille au soir
      lastNoFixAt: '2026-10-06T08:38:00.000Z',    // trames sans GPS
      lastIgnition: false,
    };

    it('anneau « P » : présomption du serveur ET boîtier sans GPS', () => {
      expect(estAuSouterrain(hm769, MAINTENANT)).toBeTrue();
    });

    it('anneau aussi quand le boîtier s’est tu (le réseau ne passe pas toujours au sous-sol)', () => {
      expect(estAuSouterrain({ ...hm769, lastSeenAt: '2026-10-06T05:00:00.000Z', lastNoFixAt: null }, MAINTENANT)).toBeTrue();
    });

    it('🔴 plus d’anneau dès qu’une position valide revient en direct — il est sorti', () => {
      expect(estAuSouterrain({ ...hm769, lastPositionAt: '2026-10-06T08:37:30.000Z', lastNoFixAt: null }, MAINTENANT)).toBeFalse();
    });

    it('sans présomption du serveur, jamais d’anneau', () => {
      expect(estAuSouterrain({ ...hm769, presumedParkedZone: null }, MAINTENANT)).toBeFalse();
      expect(estAuSouterrain(undefined, MAINTENANT)).toBeFalse();
    });

    it('le mot de l’étiquette suit le type de parking du serveur', () => {
      expect(motSouterrain('parking souterrain — Toulouse')).toBe('souterrain');
      expect(motSouterrain('parking couvert — Blagnac')).toBe('parking couvert');
      expect(motSouterrain(null)).toBe('souterrain');
    });
  });

  describe('légende : on compte ce que la carte montre', () => {
    const position = { trackerId: 't', lastLat: 43.6, lastLng: 1.44 };

    it('« Immobilisé ou en maintenance (n) » compte la CLÉ : la fiche ET l’agenda', () => {
      expect(nbImmobilisesSurLaCarte([
        { ...position, outOfServiceReason: MOTIF_IMMOBILISE },
        { ...position, outOfServiceReason: null, immobilisationAgenda: maintenance },
        { ...position, outOfServiceReason: null, immobilisationAgenda: incident },
        // Accidenté ET en maintenance : le triangle l'emporte, pas compté ici.
        { ...position, outOfServiceReason: MOTIF_ACCIDENT, immobilisationAgenda: maintenance },
      ])).toBe(3);
    });

    it('« Au parking souterrain (n) » : l’anneau « P », qu’un état déclaré recouvre', () => {
      const MAINTENANT = Date.parse('2026-10-06T08:38:00.000Z');
      const auSousSol = {
        ...position, presumedParkedZone: 'parking souterrain — Toulouse',
        lastSeenAt: '2026-10-06T08:38:00.000Z', lastPositionAt: '2026-10-05T15:49:00.000Z',
        lastNoFixAt: '2026-10-06T08:38:00.000Z', lastIgnition: false,
      };
      expect(nbSouterrainsSurLaCarte([
        auSousSol,
        // HD-292-SH : immobilisé ET au sous-sol — la clé l'emporte.
        { ...auSousSol, outOfServiceReason: MOTIF_IMMOBILISE },
        { ...position, presumedParkedZone: null },
      ], MAINTENANT)).toBe(1);
    });
  });
});

/** 06/10/2026 (suite) — la synthèse du tableau de bord et la règle « installation à revoir ». */
describe('compterEtats, resumeEtats et installationARevoir', () => {
  const maintenance: ImmobilisationAgendaDto = {
    eventId: 'ev-1', type: 'MAINTENANCE', title: 'Pneus',
    startAt: '2026-10-06T07:00:00.000Z', endAt: '2026-10-06T16:00:00.000Z',
  };

  it('compte chaque état, SANS filtre de position (une synthèse de flotte compte un véhicule sans boîtier)', () => {
    const c = compterEtats([
      { outOfServiceReason: MOTIF_IMMOBILISE },
      { outOfServiceReason: MOTIF_IMMOBILISE },
      { outOfServiceReason: MOTIF_DEBRANCHE },                         // FT-463-TW : jamais eu de boîtier
      { outOfServiceReason: null, immobilisationAgenda: maintenance },
      { outOfServiceReason: MOTIF_ACCIDENT, immobilisationAgenda: maintenance }, // la fiche l'emporte
      { outOfServiceReason: null, immobilisationAgenda: null },
      {},
    ]);
    expect(c).toEqual({ total: 5, DEBRANCHE: 1, ACCIDENTE: 1, IMMOBILISE: 2, MAINTENANCE: 1, INCIDENT: 0 });
  });

  it('résume en mots, dans l’ordre des états, sans les zéros, au pluriel quand il faut', () => {
    expect(resumeEtats({ DEBRANCHE: 3, ACCIDENTE: 0, IMMOBILISE: 4, MAINTENANCE: 2, INCIDENT: 1 }))
      .toBe('3 débranchés · 4 immobilisés · 1 incident · 2 en maintenance');
    expect(resumeEtats({ DEBRANCHE: 0, ACCIDENTE: 1, IMMOBILISE: 0, MAINTENANCE: 0, INCIDENT: 0 })).toBe('1 accidenté');
    expect(resumeEtats({ DEBRANCHE: 0, ACCIDENTE: 0, IMMOBILISE: 0, MAINTENANCE: 0, INCIDENT: 0 })).toBe('');
  });

  describe('installationARevoir — une pose ratée, pas un silence expliqué', () => {
    const MAINTENANT = Date.parse('2026-10-06T10:00:00.000Z');
    const POSE_RECENTE = '2026-09-25T08:00:00.000Z';   // 11 jours : dans la fenêtre d’un mois

    it('boîtier posé récemment et hors ligne, véhicule disponible : à revoir (comme avant)', () => {
      expect(installationARevoir(null, 'OFFLINE', POSE_RECENTE, MAINTENANT)).toBeTrue();
    });

    it('🔴 PAS pour un véhicule débranché, accidenté, immobilisé ou en maintenance : le silence est expliqué', () => {
      for (const etat of ['DEBRANCHE', 'ACCIDENTE', 'IMMOBILISE', 'MAINTENANCE', 'INCIDENT'] as const) {
        expect(installationARevoir(etat, 'OFFLINE', POSE_RECENTE, MAINTENANT)).withContext(etat).toBeFalse();
      }
    });

    it('ni pour un boîtier en ligne, ni pour une pose ancienne', () => {
      expect(installationARevoir(null, 'ONLINE', POSE_RECENTE, MAINTENANT)).toBeFalse();
      expect(installationARevoir(null, 'OFFLINE', '2026-06-01T08:00:00.000Z', MAINTENANT)).toBeFalse();
      expect(installationARevoir(null, 'OFFLINE', null, MAINTENANT)).toBeFalse();
    });
  });
});
