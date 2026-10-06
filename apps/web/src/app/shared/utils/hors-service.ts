/**
 * L'état de disponibilité d'un véhicule, vu par les écrans — le hors service DÉCLARÉ sur la fiche,
 * l'immobilisation posée dans l'AGENDA, et le parking souterrain.
 *
 * Demande du propriétaire du 05/10/2026 : un véhicule marqué « Boîtier débranché » sur sa
 * fiche doit se voir BARRÉ — sur la page Carte (marqueur, liste flotte, card, légende) et sur
 * la mini-carte de sa fiche. Le 06/10 : « pareil pour immobilisé, avec la clé », puis « pareil
 * pour accidenté » — les trois motifs de la fiche ont maintenant leur marqueur. Puis, le même
 * jour : « un système d'état qui fonctionne dans toute l'app » — une maintenance de l'agenda met la
 * clé, et un véhicule au parking souterrain a son anneau « P ».
 *
 * La RÈGLE vit dans le module partagé (`etatIndisponibilite`, la même que l'API) ; ce fichier ne
 * fait que la brancher sur ce que les écrans ont en main (instantané temps réel, liste REST).
 */
import {
  etatIndisponibilite,
  getVehicleConnectivityState,
  type EtatIndisponibilite,
  type ImmobilisationAgendaDto,
} from '@vizyo/tracky-shared';

/** Les motifs posés par le sélecteur « État d'exploitation » de la fiche. */
export const MOTIF_DEBRANCHE = 'TRACKER_UNPLUGGED';
export const MOTIF_IMMOBILISE = 'IMMOBILIZED';
export const MOTIF_ACCIDENT = 'ACCIDENT';

interface PorteMotif {
  outOfServiceReason?: string | null;
}

/**
 * Le motif à retenir pour un véhicule.
 *
 * L'instantané temps réel FAIT FOI dès qu'il porte le champ, `null` compris (= remis en
 * service) ; la liste des véhicules n'est qu'un repli, pour une API d'avant le 05/10 qui ne
 * l'envoie pas (`undefined`).
 *
 * ⚠️ Surtout pas `snap?.outOfServiceReason ?? meta?.outOfServiceReason` : `??` lirait le `null`
 * d'un véhicule REMIS en service comme « inconnu », et ressusciterait le « débranché » périmé
 * de la liste chargée à l'ouverture de la carte.
 */
export function motifHorsService(
  snap: PorteMotif | undefined,
  meta: PorteMotif | undefined,
): string | null {
  if (snap && snap.outOfServiceReason !== undefined) return snap.outOfServiceReason;
  return meta?.outOfServiceReason ?? null;
}

export function estDebranche(motif: string | null | undefined): boolean {
  return motif === MOTIF_DEBRANCHE;
}

/** Accidenté — 06/10/2026 : marqueur grisé, anneau anthracite et panneau jaune « ! ». */
export function estAccidente(motif: string | null | undefined): boolean {
  return motif === MOTIF_ACCIDENT;
}

/** Immobilisé (au garage, à l'atelier) — 06/10/2026 : marqueur grisé à badge « clé ». */
export function estImmobilise(motif: string | null | undefined): boolean {
  return motif === MOTIF_IMMOBILISE;
}

interface PorteEtat extends PorteMotif {
  immobilisationAgenda?: ImmobilisationAgendaDto | null;
}

/**
 * L'immobilisation d'agenda à retenir — même règle que le motif : l'instantané fait foi dès qu'il
 * porte le champ (`null` compris : maintenance terminée), la liste REST n'est qu'un repli.
 */
export function immobilisationRetenue(
  snap: PorteEtat | undefined,
  meta: PorteEtat | undefined,
): ImmobilisationAgendaDto | null {
  if (snap && snap.immobilisationAgenda !== undefined) return snap.immobilisationAgenda;
  return meta?.immobilisationAgenda ?? null;
}

/** L'état de disponibilité d'un véhicule : la fiche d'abord, puis l'agenda (règle partagée). */
export function etatVehicule(snap: PorteEtat | undefined, meta?: PorteEtat): EtatIndisponibilite | null {
  return etatIndisponibilite({
    outOfServiceReason: motifHorsService(snap, meta),
    immobilisationAgenda: immobilisationRetenue(snap, meta),
  });
}

/** Les drapeaux de pastille (`VehicleMarkerData`, mini-carte) qui dessinent un état. */
export interface DrapeauxPastille {
  unplugged: boolean;
  accident: boolean;
  immobilized: boolean;
  agenda?: 'MAINTENANCE' | 'INCIDENT';
}

export function drapeauxPastille(etat: EtatIndisponibilite | null): DrapeauxPastille {
  return {
    unplugged: etat === 'DEBRANCHE',
    accident: etat === 'ACCIDENTE',
    immobilized: etat === 'IMMOBILISE',
    ...(etat === 'MAINTENANCE' || etat === 'INCIDENT' ? { agenda: etat } : {}),
  };
}

/** Ce que la règle « au parking souterrain » lit d'une ligne de l'instantané. */
export interface LigneSouterrain {
  presumedParkedZone?: string | null;
  trackerId?: string | null;
  lastSeenAt?: string | null;
  lastPositionAt?: string | null;
  lastNoFixAt?: string | null;
  lastIgnition?: boolean | null;
}

/**
 * Le véhicule est-il AU PARKING SOUTERRAIN (ou couvert) ? Demande du propriétaire du 06/10/2026 :
 * « ajouter même un rond pour les voitures en souterrain comme la HM-769 ».
 *
 * La présomption est celle du SERVEUR (TRK-046, `presumedParkedZone`) : zone validée de type parking,
 * aucun soupçon de coupure d'alimentation — la règle la plus stricte des quatre qui existaient.
 * Mais l'instantané n'est relu qu'à la reconnexion : on exige EN PLUS que le boîtier soit encore
 * muet ou sans GPS. Dès la première trame valide reçue en direct, l'anneau tombe — la carte ne
 * garde pas au parking un véhicule qui en est sorti.
 */
export function estAuSouterrain(ligne: LigneSouterrain | undefined, maintenant: number = Date.now()): boolean {
  if (!ligne?.presumedParkedZone) return false;
  const c = getVehicleConnectivityState(
    {
      trackerId: ligne.trackerId ?? null,
      lastSeenAt: ligne.lastSeenAt ?? null,
      lastPositionAt: ligne.lastPositionAt ?? null,
      lastNoFixAt: ligne.lastNoFixAt ?? null,
      lastIgnition: ligne.lastIgnition ?? null,
    },
    maintenant,
  );
  return c !== 'ONLINE' && c !== 'AWAITING_GPS';
}

/**
 * Le mot de l'étiquette : « souterrain » ou « parking couvert », lu sur le libellé du serveur
 * (`libelleZoneParking` : « parking souterrain — lieu » / « parking couvert — lieu »).
 */
export function motSouterrain(zone: string | null | undefined): string {
  return zone?.startsWith('parking couvert') ? 'parking couvert' : 'souterrain';
}

interface LigneInstantane extends PorteEtat, LigneSouterrain {
  trackerId?: string | null;
  lastLat?: number | null;
  lastLng?: number | null;
}

/**
 * Combien de marqueurs BARRÉS la carte peut montrer : les débranchés qui ont une position.
 *
 * Relevé en production le 05/10 au soir : FT-463-TW (société Ahmed) est déclaré débranché mais
 * n'a jamais eu de boîtier — aucun marqueur. Compter tous les débranchés faisait annoncer
 * « Boîtier débranché (4) » à côté de trois pastilles barrées : une légende décrit ce que la
 * carte montre.
 */
export function nbDebranchesSurLaCarte(vehicules: readonly LigneInstantane[]): number {
  return nbSurLaCarte(vehicules, (v) => etatVehicule(v) === 'DEBRANCHE');
}

/** Même règle pour la clé « Accidenté (n) » de la légende. */
export function nbAccidentesSurLaCarte(vehicules: readonly LigneInstantane[]): number {
  return nbSurLaCarte(vehicules, (v) => etatVehicule(v) === 'ACCIDENTE');
}

/**
 * Même règle pour la clé « Immobilisé (n) » : la CLÉ, donc l'immobilisé de la fiche ET la
 * maintenance ou l'incident de l'agenda (06/10/2026) — une légende compte ce qui porte son symbole.
 */
export function nbImmobilisesSurLaCarte(vehicules: readonly LigneInstantane[]): number {
  return nbSurLaCarte(vehicules, (v) => {
    const etat = etatVehicule(v);
    return etat === 'IMMOBILISE' || etat === 'MAINTENANCE' || etat === 'INCIDENT';
  });
}

/** La clé « Parking souterrain (n) » : l'anneau « P », qu'un état déclaré recouvre. */
export function nbSouterrainsSurLaCarte(vehicules: readonly LigneInstantane[], maintenant: number = Date.now()): number {
  return nbSurLaCarte(vehicules, (v) => !etatVehicule(v) && estAuSouterrain(v, maintenant));
}

function nbSurLaCarte(vehicules: readonly LigneInstantane[], porteLeSymbole: (v: LigneInstantane) => boolean): number {
  return vehicules.filter(
    (v) => porteLeSymbole(v) && !!v.trackerId && v.lastLat != null && v.lastLng != null,
  ).length;
}
