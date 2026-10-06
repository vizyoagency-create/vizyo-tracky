/**
 * ══ L'ÉTAT DE DISPONIBILITÉ D'UN VÉHICULE — UNE SEULE RÈGLE POUR TOUTE L'APPLICATION ══════════
 *
 * Demande du propriétaire du 06/10/2026 : « un système d'état qui fonctionne dans toute l'app —
 * dans les horaires auto ça désactive, dans la carte le rond, dans l'agenda non dispo » ; et « si
 * on ajoute une maintenance à une voiture, elle doit passer avec le rond marron et la clé ».
 *
 * Avant ce module, l'indisponibilité vivait en deux morceaux qui s'ignoraient :
 *  - le hors service DÉCLARÉ sur la fiche (`Vehicle.outOfServiceReason`) : lu par la carte et la
 *    réservation, mais PAS par l'automatisation horaire — HM-733-GA et HM-779-GA, déclarés hors
 *    service, ont été coupés par le planning le 14/09 à 22:00 (TRK-053) ;
 *  - l'immobilisation posée dans l'AGENDA (maintenance ou incident « Immobilise le véhicule ») :
 *    lue par la réservation et le panneau du jour, mais par AUCUNE carte ni par les horaires.
 *
 * Ici, une seule réponse à « ce véhicule est-il disponible, et sinon pourquoi ? ». L'API la calcule
 * (instantané, liste, fiche, Parc, horaires) ; le web l'affiche (marqueur, badges, agenda).
 *
 * Priorité : ce qu'un humain a DÉCLARÉ sur la fiche l'emporte sur l'agenda (débranché, puis
 * accidenté, puis immobilisé — la même que celle des marqueurs), puis l'incident, puis la
 * maintenance. Un véhicule n'affiche qu'un état : une donnée incohérente ne doit jamais faire
 * porter deux habillages à la même pastille.
 */
import {
  effectiveBlockingEndMs,
  IMMOBILIZING_STATUSES,
  type VehicleEventStatus,
  type VehicleEventType,
} from '../dto/agenda.dto';

/** Les motifs posés par le sélecteur « État d'exploitation » de la fiche (super-admin). */
export type MotifHorsService = 'ACCIDENT' | 'TRACKER_UNPLUGGED' | 'IMMOBILIZED';

/**
 * Les événements d'agenda qui rendent un véhicule INDISPONIBLE.
 *
 * ⚠️ Ni la MISSION ni la RÉSERVATION, même si une mission porte `blocksVehicle` : pendant une
 * mission le véhicule ROULE — il est occupé, pas immobilisé. La réservation, elle, les compte
 * (`findImmobilized`) parce qu'elle pose une autre question : « puis-je le prendre ? ».
 */
export const TYPES_IMMOBILISANTS: readonly VehicleEventType[] = ['MAINTENANCE', 'INCIDENT'];

/**
 * Une immobilisation EN COURS posée dans l'agenda : maintenance ou incident marqué « Immobilise le
 * véhicule », pas clôturé, dont la fenêtre couvre l'instant présent.
 */
export interface ImmobilisationAgendaDto {
  eventId: string;
  type: 'MAINTENANCE' | 'INCIDENT';
  title: string;
  /** ISO — début de l'événement. */
  startAt: string;
  /**
   * ISO — fin EFFECTIVE (`effectiveBlockingEndMs`) : la date de fin saisie, sinon la journée
   * d'une maintenance. `null` = jusqu'à clôture (un incident sans date de fin).
   */
  endAt: string | null;
}

/** Ce que la règle lit d'un événement — la ligne Prisma comme le DTO de l'agenda conviennent. */
export interface EvenementAgendaImmobilisant {
  id: string;
  type: VehicleEventType;
  status: VehicleEventStatus;
  blocksVehicle: boolean;
  title: string;
  startAt: string | Date;
  endAt: string | Date | null;
}

const ms = (d: string | Date): number => (d instanceof Date ? d.getTime() : new Date(d).getTime());

/**
 * L'immobilisation d'agenda en cours à `nowMs` parmi les événements d'UN véhicule, ou `null`.
 *
 * MÊME règle que la réservation (`findImmobilized`) et que le panneau du jour de l'agenda —
 * `blocksVehicle`, statut actif (`IMMOBILIZING_STATUSES`), fin effective partagée
 * (`effectiveBlockingEndMs`) — restreinte aux types qui immobilisent (`TYPES_IMMOBILISANTS`).
 * Sans cette identité, la carte dirait « en maintenance » un véhicule que l'agenda dit libre.
 *
 * ⚠️ Les rappels des plans d'entretien (« Vidange » matérialisée chaque échéance, `source: AUTO`)
 * sont des maintenances PLANIFIÉES NON bloquantes : elles n'immobilisent rien, et c'est voulu —
 * sinon chaque échéance de vidange suspendrait 24 h les coupes du véhicule.
 *
 * Plusieurs en même temps : l'incident d'abord (il dure jusqu'à sa clôture), puis le plus récent.
 */
export function immobilisationAgendaEnCours(
  evenements: readonly EvenementAgendaImmobilisant[],
  nowMs: number,
): ImmobilisationAgendaDto | null {
  let retenu: { ev: EvenementAgendaImmobilisant; debut: number; fin: number } | null = null;
  for (const ev of evenements) {
    if (!ev.blocksVehicle) continue;
    if (!TYPES_IMMOBILISANTS.includes(ev.type)) continue;
    if (!IMMOBILIZING_STATUSES.includes(ev.status)) continue;
    const debut = ms(ev.startAt);
    if (!Number.isFinite(debut) || debut > nowMs) continue;
    const fin = effectiveBlockingEndMs(ev.type, debut, ev.endAt == null ? null : ms(ev.endAt));
    if (!(fin > nowMs)) continue;
    if (
      !retenu ||
      (ev.type === 'INCIDENT' && retenu.ev.type !== 'INCIDENT') ||
      (ev.type === retenu.ev.type && debut > retenu.debut)
    ) {
      retenu = { ev, debut, fin };
    }
  }
  if (!retenu) return null;
  return {
    eventId: retenu.ev.id,
    type: retenu.ev.type === 'INCIDENT' ? 'INCIDENT' : 'MAINTENANCE',
    title: retenu.ev.title,
    startAt: new Date(retenu.debut).toISOString(),
    endAt: Number.isFinite(retenu.fin) ? new Date(retenu.fin).toISOString() : null,
  };
}

/** Les états d'indisponibilité, du plus fort au plus faible. */
export type EtatIndisponibilite = 'DEBRANCHE' | 'ACCIDENTE' | 'IMMOBILISE' | 'MAINTENANCE' | 'INCIDENT';

export interface SourceEtatVehicule {
  /** Le motif déclaré sur la fiche — `string` : la liste REST le type ainsi. */
  outOfServiceReason?: string | null;
  immobilisationAgenda?: ImmobilisationAgendaDto | null;
}

/** L'état d'indisponibilité d'un véhicule, ou `null` s'il est disponible. Cf. l'en-tête du module. */
export function etatIndisponibilite(src: SourceEtatVehicule | null | undefined): EtatIndisponibilite | null {
  if (!src) return null;
  switch (src.outOfServiceReason) {
    case 'TRACKER_UNPLUGGED':
      return 'DEBRANCHE';
    case 'ACCIDENT':
      return 'ACCIDENTE';
    case 'IMMOBILIZED':
      return 'IMMOBILISE';
    default:
      break;
  }
  const im = src.immobilisationAgenda;
  if (im) return im.type === 'INCIDENT' ? 'INCIDENT' : 'MAINTENANCE';
  return null;
}

/**
 * Les mots de chaque état, partout les mêmes. `court` suit une plaque (« HD-998-XY · en
 * maintenance ») ; `long` titre un badge ou une puce (« En maintenance »).
 */
export const LIBELLES_ETAT: Readonly<Record<EtatIndisponibilite, { court: string; long: string }>> = {
  DEBRANCHE: { court: 'débranché', long: 'Boîtier débranché' },
  ACCIDENTE: { court: 'accidenté', long: 'Accidenté' },
  IMMOBILISE: { court: 'immobilisé', long: 'Immobilisé' },
  MAINTENANCE: { court: 'en maintenance', long: 'En maintenance' },
  INCIDENT: { court: 'incident', long: 'Incident en cours' },
};

/**
 * Les COUPES AUTOMATIQUES (horaires) sont-elles suspendues ? Oui pour tout véhicule indisponible :
 * le couper à 22:00 au garage, sur la dépanneuse ou sans boîtier n'a pas de sens — et l'atelier
 * doit pouvoir le démarrer.
 *
 * ⚠️ Les REPRISES, elles, ne sont JAMAIS suspendues : un véhicule coupé la nuit puis déclaré
 * immobilisé doit être rallumé à l'ouverture de sa plage, comme les autres. Rater une coupe est un
 * désagrément ; rater une reprise immobilise un véhicule (même asymétrie que `CUT_BACKOFF_MS`).
 */
export function coupesAutoSuspendues(etat: EtatIndisponibilite | null): etat is EtatIndisponibilite {
  return etat !== null;
}
