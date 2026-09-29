import type { VehicleEventDto } from '@vizyo/tracky-shared';
import {
  annulationSansObjet,
  debutDeGrille,
  evenementsParJour,
  libelleMultiJours,
  peutEtreDeplace,
  type EntreeJour,
} from './agenda-calendar.component';

/*
 * LOT MULTI-JOURS (28/09) — les jours qu'un évènement occupe sur la grille. Depuis la revue du
 * 29/09, la grille n'énumère plus que les jours qu'elle AFFICHE, avec le vrai rang et la vraie durée
 * (plus de borne à 62 jours) : la règle vit dans `agenda.utils.ts` (`joursDansFenetre`,
 * `dureeEnJours`), partagée avec le panneau du jour, et ses tests dans `agenda.utils.spec.ts` ; son
 * câblage dans la grille (`evenementsParJour`) est éprouvé plus bas.
 */

/**
 * LA REPRISE EN MASSE LAISSAIT AUTANT DE LIGNES BARRÉES QU'ELLE ANNULAIT DE RÉSERVATIONS.
 *
 * Relevé le 2026-09-23, en production, juste après avoir repris les 116 réservations automatiques
 * à venir du cdef31 depuis la feuille « Réorganiser ». Les 116 annulations se sont affichées
 * barrées sur les deux semaines suivantes : l'outil censé désencombrer l'agenda venait de le
 * rendre moins lisible qu'avant qu'on s'en serve.
 *
 * La règle retenue tient en une phrase : un créneau annulé qui n'a pas encore commencé n'aura pas
 * lieu, donc on ne le montre pas ; un créneau annulé qui a déjà commencé a occupé son véhicule un
 * moment, et ce trou mérite d'être visible.
 */
describe('annulationSansObjet', () => {
  const MAINTENANT = Date.parse('2026-09-23T10:00:00.000Z');
  const dans = (ms: number) => new Date(MAINTENANT + ms).toISOString();

  it('masque une annulation dont le créneau est encore à venir', () => {
    expect(annulationSansObjet({ status: 'CANCELLED', startAt: dans(3600_000) }, MAINTENANT)).toBe(true);
  });

  it('GARDE une annulation déjà commencée — le trou dans l’activité s’explique', () => {
    expect(annulationSansObjet({ status: 'CANCELLED', startAt: dans(-3600_000) }, MAINTENANT)).toBe(false);
  });

  it('ne masque RIEN qui ne soit pas annulé, même loin dans le futur', () => {
    for (const status of ['CONFIRMED', 'REQUESTED', 'IN_PROGRESS', 'DONE', 'PLANNED']) {
      expect(annulationSansObjet({ status, startAt: dans(7 * 24 * 3600_000) }, MAINTENANT)).toBe(false);
    }
  });

  it('traite un statut absent comme « pas annulé » plutôt que de le faire disparaître', () => {
    expect(annulationSansObjet({ startAt: dans(3600_000) }, MAINTENANT)).toBe(false);
    expect(annulationSansObjet({ status: null, startAt: dans(3600_000) }, MAINTENANT)).toBe(false);
  });

  /**
   * ⚠️ Une date illisible ne doit pas faire disparaître la ligne : on ne sait pas si elle est
   * passée, et un événement qu'on n'affiche pas est un événement qu'on ne peut pas corriger.
   */
  it('garde une ligne dont la date est illisible', () => {
    expect(annulationSansObjet({ status: 'CANCELLED', startAt: 'pas une date' }, MAINTENANT)).toBe(false);
    expect(annulationSansObjet({ status: 'CANCELLED', startAt: '' }, MAINTENANT)).toBe(false);
  });

  /** La borne est le DÉBUT, et elle est stricte : commencer à la seconde présente, c'est commencé. */
  it('ne masque pas une annulation qui commence à l’instant même', () => {
    expect(annulationSansObjet({ status: 'CANCELLED', startAt: dans(0) }, MAINTENANT)).toBe(false);
  });
});

/**
 * LE GLISSER-DÉPOSER DÉPLACE UN ENGAGEMENT EN UN DEMI-SECONDE.
 *
 * Ajouté le 2026-09-23 avec le geste lui-même. Ce prédicat est le seul garde-fou entre un
 * mouvement de pouce et le déplacement d'une réservation : il mérite d'être éprouvé ligne à
 * ligne, y compris sur les cas qu'on n'a pas envie d'écrire.
 */
describe('peutEtreDeplace', () => {
  const TOUT = { agenda: true, reservations: true };
  const RIEN = { agenda: false, reservations: false };

  it('laisse déplacer une maintenance planifiée à qui gère l’agenda', () => {
    expect(peutEtreDeplace({ type: 'MAINTENANCE', status: 'PLANNED' }, TOUT)).toBe(true);
    expect(peutEtreDeplace({ type: 'MAINTENANCE', status: 'PLANNED' }, RIEN)).toBe(false);
  });

  /** Déplacer une réservation, c'est la même autorité que la valider — pas celle de l'agenda. */
  it('exige `reservations_manage` pour une réservation, pas `agenda_manage`', () => {
    const agendaSeul = { agenda: true, reservations: false };
    expect(peutEtreDeplace({ type: 'RESERVATION', status: 'CONFIRMED' }, agendaSeul)).toBe(false);
    expect(peutEtreDeplace({ type: 'RESERVATION', status: 'CONFIRMED' }, TOUT)).toBe(true);
  });

  /** Le cas qui compte le plus : une mission engage un TIERS. */
  it('ne laisse JAMAIS déplacer une mission, même avec tous les droits', () => {
    for (const status of ['PLANNED', 'OPEN', 'IN_PROGRESS'] as const) {
      expect(peutEtreDeplace({ type: 'MISSION', status }, TOUT)).toBe(false);
    }
  });

  it('refuse ce qui est clôturé ou annulé', () => {
    expect(peutEtreDeplace({ type: 'MAINTENANCE', status: 'DONE' }, TOUT)).toBe(false);
    expect(peutEtreDeplace({ type: 'RESERVATION', status: 'CANCELLED' }, TOUT)).toBe(false);
  });
});

/**
 * Refonte UX du 28/09 (point 1) — « comprendre immédiatement la durée d'une réservation sans devoir
 * ouvrir chaque élément ». La pilule le dit elle-même.
 */
describe('libelleMultiJours', () => {
  it('un seul jour : le titre nu', () => {
    expect(libelleMultiJours('Sortie', 1, 1)).toBe('Sortie');
  });
  it('le premier jour annonce la durée, AVANT le titre (une cellule étroite coupe la fin)', () => {
    expect(libelleMultiJours('Sortie', 1, 3)).toBe('3 j · Sortie');
  });
  it('une suite dit où on en est, avant le titre', () => {
    expect(libelleMultiJours('Sortie', 2, 3)).toBe('↳ 2/3 · Sortie');
    expect(libelleMultiJours('Sortie', 3, 3)).toBe('↳ 3/3 · Sortie');
  });
  it('une grande durée s’écrit telle quelle — le libellé ne borne rien', () => {
    expect(libelleMultiJours('Mise à disposition', 1, 91)).toBe('91 j · Mise à disposition');
    expect(libelleMultiJours('Mise à disposition', 70, 91)).toBe('↳ 70/91 · Mise à disposition');
  });
});

/**
 * LA BORNE À 62 JOURS, ÉPROUVÉE SUR LE CÂBLAGE DE LA GRILLE (contre-revue du 29/09, S3).
 *
 * Le test précédent ne regardait que `libelleMultiJours`, qui n'a jamais plafonné : il passait aussi
 * sur le code d'avant. La borne vivait dans l'énumération des jours (partie du début de l'évènement,
 * arrêtée au 62e) — c'est donc `evenementsParJour`, la fonction que la grille appelle, avec la
 * fenêtre qu'elle passe, qu'il faut éprouver. Ces attentes échouent si l'énumération repart du début
 * de l'évènement (plus rien après le 62e jour, « 62 j » au lieu de « 91 j »), ou si la fenêtre
 * repart du 1er du mois au lieu du lundi de la première semaine (plus de pilule le lun. 26 oct.).
 */
describe('evenementsParJour — ce que la grille pose sur chaque jour', () => {
  const MAD = {
    id: 'mad',
    title: 'Mise à disposition',
    type: 'RESERVATION',
    status: 'CONFIRMED',
    startAt: '2026-09-01T08:00:00',
    endAt: '2026-11-30T18:00:00',
  } as VehicleEventDto;
  const MAINTENANT = new Date('2026-09-01T07:00:00').getTime();
  const libelle = (e: EntreeJour | undefined) => (e ? libelleMultiJours(e.ev.title, e.jour, e.total) : null);

  it('grille de novembre : le lundi 26 oct. ouvre la grille, au 56e jour sur 91', () => {
    const jours = evenementsParJour([MAD], new Date(2026, 10, 15), MAINTENANT);
    // 1er nov. 2026 = un dimanche : la grille part du lundi 26 octobre.
    expect(debutDeGrille(new Date(2026, 10, 15)).getTime()).toBe(new Date(2026, 9, 26).getTime());
    expect(libelle(jours.get('2026-10-26')?.[0])).toBe('↳ 56/91 · Mise à disposition');
    expect(jours.has('2026-10-25')).toBe(false);
  });

  it('AU-DELÀ du 62e jour : la pilule est toujours là, avec son vrai rang et sa vraie durée', () => {
    const jours = evenementsParJour([MAD], new Date(2026, 10, 1), MAINTENANT);
    expect(libelle(jours.get('2026-11-01')?.[0])).toBe('↳ 62/91 · Mise à disposition');
    expect(libelle(jours.get('2026-11-02')?.[0])).toBe('↳ 63/91 · Mise à disposition');
    expect(libelle(jours.get('2026-11-09')?.[0])).toBe('↳ 70/91 · Mise à disposition');
    expect(libelle(jours.get('2026-11-30')?.[0])).toBe('↳ 91/91 · Mise à disposition');
    // Et rien après la fin, même si la grille continue jusqu'au dimanche 6 décembre.
    expect(jours.has('2026-12-01')).toBe(false);
    // Du lun. 26 oct. au lun. 30 nov. : 36 jours, un seul évènement par jour.
    expect(jours.size).toBe(36);
  });

  it('grille de septembre : le premier jour annonce la VRAIE durée (91 j, pas 62 j)', () => {
    const jours = evenementsParJour([MAD], new Date(2026, 8, 1), MAINTENANT);
    const premier = jours.get('2026-09-01')?.[0];
    expect(libelle(premier)).toBe('91 j · Mise à disposition');
    expect(premier?.suite).toBe(false);
    expect(jours.get('2026-09-02')?.[0].suite).toBe(true);
  });

  it('une annulation encore à venir ne pose aucune pilule', () => {
    const annulee = { ...MAD, status: 'CANCELLED' } as VehicleEventDto;
    expect(evenementsParJour([annulee], new Date(2026, 10, 1), MAINTENANT).size).toBe(0);
  });
});
