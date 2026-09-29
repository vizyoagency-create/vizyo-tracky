import type {
  VehicleEventDto,
  VehicleEventSeverity,
  VehicleEventStatus,
  VehicleEventType,
} from '@vizyo/tracky-shared';
import { effectiveBlockingEndMs, isImmobilizingEvent } from '@vizyo/tracky-shared';

/**
 * Sprint 7 — Agenda : conventions visuelles (couleurs / libellés) + helpers de
 * temps, définis UNE fois et réutilisés par la page agenda, le calendrier et
 * l'onglet maintenance du détail véhicule.
 *
 * Convention couleur événement :
 *   MAINTENANCE  → vert (--tracky)
 *   INCIDENT     → ambre/rouge selon la sévérité
 *   RESERVATION  → bleu (réservé Sprint 8, n'apparaît pas en S7)
 * Statut :
 *   DONE         → muet + check
 *   CANCELLED    → muet barré
 *   PLANNED      → contour
 *   OPEN/retard  → plein rouge/ambre
 */

/**
 * Couleur principale d'un événement selon son type + sévérité.
 *
 * ⚠️ Des jetons `var(--texte-*)`, PAS des hexadécimaux : ces couleurs finissent en
 * couleur de TEXTE via `[style.--pill]` / `[style.--u]`, et les valeurs vives
 * d'avant (#F59E0B, #EF4444, #38BDF8…) rendaient 2,1 à 3,4:1 en thème clair.
 * Les jetons basculent d'eux-mêmes entre les deux thèmes. Elles ne sont
 * consommées que par des propriétés CSS — ne pas les passer à un canvas ni à un
 * attribut SVG, où `var()` ne se résout pas.
 */
export function eventColor(ev: Pick<VehicleEventDto, 'type' | 'severity'>): string {
  switch (ev.type) {
    case 'MAINTENANCE':
      return 'var(--texte-succes)';
    case 'INCIDENT':
      return severityColor(ev.severity);
    case 'RESERVATION':
      return 'var(--texte-info)';
    default:
      return 'var(--texte-inactif)';
  }
}

/** Couleur d'une sévérité d'incident — mêmes règles que eventColor. */
export function severityColor(severity: VehicleEventSeverity | null | undefined): string {
  switch (severity) {
    case 'HIGH':
      return 'var(--texte-alerte)';
    case 'MEDIUM':
    case 'LOW':
      // L'écart amber-400 / amber-500 ne survivait pas au thème clair : les deux
      // sévérités partagent le jeton ambre, le libellé porte la nuance.
      return 'var(--texte-attente)';
    default:
      return 'var(--texte-attente)';
  }
}

/** Libellé FR court d'un type d'événement. */
export function eventTypeLabel(type: VehicleEventType): string {
  switch (type) {
    case 'MAINTENANCE':
      return 'Maintenance';
    case 'INCIDENT':
      return 'Incident';
    case 'RESERVATION':
      return 'Réservation';
    // ⚠️ Sans ce cas, le `default` rendait l'ÉNUMÉRATION BRUTE — « MISSION » en capitales, au
    // milieu de « Maintenance » et « Réservation ». Les missions vivent dans la même grille que
    // le reste depuis 2026-08 (A2 § 3.1) : elles doivent se nommer comme le reste.
    case 'MISSION':
      return 'Mission';
    default:
      return type;
  }
}

/** Libellé FR d'un statut d'événement. */
export function eventStatusLabel(status: VehicleEventStatus): string {
  switch (status) {
    case 'PLANNED':
      return 'Planifié';
    case 'OPEN':
      return 'Ouvert';
    case 'IN_PROGRESS':
      return 'En cours';
    case 'DONE':
      return 'Terminé';
    case 'CANCELLED':
      return 'Annulé';
    case 'REQUESTED':
      return 'Demande';
    case 'CONFIRMED':
      return 'Confirmée';
    default:
      return status;
  }
}

/** Libellé FR d'une sévérité. */
export function severityLabel(severity: VehicleEventSeverity | null | undefined): string {
  switch (severity) {
    case 'HIGH':
      return 'Critique';
    case 'MEDIUM':
      return 'Moyenne';
    case 'LOW':
      return 'Faible';
    default:
      return '—';
  }
}

/** Urgence dérivée d'un événement non clôturé selon son échéance (startAt). */
export type EventUrgency = 'overdue' | 'soon' | 'normal' | 'done';

/**
 * Calcule l'urgence d'un événement PLANNED/OPEN par rapport à maintenant :
 *  - DONE/CANCELLED → 'done' (neutre)
 *  - échéance passée → 'overdue'
 *  - échéance < 7 jours → 'soon'
 *  - sinon → 'normal'
 */
export function eventUrgency(ev: Pick<VehicleEventDto, 'status' | 'startAt'>, now = Date.now()): EventUrgency {
  if (ev.status === 'DONE' || ev.status === 'CANCELLED') return 'done';
  const due = new Date(ev.startAt).getTime();
  if (Number.isNaN(due)) return 'normal';
  if (due < now) return 'overdue';
  if (due - now < 7 * 86400000) return 'soon';
  return 'normal';
}

/**
 * « À venir & en retard » — la règle UNIQUE qui décide si un évènement appartient à cette liste.
 *
 * Elle est le miroir exact des deux compteurs de l'en-tête (`GET /agenda/summary`) :
 *  - « En retard » = PLANNED dont l'échéance est passée ;
 *  - « À venir »   = PLANNED dont l'échéance est encore devant.
 *
 * Audit du 24/09 (« compteur ≠ liste ») : le compteur ne comptait que les PLANNED, la liste
 * affichait aussi OPEN et IN_PROGRESS — on lisait « 1 en retard » au-dessus de trois lignes
 * rouges. Un IN_PROGRESS n'est ni à venir ni en retard : il est EN COURS, et c'est le panneau du
 * jour (et le compteur « Incidents ouverts ») qui le portent.
 *
 * Recette du 28/09 sur la démo : la première règle commune (« PLANNED, ou OPEN à échéance
 * passée ») faisait pire — un incident déclaré à l'instant (OPEN, `startAt` = maintenant) passait
 * « EN RETARD » dans la seconde. Un OPEN n'est pas en retard, il est OUVERT : même logement qu'un
 * IN_PROGRESS (compteur « Incidents ouverts », pilule et panneau du jour). Seul un PLANNED a une
 * échéance — à venir, ou dépassée — et la date ne décide plus de l'appartenance, seulement du tri
 * et du badge (`eventUrgency`).
 *
 * Tout changement ici doit se refléter dans `vehicle-events.service.ts` (`summary`), et
 * inversement : deux règles qui divergent redonnent exactement le défaut d'origine.
 */
export function estUneEcheance(ev: Pick<VehicleEventDto, 'status' | 'startAt'>): boolean {
  return ev.status === 'PLANNED'; // la date (`startAt`) ne décide plus : voir ci-dessus
}

/** Couleur associée à une urgence (listes à venir / en retard) — mêmes règles que eventColor. */
export function urgencyColor(urgency: EventUrgency): string {
  switch (urgency) {
    case 'overdue':
      return 'var(--texte-alerte)';
    case 'soon':
      return 'var(--texte-attente)';
    case 'done':
      return 'var(--texte-inactif)';
    default:
      return 'var(--texte-succes)';
  }
}

// ─── Helpers de date (natifs, repris du date-range-picker, heure LOCALE) ────

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}
export function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, d.getDate());
}
export function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
export function startOfWeekMonday(d: Date): Date {
  const dow = d.getDay();
  const offset = (dow + 6) % 7;
  return addDays(d, -offset);
}
export function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
/** YYYY-MM-DD en heure LOCALE (évite les décalages d'1 jour façon UTC). */
export function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
/** 42 cellules (6 semaines) à partir du lundi de la 1re semaine du mois. */
export function buildCells(monthFirst: Date): Date[] {
  const start = startOfWeekMonday(monthFirst);
  const cells: Date[] = [];
  for (let i = 0; i < 42; i++) cells.push(addDays(start, i));
  return cells;
}

// ─── Durée d'un évènement en jours civils — LA règle, pour tous les écrans ──────────────────

/**
 * Nombre de jours civils qu'un évènement couvre (1 = une seule journée) : de minuit (local) de son
 * début à minuit de sa fin, bornes comprises. Sans fin, fin illisible ou fin avant le début : 1.
 *
 * Revue du 29/09 : la règle vivait dans la page (panneau du jour, « À venir », formulaire), et la
 * grille comptait autrement — la longueur d'une liste de jours bornée à 62. Une mise à disposition
 * du 1er sept. au 30 nov. se lisait « 62 j » sur la pilule et « 91 jours · jour 70/91 » dans le
 * panneau du jour. Une seule fonction, sans borne : les deux écrans disent la même durée.
 */
export function dureeEnJours(ev: Pick<VehicleEventDto, 'startAt' | 'endAt'>): number {
  if (!ev.endAt) return 1;
  const a = startOfDay(new Date(ev.startAt)).getTime();
  const b = startOfDay(new Date(ev.endAt)).getTime();
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return 1;
  return Math.round((b - a) / 86400000) + 1;
}

/**
 * Rang (1 = premier jour) du jour `jour` dans l'évènement, avec la même règle que `dureeEnJours`.
 * Peut sortir de [1, durée] : c'est à l'appelant de dire ce qu'il fait d'un jour hors de l'évènement.
 * NaN si le début est illisible.
 */
export function rangDuJour(ev: Pick<VehicleEventDto, 'startAt'>, jour: Date): number {
  const debut = startOfDay(new Date(ev.startAt)).getTime();
  const cible = startOfDay(jour).getTime();
  // Math.round absorbe les 23 h / 25 h d'un changement d'heure entre deux minuits.
  return Math.round((cible - debut) / 86400000) + 1;
}

/**
 * Les jours qu'un évènement occupe DANS une fenêtre de `nbJours` jours à partir de `debutFenetre`
 * (la grille du mois : 42 jours), chacun avec son VRAI rang et la VRAIE durée.
 *
 * Revue du 29/09 : la grille énumérait les jours depuis le début de l'évènement, bornés à 62 — un
 * évènement commencé deux mois plus tôt s'affichait « ↳ 57/62 » puis disparaissait de la grille au
 * 63e jour, alors que le véhicule était toujours pris. On n'énumère plus que les jours affichés :
 * jamais plus de `nbJours` entrées, quelle que soit la durée, et aucune borne à inventer.
 */
export function joursDansFenetre(
  ev: Pick<VehicleEventDto, 'startAt' | 'endAt'>,
  debutFenetre: Date,
  nbJours: number,
): { iso: string; jour: number; total: number }[] {
  const debut = new Date(ev.startAt);
  if (Number.isNaN(debut.getTime())) return [];
  const premier = startOfDay(debut);
  const total = dureeEnJours(ev);
  // Décalage (en jours) entre le premier jour de l'évènement et le premier jour de la fenêtre.
  const decalage = rangDuJour(ev, debutFenetre) - 1;
  const out: { iso: string; jour: number; total: number }[] = [];
  for (let i = Math.max(0, decalage); i < total && i < decalage + nbJours; i++) {
    out.push({ iso: localIso(addDays(premier, i)), jour: i + 1, total });
  }
  return out;
}

// ─── Prolonger une immobilisation : ce qui s'AJOUTE à la fenêtre bloquée ─────────────────────

/** Horizon regardé pour une immobilisation sans fin (incident « jusqu'à résolution ») — celui du formulaire. */
export const HORIZON_SANS_FIN_MS = 30 * 86400000;

/**
 * La fenêtre d'immobilisation EFFECTIVE [from, to] (ms) d'un évènement qui commence à `debutMs`,
 * toujours bornée : sa fin si elle est donnée ; sinon la journée pour une maintenance
 * (`effectiveBlockingEndMs`, la règle que le serveur applique aux réservations) et
 * `HORIZON_SANS_FIN_MS` pour un incident, qui bloque jusqu'à résolution.
 *
 * Contre-revue du 29/09 (S1) : le formulaire LISAIT les réservations sur cette fenêtre, mais la
 * création FIGEAIT la fenêtre brute — fin vide pour une maintenance d'une journée. Réorganiser
 * recevait alors « du mardi à ∅ », retombait sur « les 30 prochains jours » et proposait de
 * réaffecter tout le mois du véhicule pour une vidange. Une seule fonction pour lire et pour figer.
 *
 * Troisième passe (T17) : l'horizon d'une fin infinie se compte depuis `max(début, maintenant)`,
 * comme dans `fenetresAjoutees` — plus depuis le début. Le champ d'un incident s'intitule « Depuis
 * le » : un incident déclaré « depuis le 20/08 » et lu le 29/09 donnait [20/08, 19/09], une fenêtre
 * déjà passée ; le bloc des réservations affichait « rien à reprendre » pendant que le véhicule,
 * immobilisé jusqu'à résolution, gardait ses réservations du 1/10, du 3/10… `from` reste le début :
 * la création l'envoie comme `aPartirDe`, et le serveur coupe lui-même à max(maintenant, aPartirDe).
 * `maintenantMs` est obligatoire : aucun appelant ne peut l'oublier.
 */
export function fenetreImmobilisation(
  type: VehicleEventType,
  debutMs: number,
  finMs: number | null,
  maintenantMs: number,
): { from: number; to: number } {
  const eff = effectiveBlockingEndMs(type, debutMs, finMs);
  return { from: debutMs, to: Number.isFinite(eff) ? eff : Math.max(debutMs, maintenantMs) + HORIZON_SANS_FIN_MS };
}

// ─── Quatrième revue du 29/09 ────────────────────────────────────────────────────────────────

/** La taille de ce qui est libre : le plus grand nombre de places CONNU, et combien de libres n'en ont pas. */
export interface CapaciteLibres {
  /** Plus grand nombre de places parmi les libres dont on le connaît ; null si aucun. */
  max: number | null;
  /** Véhicules libres sans nombre de places renseigné — la borne `max` ne les couvre pas. */
  inconnus: number;
}

/**
 * La capacité des véhicules LIBRES (ceux qui ne sont pas dans `exclus`) : le plus grand nombre de
 * places connu, et le nombre de libres dont les places ne sont pas renseignées.
 *
 * « 12 places » (29/09) : le panneau du jour disait « 7 / 8 véhicule(s) disponible(s) aujourd'hui »
 * à quelqu'un qui cherchait 12 places — aucun véhicule du parc n'en a plus de 9. Le compte reste
 * vrai ; ce qui manquait, c'est la TAILLE de ce qui est libre.
 *
 * Revue du correctif (29/09) : un libre sans places renseignées (`seats` null — jamais saisi) était
 * sauté EN SILENCE, et « jusqu'à 9 places » devenait une borne fausse si ce libre-là est le minibus.
 * Il est désormais COMPTÉ à part, pour que le libellé le dise (même notion que
 * `excludedUnknownCapacity` côté serveur). Un nombre non positif ou non fini vaut « non renseigné ».
 */
export function placesMaxLibres(
  vehicules: readonly { id: string; seats?: number | null }[],
  exclus: ReadonlySet<string>,
): CapaciteLibres {
  let max: number | null = null;
  let inconnus = 0;
  for (const v of vehicules) {
    if (exclus.has(v.id)) continue;
    const s = v.seats;
    if (typeof s !== 'number' || !Number.isFinite(s) || s <= 0) {
      inconnus++;
      continue;
    }
    if (max === null || s > max) max = s;
  }
  return { max, inconnus };
}

/**
 * Le libellé qui suit « 7 / 8 » dans le panneau du jour : « véhicules libres aujourd'hui · jusqu'à
 * 9 places par véhicule ». La borne n'est présentée comme sûre que si TOUS les libres ont leurs
 * places renseignées ; sinon elle est qualifiée (« hors 1 sans nombre de places renseigné »), et si
 * aucun libre n'en a, on le dit au lieu d'inventer un chiffre.
 */
export function libelleVehiculesLibres(libres: number, capacite: CapaciteLibres | null, aujourdhui: boolean): string {
  const base = `${libres > 1 ? 'véhicules libres' : 'véhicule libre'} ${aujourdhui ? "aujourd'hui" : 'ce jour'}`;
  if (libres <= 0 || !capacite) return base;
  const { max, inconnus } = capacite;
  if (max === null) return inconnus > 0 ? `${base} · nombre de places non renseigné` : base;
  const borne = `${base} · jusqu'à ${max} place${max > 1 ? 's' : ''} par véhicule`;
  return inconnus > 0 ? `${borne}, hors ${inconnus} sans nombre de places renseigné` : borne;
}

/**
 * Une DEMANDE en attente (REQUESTED) que « Réaffecter » refusera à coup sûr : déjà commencée, ou qui
 * commence avant la coupe — max(maintenant, `aPartirDeMs`) arrondie à la minute. Calque du
 * `motifDemandeNonReaffectable` du serveur (reservations.service.ts) : une demande jamais validée
 * n'a pas de « suite » ferme à reprendre, elle se valide ou se refuse.
 *
 * Quatrième revue du 29/09 (C6) : le formulaire d'immobilisation la mettait d'office en
 * « Réaffecter », la comptait dans le bouton, et la création finissait sur un 400 connu d'avance.
 * ⚠️ Ce n'est PAS un partage de code avec le serveur : si sa règle change, celle-ci doit suivre
 * (les tests de agenda.utils.spec.ts rejouent les cas de la spec serveur).
 */
export function demandeNonReaffectable(
  status: string,
  debutMs: number,
  maintenantMs: number,
  aPartirDeMs: number,
): boolean {
  if (status !== 'REQUESTED' || Number.isNaN(debutMs)) return false;
  const coupe = Math.floor(Math.max(maintenantMs, Number.isNaN(aPartirDeMs) ? maintenantMs : aPartirDeMs) / 60_000) * 60_000;
  return debutMs < maintenantMs || debutMs < coupe;
}

/** Une réservation refusée telle que la feuille Réorganiser la connaît : son id (appariement) et ses dates. */
export interface RefuseeDatee {
  id?: string | null;
  startAt: string;
  endAt: string | null;
}

/**
 * Le serveur prendrait-il cette réservation dans le lot d'une fenêtre [from, to) pour cette action ?
 * Calque de `reorganiser()` (reservations.service.ts) — ⚠️ pas un partage de code : si sa règle
 * change, celle-ci doit suivre. La fenêtre commence à max(from, maintenant) (« jamais le passé ») ;
 *  - « réaffecter » prend ce qui la CHEVAUCHE : une fin connue après ce début, un début avant `to` ;
 *  - « annuler » et « décaler », ce qui COMMENCE dedans (début ≥ ce début, et ≤ `to`, borne de la
 *    lecture des évènements).
 * `null` = indécidable : date illisible, ou action inconnue.
 */
export function dansFenetreReorganisation(
  r: { startAt: string; endAt: string | null },
  action: string | undefined,
  fenetre: { from: string; to: string },
  maintenantMs: number,
): boolean | null {
  const debutR = Date.parse(r.startAt);
  const from = Date.parse(fenetre.from);
  const to = Date.parse(fenetre.to);
  if (Number.isNaN(debutR) || Number.isNaN(from) || Number.isNaN(to)) return null;
  const debut = Math.max(from, maintenantMs);
  // Fenêtre entièrement passée : le serveur refuse la simulation (400) — elle ne prend rien.
  if (debut >= to) return false;
  if (action === 'reaffecter') {
    // Le serveur écarte une réservation sans fin (`!!e.endAt`) : écartée quelle que soit la fenêtre.
    if (!r.endAt) return false;
    const finR = Date.parse(r.endAt);
    if (Number.isNaN(finR)) return null;
    return finR > debut && debutR < to;
  }
  if (action === 'annuler' || action === 'decaler') return debutR >= debut && debutR <= to;
  return null;
}

/**
 * La FENÊTRE LUE est-elle une cause possible du vide d'un lot limité aux refusées — une refusée
 * que la période de l'immobilisation (le pré-réglage) aurait prise et que cette fenêtre ne prend pas ?
 * Décidé sur le corps LU, jamais sur le signal courant : c'est la simulation affichée qu'on explique.
 *
 * Cinquième revue du 29/09 (C13) : décidé jusque-là sur l'égalité des chaînes from/to, il répondait
 * vrai dès que la fenêtre n'était plus celle du pré-réglage — « 30 jours » qui CONTIENT la réservation
 * du 10/10 affichait « hors de la fenêtre choisie » en tête, et « Revenir à la période » ramenait au
 * même vide. Désormais, sur les DATES, avec le prédicat du serveur :
 *  - pas de pré-réglage : vrai dès qu'une refusée datée n'est pas dans la fenêtre lue ;
 *  - fenêtre lue = pré-réglage : faux (rien n'a bougé) ;
 *  - toutes les refusées du lot (`corps.ids`) appariées PAR ID à leurs dates : vrai si l'une est hors
 *    de la fenêtre lue ET dans celle du pré-réglage (une refusée qui échappe aux deux — commencée,
 *    sans fin — n'est pas une affaire de fenêtre : revenir à la période n'y changerait rien) ;
 *  - une refusée sans date connue : repli par INCLUSION — la fenêtre lue, ramenée à maintenant,
 *    couvre-t-elle celle du pré-réglage ? Alors elle prend tout ce que celui-ci prenait : faux.
 *    Sinon (ou date illisible) : vrai — la cause reste « possible ».
 */
export function horsFenetrePreset(
  corps: { from: string; to: string; ids?: readonly string[]; action?: string },
  preset: { from: string; to: string } | null,
  refusees: readonly RefuseeDatee[] = [],
  maintenantMs: number = Date.now(),
): boolean {
  if (preset && corps.from === preset.from && corps.to === preset.to) return false;
  const parId = new Map<string, RefuseeDatee>();
  for (const r of refusees) if (r.id) parId.set(r.id, r);
  let inconnue = (corps.ids?.length ?? 0) === 0;
  for (const id of corps.ids ?? []) {
    const r = parId.get(id);
    const dansLue = r ? dansFenetreReorganisation(r, corps.action, corps, maintenantMs) : null;
    const dansPreset = r && preset ? dansFenetreReorganisation(r, corps.action, preset, maintenantMs) : null;
    if (dansLue === null || (preset && dansPreset === null)) {
      inconnue = true;
      continue;
    }
    if (!dansLue && (!preset || dansPreset)) return true;
  }
  if (!inconnue) return false;
  if (!preset) return true;
  const debutLu = Math.max(Date.parse(corps.from), maintenantMs);
  const debutPreset = Math.max(Date.parse(preset.from), maintenantMs);
  const finLue = Date.parse(corps.to);
  const finPreset = Date.parse(preset.to);
  if ([debutLu, debutPreset, finLue, finPreset].some(Number.isNaN)) return true;
  return !(debutLu <= debutPreset && finLue >= finPreset);
}

/**
 * « Commencer avant la fenêtre » est-il une cause POSSIBLE du vide (Annuler / Décaler ne prennent que
 * ce qui commence à partir de max(from lu, maintenant)) ? Vrai si une refusée du lot (`corps.ids`)
 * n'a pas de date connue — appariée PAR ID, comme dans `horsFenetrePreset` —, ou une date illisible,
 * ou si elle commence avant ce début ; faux si toutes commencent dedans ou après.
 * Sixième revue du 29/09 (suite de C13) : la clause tombait sans condition hors « réaffecter » —
 * « Annuler » sur la période de l'immobilisation, réservation refusée du 10/10 qui y commence,
 * annulée depuis : le vide citait encore « commencer avant la fenêtre », que ses dates excluent.
 */
function commencementAvantPossible(
  corps: { from: string; ids?: readonly string[] },
  refusees: readonly RefuseeDatee[],
  maintenantMs: number,
): boolean {
  const ids = corps.ids ?? [];
  if (ids.length === 0) return true;
  // Math.max propage NaN : un « from » illisible laisse la cause possible.
  const debut = Math.max(Date.parse(corps.from), maintenantMs);
  if (Number.isNaN(debut)) return true;
  const parId = new Map<string, RefuseeDatee>();
  for (const r of refusees) if (r.id) parId.set(r.id, r);
  return ids.some((id) => {
    const r = parId.get(id);
    const debutR = r ? Date.parse(r.startAt) : Number.NaN;
    return Number.isNaN(debutR) || debutR < debut;
  });
}

/**
 * Pourquoi un lot LIMITÉ AUX RÉSERVATIONS REFUSÉES (`ids`) est vide : les raisons POSSIBLES
 * seulement, selon le corps lu — le serveur ne dit pas laquelle, on ne l'invente pas.
 *
 * Quatrième revue du 29/09 (C7) : lot limité, puis « 7 jours » cliqué — la réservation refusée, à
 * J+10, sort de la fenêtre. Le vide disait « elle a pu être reprise ou annulée depuis » : faux, elle
 * était intacte. La fenêtre qui n'est plus celle de l'immobilisation vient désormais EN TÊTE —
 * seulement si elle écarte vraiment une refusée (C13, cinquième revue : décidé sur les dates, cf.
 * `horsFenetrePreset`) ; une fenêtre de 30 jours qui la contient ne la cite plus.
 * Sixième revue : « commencer avant la fenêtre » suit la même règle (`commencementAvantPossible`).
 */
export function raisonsVideRefusees(
  corps: { from: string; to: string; ids?: readonly string[]; origine: string; action: string },
  preset: { from: string; to: string } | null,
  refusees: readonly RefuseeDatee[] = [],
  maintenantMs: number = Date.now(),
): string {
  const pl = (corps.ids?.length ?? 0) > 1;
  const raisons: string[] = [];
  if (horsFenetrePreset(corps, preset, refusees, maintenantMs)) {
    raisons.push(
      `${pl ? 'elles sont' : 'elle est'} hors de la fenêtre choisie` +
        (preset ? ` (la période de l'immobilisation ${pl ? 'les' : 'la'} contenait)` : ''),
    );
  }
  raisons.push(`${pl ? 'elles ont' : 'elle a'} pu être reprise${pl ? 's' : ''} ou annulée${pl ? 's' : ''} depuis`);
  if (corps.origine === 'auto') raisons.push(`le filtre « Posées par l'agent » ${pl ? 'les ' : "l'"}écarte`);
  if (corps.action !== 'reaffecter' && commencementAvantPossible(corps, refusees, maintenantMs)) {
    raisons.push('commencer avant la fenêtre — Annuler et Décaler ne prennent que ce qui commence dedans');
  }
  return `${raisons.join(', ou ')}.`;
}

/**
 * Quatrième revue du 29/09 (C0) — le lot EXACT d'une simulation de Réorganiser, à renvoyer en `ids`
 * à l'application. Null si le serveur ne l'a pas rendu (API d'avant la revue), ou s'il ne décrit pas
 * le lot compté (id vide, ou pas `concernees` ids) : on garde alors le contrôle par le nombre seul,
 * plutôt qu'une liste qui ferait refuser (409) toutes les applications.
 */
export function lotExactDeSimulation(r: { concernees: number; lotIds?: readonly unknown[] | null }): string[] | null {
  const ids = r.lotIds;
  if (!Array.isArray(ids) || ids.length !== r.concernees) return null;
  if (!ids.every((id) => typeof id === 'string' && id !== '')) return null;
  return [...(ids as string[])];
}

/**
 * La vue DEMANDÉE de l'agenda doit-elle devenir la vue AFFICHÉE (contre-revue du 29/09, S2) ?
 *
 * Quand la vue demandée n'est pas permise, la page en affiche une autre. Tant que c'est une ATTENTE
 * (statut IA ou propositions en chargement : un ?vue=ia au démarrage, un « Voir » qui vient de
 * changer de société), la demande doit survivre — la vue apparaîtra d'elle-même. Mais un repli qui
 * dure n'est plus une attente : gardée, la demande rebasculait seule la page sur l'Assistant IA
 * au retour sur une société équipée, alors que l'onglet allumé était le Calendrier.
 *  - Assistant IA : définitif dès que statut et propositions sont ceux de la société affichée ;
 *  - les autres vues ne dépendent que des droits (relus au démarrage) : définitif seulement si la
 *    vue demandée a déjà été MONTRÉE puis a perdu son onglet.
 */
export function repliDefinitif(
  demandee: string,
  affichee: string,
  etatIaAJour: boolean,
  derniereMontree: string | null,
): boolean {
  if (demandee === affichee) return false;
  return demandee === 'ia' ? etatIaAJour : derniereMontree === demandee;
}

/**
 * Sur QUELLE fenêtre ajoutée ouvrir Réorganiser après une prolongation, et quelles réservations
 * restent en dehors (contre-revue du 29/09, R18).
 *
 * Début avancé ET fin repoussée donnent deux fenêtres, de part et d'autre de l'ANCIENNE — que
 * l'utilisateur a déjà tranchée à la création, parfois par « Laisser ». Ouvrir Réorganiser sur
 * [min, max] couvrait ce trou : la simulation comptait, et « Appliquer » réaffectait, des
 * réservations qu'on avait choisi de laisser. On ouvre donc sur UNE fenêtre ajoutée — celle qui
 * porte le plus de réservations (la plus proche à égalité) — et l'on rend les autres, pour que
 * l'appelant les nomme. `trouvees[i]` : les réservations lues sur `fenetres[i]`. Null si aucune.
 */
export function fenetreAReorganiser<T extends { id: string }>(
  fenetres: { from: number; to: number }[],
  trouvees: T[][],
): { fenetre: { from: number; to: number }; dedans: T[]; ailleurs: T[] } | null {
  let choix = -1;
  fenetres.forEach((_, i) => {
    const n = trouvees[i]?.length ?? 0;
    if (n > 0 && (choix < 0 || n > trouvees[choix].length)) choix = i;
  });
  if (choix < 0) return null;
  const dedans = trouvees[choix];
  const vues = new Set(dedans.map((r) => r.id));
  const ailleurs: T[] = [];
  trouvees.forEach((liste, i) => {
    if (i === choix) return;
    for (const r of liste ?? []) {
      if (vues.has(r.id)) continue; // à cheval sur les deux fenêtres : Réorganiser la reprend déjà
      vues.add(r.id);
      ailleurs.push(r);
    }
  });
  return { fenetre: fenetres[choix], dedans, ailleurs };
}

/**
 * Les intervalles [from, to] (ms) qu'une modification AJOUTE à l'immobilisation d'un évènement :
 * la nouvelle fenêtre bloquée moins l'ancienne, bornés à maintenant (le passé ne se reprend pas),
 * une fin infinie ramenée à `HORIZON_SANS_FIN_MS`.
 *
 * Revue du 29/09 (C45) : repousser la fin (« À clore »), modifier les dates ou glisser une
 * immobilisation laissait sans un mot les réservations prises sur les jours ajoutés — un véhicule
 * promis deux fois, le cas même que le bloc « Réservations pendant cette période » de la création
 * devait empêcher. On ne regarde que ce qui s'AJOUTE : les réservations de l'ancienne fenêtre ont
 * déjà été décidées (ou laissées exprès) à la création.
 *
 *  - `apres` n'immobilise pas (ou plus) : rien.
 *  - `avant` n'immobilisait pas (case cochée en modification) : toute la nouvelle fenêtre.
 *  - sinon : [nouveau début, ancien début] et [ancienne fin effective, nouvelle fin effective].
 */
export function fenetresAjoutees(
  avant: Pick<VehicleEventDto, 'type' | 'status' | 'blocksVehicle' | 'startAt' | 'endAt'> | null,
  apres: Pick<VehicleEventDto, 'type' | 'status' | 'blocksVehicle' | 'startAt' | 'endAt'>,
  maintenantMs: number,
): { from: number; to: number }[] {
  const fenetre = (ev: NonNullable<typeof avant>): { from: number; to: number } | null => {
    if (!isImmobilizingEvent(ev)) return null;
    const s = new Date(ev.startAt).getTime();
    if (Number.isNaN(s)) return null;
    const e = ev.endAt ? new Date(ev.endAt).getTime() : null;
    return { from: s, to: effectiveBlockingEndMs(ev.type, s, e != null && !Number.isNaN(e) ? e : null) };
  };
  const nouv = fenetre(apres);
  if (!nouv) return [];
  const anc = avant ? fenetre(avant) : null;
  const brutes = anc
    ? [
        { from: nouv.from, to: Math.min(nouv.to, anc.from) },
        { from: Math.max(nouv.from, anc.to), to: nouv.to },
      ]
    : [nouv];
  return brutes
    .map((w) => {
      const from = Math.max(w.from, maintenantMs);
      const to = Number.isFinite(w.to) ? w.to : from + HORIZON_SANS_FIN_MS;
      return { from, to };
    })
    .filter((w) => Number.isFinite(w.from) && w.to > w.from);
}
