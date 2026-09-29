import { formatDate } from '@angular/common';
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

// ─── IA désactivée par le client (29/09) : ce que l'agenda montre encore de l'IA ─────────────

/**
 * Le réglage BRUT de la société (`GET /api/ai/fleet-enabled`, soit `Fleet.aiEnabled`) tel que la page
 * a pu le lire : `true` / `false` ; `'illisible'` (rôle qui n'y a pas accès, super-admin sans société,
 * lecture en échec) ; `null` tant que la lecture n'est pas revenue.
 */
export type ReglageIaBrut = boolean | 'illisible' | null;

/**
 * ── L'INTERRUPTEUR DE LA SOCIÉTÉ — PAS « UNE CLÉ API ET L'INTERRUPTEUR » (revue du 29/09) ──────
 *
 * `AiStatusDto.enabled` n'est PAS l'interrupteur de la société seul : le serveur le calcule par
 * `isEnabledForFleet`, qui rend faux dès qu'il n'a aucune clé API (« config + interrupteur maître ON »,
 * dit le DTO). La démo en est le cas d'école : clés vides, société importée avec `aiEnabled: true`.
 * Lire `enabled` comme « le client a coupé l'IA » y masquait tout ce que l'agent produit — des
 * propositions DÉTERMINISTES (453 préparées sans aucune clé à la recette du 28/09) —, pendant que la
 * feuille Paramètres, qui lit le réglage brut, disait l'IA active. Et un serveur privé de sa clé aurait
 * éteint les propositions de cdef31, contre C3 (« un serveur sans clé ne doit pas éteindre le poste »).
 *
 *  - serveur AVEC clé (`configured`) : `enabled` EST l'interrupteur de la société — le serveur n'y
 *    ajoute que la clé, présente. Aucun appel de plus (la production) ;
 *  - serveur SANS clé : `enabled` ne dit rien du choix du client, le réglage brut le dit. En lecture :
 *    `null`, on attend (rien d'IA d'ici là). Illisible : faux — opt-in, rien d'IA sans confirmation ;
 *    un rôle qui ne peut pas le lire voit l'agenda sans IA sur un serveur sans clé, comme le reste de
 *    l'application (tout y suit `enabled` / `can`).
 *
 * Correctif de fond, le même jour : le statut porte désormais l'interrupteur de la société à part
 * (`AiStatusDto.fleetEnabled`, le choix du client sans l'exigence d'une clé). Quand il est là, il
 * décide, sans aucune lecture de plus ; le réglage brut ne sert plus qu'avec un serveur d'avant.
 */
export function interrupteurSociete(
  statut: { configured: boolean; enabled: boolean; fleetEnabled?: boolean },
  reglageBrut: ReglageIaBrut,
): boolean | null {
  if (typeof statut.fleetEnabled === 'boolean') return statut.fleetEnabled;
  if (statut.configured) return statut.enabled;
  if (reglageBrut === null) return null;
  return reglageBrut === true;
}

/** Les faits dont la page dispose pour décider de ce qu'elle montre de l'IA. */
export interface EtatIaAgenda {
  /**
   * Un statut IA est chargé ET c'est celui de la société du bandeau. Faux au démarrage, et juste
   * après un changement de société tant que le statut de la nouvelle n'est pas arrivé : l'interrupteur
   * lu à ce moment-là est celui de l'ANCIENNE société.
   */
  statutCharge: boolean;
  /**
   * L'interrupteur de la SOCIÉTÉ (`Fleet.aiEnabled`) : la société a-t-elle l'IA ? C'est
   * `interrupteurSociete`, pas `AiStatusService.enabled()` seul, qui exige aussi une clé API au
   * serveur (revue du 29/09). `null` : pas encore connu (serveur sans clé, réglage brut en lecture) —
   * on attend, comme pour un statut pas encore chargé.
   */
  interrupteur: boolean | null;
  /** Droit « Voir les réservations » (`reservations_view`) : sans lui, ni propositions ni Assistant IA. */
  canOptimize: boolean;
  /** Fonctions IA ouvertes par le serveur (`AiStatusService.can`, kill-switch par fonction compris). */
  fonctions: { capacity: boolean; agendaAgent: boolean; placement: boolean };
  /** Propositions de l'agent en mémoire (0 tant qu'elles ne sont pas lues). */
  nbPropositions: number;
  /** Les propositions en mémoire ont été lues pour la société du bandeau. */
  propositionsChargees: boolean;
}

/** Ce que l'agenda montre de l'IA — décidé en UN endroit (`visibiliteIa`). */
export interface VisibiliteIa {
  /**
   * L'IA est active pour la société du bandeau : statut chargé ET interrupteur de la société ouvert —
   * pendant une relecture (changement de société d'un super-admin), la dernière valeur décidée.
   */
  iaActive: boolean;
  /**
   * Les propositions de l'agent se LISENT (appel au serveur) et se MONTRENT : pilules pointillées de
   * la grille, entrée de légende, section du panneau du jour, badge de l'onglet.
   */
  propositions: boolean;
  /** L'onglet « Assistant IA ». */
  vueIa: boolean;
  /**
   * Plus rien à attendre pour trancher l'onglet : une vue « ia » demandée mais pas affichée (lien
   * ?vue=ia, onglet perdu quand l'IA est coupée) retombe POUR DE BON — voir `repliDefinitif`.
   */
  decide: boolean;
}

/**
 * ── IA DÉSACTIVÉE PAR LE CLIENT : L'AGENDA N'EN MONTRE PLUS RIEN (29/09) ─────────────────────
 *
 * Demande du propriétaire : « c'est le client qui désactive, donc on enlève les suggestions ». La
 * règle unique est l'interrupteur de la SOCIÉTÉ (`interrupteurSociete` — pas la clé API du serveur,
 * revue du 29/09), pour un statut chargé ET qui est celui de la société du bandeau — opt-in : rien
 * d'IA avant confirmation, jamais le statut de l'ancienne société juste après un changement de
 * bandeau. Le serveur ne change pas : un agent déjà activé poursuit ses passages DÉTERMINISTES ; on
 * ne montre plus ce qu'il propose.
 *
 *  - propositions : IA active et droit `reservations_view`. Avant, elles se lisaient et
 *    s'affichaient (pointillés, légende, panneau du jour, badge) quel que soit l'état de l'IA ;
 *  - onglet « Assistant IA » : IA active, droit, et une fonction ouverte OU des propositions à
 *    traiter. Avant, des propositions suffisaient — l'onglet restait, IA coupée comprise ;
 *  - `decide` : statut chargé et IA coupée (ou droit absent), plus rien ne peut ouvrir l'onglet — le
 *    repli est définitif tout de suite. IA active : des propositions peuvent encore l'ouvrir, on
 *    attend leur lecture (contre-revue S2). Statut (ou interrupteur) pas encore connu : on attend.
 *
 * ── UNE RELECTURE N'EST PAS UNE COUPURE (revue du 29/09) ──
 * `precedente` est la visibilité rendue au passage d'avant. Un super-admin qui passait de A à B, deux
 * sociétés équipées, voyait l'Assistant IA se démonter, le Calendrier et son chargement s'afficher le
 * temps d'un aller-retour, puis l'Assistant revenir — pastille « IA en cours… » rejouée comprise : le
 * statut de A ne comptait plus, celui de B n'était pas arrivé, et « pas connu » valait « coupée ».
 * Désormais, tant que l'interrupteur de la société du bandeau n'est pas connu, l'onglet et la pastille
 * gardent leur DERNIÈRE valeur ; les propositions, elles, ne se lisent ni ne se montrent avant
 * confirmation (celles de A ne sont pas celles de B, qui a peut-être coupé l'IA), et rien n'est
 * tranché. De même, IA active, l'onglet ne retombe pas le temps que des propositions en lecture le
 * rouvrent : une attente ne fait jamais DISPARAÎTRE un onglet, elle peut seulement tarder à en montrer
 * un. Au démarrage (rien d'avant), rien d'IA.
 */
export function visibiliteIa(e: EtatIaAgenda, precedente: VisibiliteIa | null = null): VisibiliteIa {
  const connu = e.statutCharge && e.interrupteur !== null;
  const ouverte = connu && e.interrupteur === true;
  const iaActive = connu ? ouverte : (precedente?.iaActive ?? false);
  const propositions = ouverte && e.canOptimize;
  const fonctionOuverte = e.fonctions.capacity || e.fonctions.agendaAgent || e.fonctions.placement;
  const vueIaTranchee = propositions && (fonctionOuverte || e.nbPropositions > 0);
  const decide = connu && (!propositions || e.propositionsChargees);
  const vueIa = decide ? vueIaTranchee : vueIaTranchee || (precedente?.vueIa ?? false);
  return { iaActive, propositions, vueIa, decide };
}

/** Deux visibilités identiques — pour ne pas propager un objet neuf qui ne change rien. */
export function memeVisibiliteIa(a: VisibiliteIa, b: VisibiliteIa): boolean {
  return a.iaActive === b.iaActive && a.propositions === b.propositions && a.vueIa === b.vueIa && a.decide === b.decide;
}

/**
 * Les propositions de l'agent que la page MONTRE (29/09) : aucune quand elles ne sont pas visibles
 * (IA coupée, statut pas encore chargé) — même le temps que la liste en mémoire soit vidée —, sinon
 * celles du périmètre de la grille (véhicule, puis véhicules du groupe), comme les évènements.
 * Le filtre de TYPE ne s'y applique pas : une proposition n'a pas de type, elle deviendra une
 * réservation si on la valide.
 */
export function propositionsDuPerimetre<T extends { vehicleId: string }>(
  propositions: readonly T[],
  visibles: boolean,
  perimetre: { vehicleId: string; vehiculesDuGroupe: ReadonlySet<string> | null },
): T[] {
  if (!visibles) return [];
  const { vehicleId, vehiculesDuGroupe } = perimetre;
  return propositions.filter(
    (p) => (!vehicleId || p.vehicleId === vehicleId) && (!vehiculesDuGroupe || vehiculesDuGroupe.has(p.vehicleId)),
  );
}

/**
 * Nb de propositions par jour (clé ISO locale) — la couche POINTILLÉE de la grille.
 *
 * Compte les PROPOSITIONS, pas les véhicules distincts : deux tournées prévues le même jour sur le
 * même véhicule sont deux créneaux à valider, et les fondre en « 1 » cacherait du travail (l'inverse
 * des couches activité et prévision, qui répondent à « combien de véhicules »). Une date illisible
 * ne pose rien.
 */
export function propositionsParJour(propositions: readonly { startAt: string }[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const p of propositions) {
    const d = new Date(p.startAt);
    if (Number.isNaN(d.getTime())) continue;
    const key = localIso(d);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Le bouton d'origine « Posées par l'agent » de Réorganiser est-il montré (29/09) ?
 *
 * IA active : toujours, comme avant. IA coupée : ce n'est plus un geste de l'agent mais un filtre sur
 * de VRAIES réservations — posées jadis par l'agent, ou par ses passages déterministes en mode
 * automatique. Il reste tant qu'il en compte au moins une ; à 0, ou tant que le compte n'est pas
 * connu, il disparaît (rien de l'agent avant de savoir qu'il y a quelque chose). Sélectionné, il
 * n'est jamais retiré sous le doigt : le filtre actif doit rester visible, et se quitter.
 *
 * Revue du 29/09 : le compte est celui de la SOCIÉTÉ, mémorisé (`CompteAgentMemorise`) — pas celui
 * de la dernière simulation, remis à « inconnu » à chaque ouverture et à chaque erreur.
 */
export function origineAgentVisible(e: { iaActive: boolean; compteAgent: number | null; selectionnee: boolean }): boolean {
  if (e.iaActive || e.selectionnee) return true;
  return e.compteAgent !== null && e.compteAgent > 0;
}

/**
 * Le dernier compte CONNU des réservations posées par l'agent sur une société (revue du 29/09) — ce
 * qui décide du bouton « Posées par l'agent » de Réorganiser quand l'IA est coupée.
 *
 * Le bouton lisait le compte de la simulation AFFICHÉE : `null` à chaque ouverture (la feuille oublie
 * sa lecture), `null` après une simulation en erreur, et celui du VÉHICULE choisi. Chaque ouverture
 * le montrait donc en retard — « Toutes » seul et pleine largeur, puis « Posées par l'agent »
 * surgissant au retour de la simulation —, une erreur le retirait, un véhicule sans réservation de
 * l'agent aussi. Désormais : `totaux.agent` (toute la société sur la fenêtre simulée, avant les
 * filtres de véhicule et d'origine), gardé par société du bandeau tant que la page vit — la feuille y
 * reste montée : rouverte, elle sait déjà. Seule une simulation qui rend des totaux le remplace ; une
 * erreur ou une réponse sans totaux (API antérieure) ne l'efface pas.
 */
export interface CompteAgentMemorise {
  /** Société du bandeau lors de la simulation qui l'a donné (`null` : aucune — hors super-admin, le plus souvent). */
  societe: string | null;
  n: number;
}

/** La mémoire après une simulation RÉUSSIE de la société `societe`. */
export function memoriserCompteAgent(
  memo: CompteAgentMemorise | null,
  societe: string | null,
  r: { totaux?: { agent: number } | null },
): CompteAgentMemorise | null {
  return r.totaux ? { societe, n: r.totaux.agent } : memo;
}

/** Le compte à montrer pour la société du bandeau — `null` (inconnu) s'il est celui d'une autre. */
export function compteAgentMemorise(memo: CompteAgentMemorise | null, societe: string | null): number | null {
  return memo !== null && memo.societe === societe ? memo.n : null;
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

/**
 * ── RÉORGANISER : « RIEN À RÉORGANISER » (29/09, piste 1 du propriétaire) ───────────────────────
 *
 * « Réorganiser est vide chez cdef31 et on n'y comprend rien » : la feuille alignait 30 véhicules à
 * « (0) », des compteurs à 0 et deux conseils sans objet, et ne disait qu'en DERNIÈRE ligne qu'il n'y
 * avait aucune réservation à venir — cdef31 n'avait que des propositions de l'agent, qui ne sont pas
 * des réservations. Quand il n'y a vraiment rien, la feuille le dit EN TÊTE et ne montre rien d'autre.
 *
 * « Vraiment rien » = aucune réservation vivante ne chevauche les 30 prochains jours (la fenêtre la
 * plus large de la feuille), dans la société. Deux sources, la même règle côté serveur :
 *  - la simulation LUE, quand elle couvre tout (origine « Toutes », sans véhicule ni liste blanche) :
 *    son `parVehicule` compte tout ce qui chevauche sa fenêtre — sur 30 jours c'est la réponse ; sur
 *    une fenêtre plus courte, un vide ne dit rien des jours d'après : seul le compte du menu le dit ;
 *  - avant toute simulation, le compte du menu (`GET /reservations/reorganisables`) — la feuille
 *    s'ouvre alors directement sur l'explication, sans clignoter.
 * Jamais pour une feuille ouverte DEPUIS un geste (véhicule, période ou refusées du formulaire
 * d'indisponibilité) : son vide a ses propres mots, et ses critères restent utiles. Jamais sur un
 * compte-rendu d'application : il dit ce qui vient d'être fait.
 */
export interface EtatRienAReorganiser {
  /** Ouverte depuis un geste de la page (pré-réglage : véhicule, période, refusées). */
  ouverteDepuisUnGeste: boolean;
  /** La dernière lecture de la feuille, `null` avant la première réponse. */
  lecture: {
    /** Vrai pour une simulation ; faux pour le compte-rendu d'une application. */
    simulation: boolean;
    origine: string;
    avecVehicule: boolean;
    avecListeBlanche: boolean;
    /** Durée de la fenêtre lue, en jours. */
    jours: number;
    /** Réservations qui chevauchent la fenêtre lue (somme de `parVehicule`). */
    chevauchantes: number;
  } | null;
  /** Compte du menu sur 30 jours (`reorganisables.total`), `null` = inconnu. */
  compteMenu: number | null;
}

export function rienAReorganiser(e: EtatRienAReorganiser): boolean {
  if (e.ouverteDepuisUnGeste) return false;
  const l = e.lecture;
  if (!l) return e.compteMenu === 0;
  if (!l.simulation) return false;
  if (l.origine !== 'toutes' || l.avecVehicule || l.avecListeBlanche) return false;
  if (l.chevauchantes > 0) return false;
  return l.jours >= 30 || e.compteMenu === 0;
}

/**
 * ── RÉORGANISER AGIT AUSSI SUR LES PROPOSITIONS DE L'AGENT (29/09, piste 3 du propriétaire) ─────
 *
 * Chez cdef31, l'agenda porte les propositions de l'agent (307 le 29/09) et aucune réservation à
 * venir : Réorganiser, qui ne prenait que des réservations, n'y trouvait rien. Il écarte désormais un
 * LOT de propositions (une fenêtre, un véhicule ou tous — `POST /agenda/agent/proposals/ecarter`).
 * Les décisions de la page et de la feuille, écrites ici pour être testées :
 *  - l'entrée du menu « ⋯ » n'est grisée que s'il n'y a NI réservation NI proposition ; s'il n'y a
 *    que des propositions, elle le dit sous son libellé (`menuReorganiser`) ;
 *  - la feuille s'ouvre sur les propositions quand il n'y a qu'elles (`quoiALOuverture`) ;
 *  - l'onglet « Propositions de l'agent » n'existe qu'IA active : IA coupée par le client, rien de
 *    l'agent nulle part (`ongletPropositionsVisible`).
 */
export type QuoiReorganiser = 'reservations' | 'propositions';

export interface EtatMenuReorganiser {
  /** Réservations qui chevauchent les 30 prochains jours (`reorganisables.total`), `null` = inconnu. */
  reservations: number | null;
  /** Fenêtre de ce compte, en jours. */
  jours: number;
  /** IA active pour la société du bandeau : sinon, les propositions ne comptent pas. */
  iaActive: boolean;
  /**
   * Propositions que Réorganiser écarterait sur ces jours — relecture du 29/09 : lues par la
   * simulation de la feuille (mêmes véhicules gérés, même fenêtre), plus le compte de la page (toute la
   * société, figé depuis son chargement). `null` = pas encore lu, ou lecture en échec.
   */
  propositions: number | null;
}

/**
 * L'entrée « Réorganiser » du menu : grisée ou non, son libellé, et la ligne sous le libellé (`null` =
 * rien à dire). Libellé « Réorganiser » quand elle reprend aussi des propositions (IA active et au
 * moins une), comme le titre de la feuille ; « Réorganiser des réservations » sinon.
 */
export function menuReorganiser(e: EtatMenuReorganiser): { grisee: boolean; ligne: string | null; libelle: string } {
  const inconnu = e.iaActive && e.propositions === null;
  const n = e.iaActive ? Math.max(0, e.propositions ?? 0) : 0;
  const libelle = n > 0 ? 'Réorganiser' : 'Réorganiser des réservations';
  // Compte inconnu (pas encore lu, lecture en échec) ou des réservations : active, sans rien dire.
  if (e.reservations !== 0) return { grisee: false, ligne: null, libelle };
  if (n > 0) {
    return { grisee: false, ligne: `Aucune réservation à venir · ${n} proposition${n > 1 ? 's' : ''} de l'agent`, libelle };
  }
  // IA active, propositions pas encore lues : on ne grise pas sur une supposition.
  if (inconnu) return { grisee: false, ligne: null, libelle };
  return {
    grisee: true,
    ligne: e.iaActive
      ? `Aucune réservation à venir sur ${e.jours} jours, ni proposition de l'agent`
      : `Aucune réservation à venir sur ${e.jours} jours`,
    libelle,
  };
}

/**
 * Sur quoi la feuille s'ouvre. Les propositions quand il n'y a QU'elles : aucune réservation sur 30
 * jours (compte du menu connu, à 0) et des propositions visibles. Ouverte depuis un geste (des
 * réservations refusées à reprendre), elle garde les réservations — le geste en a apporté.
 */
export function quoiALOuverture(e: {
  ouverteDepuisUnGeste: boolean;
  reservations: number | null;
  iaActive: boolean;
  propositions: number;
}): QuoiReorganiser {
  if (e.ouverteDepuisUnGeste || !e.iaActive || e.propositions <= 0) return 'reservations';
  return e.reservations === 0 ? 'propositions' : 'reservations';
}

/**
 * L'onglet « Réservations | Propositions de l'agent » en tête de la feuille. Jamais IA coupée, jamais
 * sans société (super-admin sur « Toutes ») ; sinon dès que des propositions existent — dans la page
 * ou dans la dernière liste de la feuille —, et toujours quand on y est.
 */
export function ongletPropositionsVisible(e: {
  iaActive: boolean;
  sansSociete: boolean;
  quoi: QuoiReorganiser;
  propositionsPage: number;
  /** Total de la dernière liste par véhicule des propositions (`null` = pas encore lue). */
  propositionsListe: number | null;
}): boolean {
  if (!e.iaActive || e.sansSociete) return false;
  return e.quoi === 'propositions' || e.propositionsPage > 0 || (e.propositionsListe ?? 0) > 0;
}

/** Le compte d'une liste par véhicule : celui du véhicule choisi (0 s'il n'y est pas), sinon le total ; `null` = liste inconnue. */
export function compteDeLaListe(
  liste: readonly { vehicleId: string; n: number }[] | null,
  vehicleId: string,
): number | null {
  if (!liste) return null;
  return vehicleId ? (liste.find((v) => v.vehicleId === vehicleId)?.n ?? 0) : liste.reduce((s, v) => s + v.n, 0);
}

/**
 * Propositions encore à venir d'UN véhicule qui chevauchent une période — celle d'une immobilisation
 * qu'on vient de poser : « un véhicule part au garage, ses propositions n'ont plus lieu d'être » (il
 * n'est plus réservable, « Réserver » les refuserait). Même règle que le serveur : une proposition
 * commencée ne compte pas (elle ne se réserve plus).
 */
export function propositionsSurPeriode(
  propositions: readonly { vehicleId: string; startAt: string; endAt: string }[],
  vehicleId: string,
  periode: { from: number; to: number },
  maintenantMs: number,
): number {
  return propositions.filter((p) => {
    if (p.vehicleId !== vehicleId) return false;
    const debut = Date.parse(p.startAt);
    const fin = Date.parse(p.endAt);
    return debut >= maintenantMs && debut < periode.to && fin > periode.from;
  }).length;
}

/**
 * Ce que la page propose après une immobilisation (création, ou jours ajoutés d'une prolongation) —
 * relecture du 29/09 : la fenêtre qui porte le plus de propositions du véhicule, leur nombre, et la
 * période du pré-réglage de la feuille. `null` = rien à proposer.
 *
 * `finInfinie` (incident sans date de fin) : la fenêtre la plus lointaine s'arrête à un horizon de 30
 * jours que PERSONNE n'a saisi — le pré-réglage part alors sans fin (`to: null`), et la feuille dit
 * « à partir du …, HH:mm (30 jours) » au lieu d'une date de fin inventée (« du 29 sept. au 29 oct. »).
 * Même fenêtre envoyée au serveur : seule la phrase change.
 */
export function propositionsSousImmobilisation(
  propositions: readonly { vehicleId: string; startAt: string; endAt: string }[],
  vehicleId: string,
  fenetres: readonly { from: number; to: number }[],
  finInfinie: boolean,
  maintenantMs: number,
): { n: number; from: string; to: string | null } | null {
  let meilleure: { from: number; to: number } | null = null;
  let n = 0;
  for (const w of fenetres) {
    const k = propositionsSurPeriode(propositions, vehicleId, w, maintenantMs);
    if (k > n) {
      n = k;
      meilleure = w;
    }
  }
  if (!meilleure) return null;
  return { n, from: new Date(meilleure.from).toISOString(), to: finDuPreset(meilleure, fenetres, finInfinie) };
}

/**
 * La fin à donner à un pré-réglage de Réorganiser pour la fenêtre `w` parmi `fenetres` : `null` si
 * l'immobilisation n'a pas de fin (`finInfinie`) et que `w` est la fenêtre qui court jusqu'à l'horizon
 * — la dernière. Sert aussi au renvoi des réservations refusées (même date inventée, même correction).
 */
export function finDuPreset(
  w: { from: number; to: number },
  fenetres: readonly { from: number; to: number }[],
  finInfinie: boolean,
): string | null {
  const derniere = Math.max(...fenetres.map((f) => f.to), w.to);
  return finInfinie && w.to >= derniere ? null : new Date(w.to).toISOString();
}

/**
 * La période imposée à la feuille Réorganiser, en toutes lettres (« du lun. 5 oct. au mer. 7 oct. »).
 * Le début est ramené à maintenant, comme le fait le serveur (il ne regarde jamais le passé) ; sans
 * date de fin : « à partir du ven. 10 oct., 09:00 (30 jours) ».
 *
 * Recette démo du 29/09 (piste 3) — une immobilisation d'UNE journée court de 00:00 à 00:00 le
 * lendemain : elle se lisait « du mer. 30 sept. au jeu. 1 oct. », comme si le jeudi en était. Une
 * fin à minuit pile appartient au jour d'AVANT : « le mer. 30 sept. ».
 */
export function libellePeriode(
  fx: { from: string; to: string; sansFin: boolean },
  maintenantMs: number,
  joursSansFin: number,
): string {
  const debut = new Date(Math.max(new Date(fx.from).getTime(), maintenantMs));
  const jour = (d: Date) => formatDate(d, 'EEE d MMM', 'fr');
  const heure = (d: Date) => formatDate(d, 'HH:mm', 'fr');
  if (fx.sansFin) return `à partir du ${jour(debut)}, ${heure(debut)} (${joursSansFin} jours)`;
  const finBrute = new Date(fx.to);
  const aMinuit = (d: Date) => d.getHours() === 0 && d.getMinutes() === 0 && d.getSeconds() === 0 && d.getMilliseconds() === 0;
  const finMinuit = aMinuit(finBrute) && finBrute.getTime() > debut.getTime();
  const fin = finMinuit ? new Date(finBrute.getTime() - 1) : finBrute;
  if (debut.toDateString() === fin.toDateString()) {
    if (finMinuit && aMinuit(debut)) return `le ${jour(debut)}`;
    return `le ${jour(debut)} de ${heure(debut)} à ${finMinuit ? '24:00' : heure(fin)}`;
  }
  return `du ${jour(debut)} au ${jour(fin)}`;
}
