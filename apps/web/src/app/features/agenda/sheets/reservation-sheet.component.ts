import { swallow } from '../../../core/error/swallow';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe, DecimalPipe, NgClass } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorMessage } from '../../../core/error/api-error';
import {
  LucideAngularModule, Sparkles, Check, AlertTriangle, Loader, CalendarCheck, Inbox, X, User, Baby, Users,
} from 'lucide-angular';
import {
  DORMANT_STOP_COUNTING_MS,
  effectiveBlockingEndMs,
  formatSilenceLabel,
  isImmobilizingEvent,
  isVehicleDormant,
  type ChildSeatAvailabilityDto,
  type ReservationCriteria,
  type ReservationGroupDto,
  type VehicleEventDto,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { AgendaApiService } from '../../../core/services/agenda.service';
import { AiApiService } from '../../../core/services/ai.service';
import { AiStatusService } from '../../../core/services/ai-status.service';
import { AuthService } from '../../../core/services/auth.service';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';
import { PermissionsService } from '../../../core/services/permissions.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { BottomSheetComponent } from '../../../shared/ui/bottom-sheet/bottom-sheet.component';
import { DateTimeRangePickerComponent } from '../../../shared/ui/datetime-range/datetime-range-picker.component';
import { placesMaxLibres, type CapaciteLibres } from '../agenda.utils';

export interface ReservationSheetVehicle {
  id: string;
  plate: string | null;
  brand?: string | null;
  model?: string | null;
  /**
   * Boîtier du véhicule — présence (`id`) et dernière parole (`lastSeenAt`), seule source
   * de la dormance. Optionnel : un appelant qui ne le fournit pas garde le comportement
   * actuel (aucun véhicule signalé). La forme est celle de `VehicleDetailDto.tracker`,
   * donc l'agenda l'alimente déjà sans rien changer chez lui.
   */
  tracker?: { id: string; lastSeenAt: string | null } | null;
  /**
   * Hors service DÉCLARÉ par un super-admin (accident, boîtier débranché, immobilisation durable).
   * Le serveur refuse de réserver un tel véhicule (409) : autant ne pas le laisser choisir.
   */
  outOfServiceReason?: string | null;
  /** Sièges auto INSTALLÉS à bord (2026-09-28) : ils couvrent le besoin avant le stock. */
  childSeatsBaby?: number | null;
  childSeatsChild?: number | null;
  /** Groupe du véhicule — le DÉFAUT du groupe de réservation, jamais son maître. */
  group?: { id: string; name: string } | null;
  /**
   * Société du véhicule (revue du 29/09, C40). Les listes de groupes se construisent PAR SOCIÉTÉ :
   * un super-admin sans société choisie recevait tout le parc, donc les « Nord » de deux clients
   * côte à côte, indiscernables — et le serveur refuse (400) le groupe d'une autre société.
   * `VehicleDetailDto` le porte déjà : l'agenda n'a rien à changer.
   */
  fleetId?: string;
  /**
   * Places du véhicule, conducteur compris (29/09, « 12 places »). Affichées dans la liste et
   * comparées à « Places min. » AVANT l'envoi : on sait tout de suite qu'aucun véhicule n'est assez
   * grand, au lieu de lire « aucun véhicule libre » après coup. `VehicleDetailDto` le porte déjà.
   */
  seats?: number | null;
}

/** Valeur du sélecteur de groupe quand l'utilisateur veut saisir un nom qui n'est pas un groupe de la société. */
const GROUPE_AUTRE = '__autre__';
/**
 * Demande en « Auto » (aucun véhicule choisi) : le groupe sera celui du véhicule que le serveur
 * attribuera. Le champ le DIT au lieu d'afficher « — Aucun groupe — », et rien n'est envoyé.
 */
const GROUPE_DEFAUT = '__defaut__';
/**
 * Carte « À valider » : préfixe d'une option « groupe saisi en texte libre sur la demande » (id null) —
 * la valeur est `__pose__:<nom>`, pour que deux noms libres différents ne se confondent pas.
 */
const GROUPE_POSE_LIBRE = '__pose__';
/**
 * Carte « À valider » de plusieurs véhicules dont les groupes par défaut DIFFÈRENT (revue du 29/09,
 * R10) : l'option « Groupes différents (Nord, Sud) », présélectionnée, qui ne change rien — chaque
 * véhicule garde le sien. Tout autre choix s'applique à tous.
 */
const GROUPE_PAR_VEHICULE = '__par_vehicule__';

/** Ce que le sélecteur d'une carte de la file montre sans geste, et ce qu'il propose. */
interface CarteGroupe {
  /** Valeur présélectionnée : le défaut commun des véhicules de la carte, ou GROUPE_PAR_VEHICULE. */
  defaut: string;
  options: GroupeOption[];
  /** « Groupes différents (Nord, Sud) » quand les défauts diffèrent, sinon null. */
  mixte: string | null;
}

/** Une option de groupe ; `note` précise une option qui n'est pas (ou plus) portée par un véhicule listé. */
interface GroupeOption {
  id: string;
  name: string;
  note?: string;
}

/**
 * Le groupe posé sur une réservation (`metadata.group`), lu avec les MÊMES règles que le serveur
 * (`ReservationsService.groupeDe`) : un nom non vide, un id facultatif. Sinon null.
 */
function groupePoseDe(metadata: unknown): ReservationGroupDto | null {
  const g = (metadata as { group?: unknown } | null | undefined)?.group;
  if (!g || typeof g !== 'object') return null;
  const { id, name } = g as { id?: unknown; name?: unknown };
  if (typeof name !== 'string' || !name.trim()) return null;
  return { id: typeof id === 'string' && id ? id : null, name: name.trim() };
}

/** « 1 bébé · 2 enfant », ou null quand tout est à zéro. */
export function siegesLabel(c: { baby: number; child: number } | null | undefined): string | null {
  if (!c) return null;
  const parts = [c.baby > 0 ? `${c.baby} bébé` : '', c.child > 0 ? `${c.child} enfant` : ''].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/** Libellé court d'un motif de mise hors service (même vocabulaire que la fiche véhicule). */
export function horsServiceLabel(reason: string | null | undefined): string | null {
  switch (reason) {
    case 'ACCIDENT': return 'accidenté';
    case 'TRACKER_UNPLUGGED': return 'boîtier débranché';
    case 'IMMOBILIZED': return 'immobilisé durablement';
    default: return reason ? 'hors service' : null;
  }
}

/**
 * Places d'un véhicule non renseignées : absentes, nulles, négatives ou non finies. MÊME notion que
 * `placesMaxLibres` (agenda.utils.ts) et que `excludedUnknownCapacity` côté serveur.
 */
export function placesInconnues(seats: number | null | undefined): boolean {
  return typeof seats !== 'number' || !Number.isFinite(seats) || seats <= 0;
}

/**
 * Places PASSAGERS d'un véhicule : ses places moins celle de SON conducteur (revue r5 du 29/09, C7).
 * « Places min. » se lit « conducteur compris » : un groupe de 13 = 12 passagers + 1 conducteur. Réparti
 * sur deux véhicules, il lui faut DEUX conducteurs — le second n'est pas pris sur le groupe (cdef31
 * transporte des enfants : un adulte de plus, pas un passager de moins).
 */
export function placesPassagers(seats: number): number {
  return Math.max(0, seats - 1);
}

/**
 * « 12 places » (29/09) — la plus petite combinaison de véhicules qui transporte `passagers` passagers,
 * CHAQUE véhicule emportant son conducteur (revue r5, C7) : un 9 places offre 8 places passagers. La
 * version d'avant sommait les places conducteur compris — « Places min. 13 » (12 passagers) donnait
 * 9 + 4 = « 13 places », soit 8 + 3 = 11 places passagers une fois les DEUX conducteurs assis : il
 * manquait un siège. Ici : 12 passagers → 9 + 5 (8 + 4) ; 11 → 9 + 4 (8 + 3) ; 17 → 9 + 9 + 4.
 *
 * Les plus grands d'abord — le moins de véhicules possible —, puis le DERNIER est remplacé par le plus
 * petit véhicule restant qui suffit encore. Un véhicule d'une place (le conducteur seul) n'apporte
 * rien : écarté. Null si les véhicules fournis, tous ensemble, n'y suffisent pas. L'ordre d'entrée
 * départage les égalités (le trier par plaque).
 */
export function combinaisonMinimale<T extends { seats: number }>(libres: readonly T[], passagers: number): T[] | null {
  if (!(passagers > 0)) return null;
  const cap = (v: T) => placesPassagers(v.seats);
  const tries = libres.filter((v) => cap(v) > 0).sort((a, b) => cap(b) - cap(a));
  const pris: T[] = [];
  let somme = 0;
  for (const v of tries) {
    if (somme >= passagers) break;
    pris.push(v);
    somme += cap(v);
  }
  if (somme < passagers || pris.length === 0) return null;
  const avant = pris.slice(0, -1);
  const reste = passagers - avant.reduce((t, v) => t + cap(v), 0);
  const plusPetit = tries
    .filter((v) => !avant.includes(v) && cap(v) >= reste)
    .sort((a, b) => cap(a) - cap(b))[0];
  return plusPetit ? [...avant, plusPetit] : pris;
}

/**
 * Le toast d'une répartition envoyée sans refus, bâti sur les statuts CUMULÉS de tout le groupe (envoi
 * précédent compris) — revue r5 du 29/09, C10. Le serveur tranche le statut VÉHICULE PAR VÉHICULE
 * (`reservations_manage` résolu par véhicule, groupe, puis ALL) : une même répartition peut rendre une
 * réservation ferme ET une demande. Un seul booléen « au moins une demande » annonçait alors
 * « 2 demandes déposées — à valider » pour une réservation déjà placée dans l'agenda.
 */
export function toastRepartition(
  creees: readonly { plate: string; statut: string }[],
  complement: boolean,
): { titre: string; corps: string } {
  const fermes = creees.filter((c) => c.statut === 'CONFIRMED').map((c) => c.plate);
  const attente = creees.filter((c) => c.statut !== 'CONFIRMED').map((c) => c.plate);
  const f = fermes.length;
  const a = attente.length;
  const titre = complement
    ? 'Groupe complété'
    : a === 0
      ? `${f} réservation${f > 1 ? 's' : ''} créée${f > 1 ? 's' : ''}`
      : f === 0
        ? `${a} demande${a > 1 ? 's' : ''} déposée${a > 1 ? 's' : ''}`
        : `${f} réservée${f > 1 ? 's' : ''}, ${a} demande${a > 1 ? 's' : ''} à valider`;
  const corps =
    a === 0
      ? `${fermes.join(' + ')} — ${f > 1 ? 'placées' : 'placée'} dans l'agenda.`
      : f === 0
        ? `${attente.join(' + ')} — à valider par un gestionnaire.`
        : `${fermes.join(' + ')} — ${f > 1 ? 'placées' : 'placée'} dans l'agenda · ${attente.join(' + ')} — à valider par un gestionnaire.`;
  return { titre, corps };
}

/** Un véhicule d'une répartition proposée, dans l'ordre d'envoi. */
interface VehiculeReparti {
  id: string;
  plate: string;
  seats: number;
}

/** La proposition de répartition d'un groupe trop grand pour un seul véhicule. */
interface Repartition {
  /** Véhicules à réserver, dans l'ordre d'envoi (celui qui porte les sièges auto d'abord). Vide = pas de répartition. */
  vehicules: VehiculeReparti[];
  total: number;
  /** « Répartir le groupe : A (9 pl.) + B (5 pl.) = 14 places, dont 2 conducteurs : 12 places passagers pour 12 passagers », ou null. */
  texte: string | null;
  /** Pourquoi aucune répartition n'est proposée, ou null. */
  raison: string | null;
  /** Où partent les sièges auto demandés (ou pourquoi ils risquent d'être refusés), ou null. */
  avisSieges: string | null;
  /** Vrai quand la proposition COMPLÈTE un groupe déjà en partie retenu ({@link RepartitionEntamee}). */
  complement: boolean;
}

/** Bilan d'une répartition envoyée : ce qui a été créé, ce qui a été refusé (motif du serveur tel quel). */
interface BilanRepartition {
  creees: { plate: string; statut: string }[];
  refusees: { plate: string; motif: string }[];
}

/**
 * Revue du 29/09 — une répartition envoyée en partie seulement (une ligne créée, l'autre refusée) sur
 * CE créneau et pour CETTE société. La proposition suivante ne porte plus que sur le RESTE : sans cela,
 * elle repartait du groupe entier — un second clic réservait un second 9 places pour un groupe de 12
 * (gestionnaire), ou redéposait une demande REQUESTED sur le même véhicule, que le vivier (CONFIRMED et
 * IN_PROGRESS seulement) laissait « libre » (demandeur).
 */
interface RepartitionEntamee {
  /** Créneau + société ({@link ReservationSheetComponent.cleRepartition}) : un autre créneau repart de zéro. */
  cle: string;
  /** Véhicules déjà tentés — créés (quel que soit leur statut) OU refusés : ils sortent de la proposition. */
  pris: string[];
  /**
   * Places PASSAGERS des véhicules créés (places − 1 : chacun emporte son conducteur — revue r5, C7) :
   * la proposition vise les passagers du groupe MOINS ceux-ci. Compter toutes leurs places retirait
   * aussi le siège conducteur du besoin, et le complément sous-estimait le reste d'un passager.
   */
  passagersRetenus: number;
  /** Réservations créées, dans l'ordre, AVEC leur statut : le toast final dit ce qui est ferme et ce qui attend (C10). */
  creees: { plate: string; statut: string }[];
  /** Les sièges auto sont partis avec une demande créée : le complément ne les redemande pas. */
  siegesPlaces: boolean;
}

function toLocalInput(d: Date): string {
  const p = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Sprint 9 (consolidation) — Réservations depuis l'Agenda. Deux modes dans une seule
 * feuille : « Demander » (créneau + critères + suggestion IA du meilleur véhicule) et
 * « À valider » (file des demandes REQUESTED → valider/refuser). Aucune page séparée.
 */
@Component({
  selector: 'app-reservation-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, NgClass, LucideAngularModule, BottomSheetComponent, DateTimeRangePickerComponent],
  template: `
    <app-bottom-sheet [open]="open()" ariaLabel="Réservations" (closed)="closed.emit()">
      <div class="rs">
        <div class="rs-head">
          <h3 class="rs-title"><lucide-icon [img]="CalendarCheckIcon" [size]="15"></lucide-icon> Réservations</h3>
          <button type="button" class="rs-x" (click)="closed.emit()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
        </div>

        @if (canManage() && mode() !== 'edit') {
          <div class="rs-seg">
            <button type="button" class="rs-seg-btn" [class.rs-seg-btn--on]="mode() === 'request'" (click)="mode.set('request')">Demander</button>
            <button type="button" class="rs-seg-btn" [class.rs-seg-btn--on]="mode() === 'validate'" (click)="setValidate()">
              À valider @if (pending().length > 0) { <span class="rs-badge">{{ pending().length }}</span> }
            </button>
          </div>
        }

        <!-- ───── DEMANDER / ÉDITER ───── -->
        @if (mode() === 'request' || mode() === 'edit') {
          <div class="rs-body">
            @if (mode() === 'edit') {
              <div class="rs-alert rs-alert--info">Modifier la réservation@if (editReservation()?.vehiclePlate) { — {{ editReservation()?.vehiclePlate }}}</div>
            }
            @if (mode() === 'request' && needsFleet()) {
              <div class="rs-alert rs-alert--info">Choisis d'abord une société dans le sélecteur en haut de page pour réserver sur son parc.</div>
            }
            <div class="rs-f">
              <span>Créneau</span>
              <!-- En édition, le début INCHANGÉ d'une réservation DÉJÀ COMMENCÉE n'est pas borné : commencée
                   hier, elle se prolonge sans le « début déjà passé » rouge (revue du 29/09, C44). Une
                   réservation à venir garde sa borne (T10). -->
              <app-datetime-range [start]="startAt()" [end]="endAt()" [minDay]="minDayCreneau()" (startChange)="startAt.set($event)" (endChange)="endAt.set($event)"></app-datetime-range>
            </div>
            <!-- Consignation rétroactive : autorise un créneau passé pour enregistrer une sortie DÉJÀ faite. -->
            <label class="rs-retro" [class.rs-retro--on]="retroactive()">
              <input type="checkbox" [checked]="retroactive()" (change)="retroactive.set($any($event.target).checked)">
              <span class="rs-retro-txt">
                <span class="rs-retro-t">Réservation déjà effectuée (non enregistrée)</span>
                <span class="rs-retro-s">Coche si la sortie a <strong>déjà eu lieu</strong> : elle sera enregistrée à sa date réelle (passée). Sinon, les dates passées sont bloquées.</span>
              </span>
            </label>
            <label class="rs-f rs-f--sm"><span>Places min. (conducteur compris)</span><input type="number" min="0" inputmode="numeric" class="rs-in" [value]="minSeats()" (input)="minSeats.set($any($event.target).value)"></label>
            <!--
              « 12 PLACES » (29/09) — la taille se dit AVANT l'envoi. Une demande de 12 places sur un parc
              dont le plus grand véhicule en a 9 recevait « aucun véhicule libre » : on cherchait un conflit
              d'horaire qui n'existait pas. Quand aucun véhicule n'est assez grand, la feuille propose de
              RÉPARTIR le groupe sur les véhicules libres du créneau (une réservation interne par véhicule).
            -->
            @if (avisPlaces(); as avis) {
              <span class="rs-hint rs-hint--manque" role="status">{{ avis }}</span>
            }
            @if (mode() === 'request' && aucunAssezGrand() && !retroactive()) {
              <div class="rs-split">
                @if (libresEtat() === 'chargement') {
                  <span class="rs-hint"><lucide-icon [img]="LoaderIcon" [size]="12" class="rs-spin"></lucide-icon> Recherche des véhicules libres sur ce créneau…</span>
                } @else if (libresEtat() === 'erreur') {
                  <span class="rs-hint rs-hint--manque">{{ libresErreur() }}</span>
                } @else if (libresEtat() === 'creneau') {
                  <span class="rs-hint">Renseignez un créneau à venir pour voir comment répartir le groupe.</span>
                } @else if (libresEtat() === 'droit') {
                  <span class="rs-hint">Répartition indisponible : votre accès ne permet pas de voir les véhicules libres de ce créneau. Demandez à un gestionnaire de répartir le groupe.</span>
                } @else if (repartition(); as rp) {
                  @if (rp.texte) {
                    <p class="rs-split-t"><lucide-icon [img]="UsersIcon" [size]="13"></lucide-icon> {{ rp.texte }}</p>
                    @if (rp.avisSieges) { <span class="rs-hint">{{ rp.avisSieges }}</span> }
                    <span class="rs-hint">Une réservation par véhicule, sur ce créneau, avec ce motif et ce groupe. Aucun courriel n'est envoyé.</span>
                    <button type="button" class="rs-btn rs-btn--ok rs-split-btn" [disabled]="repartitionEnCours() || submitting() || needsFleet()" (click)="reserverRepartition()">
                      @if (repartitionEnCours()) { <lucide-icon [img]="LoaderIcon" [size]="13" class="rs-spin"></lucide-icon> } @else { <lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> }
                      {{ repartitionEnCours() ? 'Envoi…' : libelleRepartition(rp) }}
                    </button>
                  } @else if (rp.raison) {
                    <span class="rs-hint rs-hint--manque">{{ rp.raison }}</span>
                  }
                }
                @if (bilanRepartition(); as b) {
                  <div class="rs-split-bilan" role="status">
                    @for (c of b.creees; track c.plate) {
                      <span class="rs-split-ok"><lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> <span class="rs-plate">{{ c.plate }}</span> : {{ c.statut === 'CONFIRMED' ? 'réservé' : 'demande déposée, à valider' }}</span>
                    }
                    @for (r of b.refusees; track r.plate) {
                      <span class="rs-split-ko"><lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon> <span class="rs-plate">{{ r.plate }}</span> : refusé — {{ r.motif }}</span>
                    }
                    @if (b.creees.length > 0) {
                      <span class="rs-hint">{{ b.creees.length > 1 ? 'Les réservations créées sont conservées' : 'La réservation créée est conservée' }} (rien n'a été supprimé) : complétez le groupe avec un autre véhicule ou un autre créneau, ou annulez-la depuis l'agenda.</span>
                    } @else {
                      <span class="rs-hint">Aucune réservation n'a été créée.</span>
                    }
                  </div>
                }
              </div>
            }
            <!--
              SIÈGES AUTO (2026-09-28) — pris sur le STOCK de la société, pas sur le véhicule. Deux
              types, jamais interchangeables : un bébé ne va pas dans un siège enfant, ni l'inverse.
              La ligne sous les champs dit ce qu'il reste sur le créneau saisi : celui qui demande
              sait avant d'envoyer, et pas par un refus. En édition, sur la partie À VENIR seulement,
              comme le serveur ; rien en « déjà effectuée », que le serveur ne contrôle pas (T11).
            -->
            <div class="rs-f">
              <span class="rs-lbl-row"><span><lucide-icon [img]="BabyIcon" [size]="12"></lucide-icon> Sièges auto à installer</span></span>
              <div class="rs-grid">
                <label class="rs-f rs-f--sm"><span class="rs-sub-lbl">Bébé <em>coque, cosy</em></span><input type="number" min="0" max="50" inputmode="numeric" class="rs-in" [value]="childSeatsBaby()" (input)="childSeatsBaby.set($any($event.target).value)" placeholder="0"></label>
                <label class="rs-f rs-f--sm"><span class="rs-sub-lbl">Enfant <em>siège, rehausseur</em></span><input type="number" min="0" max="50" inputmode="numeric" class="rs-in" [value]="childSeatsChild()" (input)="childSeatsChild.set($any($event.target).value)" placeholder="0"></label>
              </div>
              @if (seatsAvail(); as a) {
                @if (a.total.baby === 0 && a.total.child === 0) {
                  <span class="rs-hint">Aucun siège auto renseigné pour cette société — à compter dans la vue Parc de l'agenda. Une réservation qui en demande sera refusée.</span>
                } @else {
                  <!-- Ce que le véhicule choisi a À BORD, puis ce que le stock peut encore donner sur
                       ce créneau — ou, sous « installés seulement », le rappel que le stock n'est pas promis. -->
                  <span class="rs-hint" [class.rs-hint--manque]="seatsManque()">
                    @if (vehicleId() && a.vehicleInstalled) {
                      À bord de {{ a.vehiclePlate || 'ce véhicule' }} : <strong>{{ a.vehicleInstalled.baby }}</strong> bébé · <strong>{{ a.vehicleInstalled.child }}</strong> enfant —
                    }
                    @if (a.policy === 'INSTALLED_ONLY') {
                      sièges installés seulement (réglage de la société : le stock n'est pas promis)
                    } @else {
                      stock disponible {{ seatsDepuisMaintenant() ? 'sur la suite du créneau (à partir de maintenant)' : 'sur ce créneau' }} : <strong>{{ a.available.baby }}</strong> bébé sur {{ a.stock.baby }} · <strong>{{ a.available.child }}</strong> enfant sur {{ a.stock.child }}
                    }
                    @if (seatsManqueTexte(); as m) { — {{ m }} }
                  </span>
                }
              }
            </div>
            <label class="rs-f"><span>Motif (optionnel)</span><input type="text" class="rs-in" [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="Ex. Ramassage scolaire secteur nord"></label>

            <!-- Véhicule -->
            <div class="rs-f">
              <span class="rs-lbl-row">
                Véhicule
                @if (mode() === 'request' && canAi()) {
                  <button type="button" class="rs-ai" [disabled]="aiLoading() || needsFleet()" (click)="suggestAi()">
                    @if (aiLoading()) { <lucide-icon [img]="LoaderIcon" [size]="13" class="rs-spin"></lucide-icon> } @else { <lucide-icon [img]="SparklesIcon" [size]="13"></lucide-icon> }
                    Suggérer avec l'IA
                  </button>
                }
              </span>
              <!-- Les dormants restent LISTÉS et lisibles, avec leur motif daté : les faire
                   disparaître laisserait croire à une suppression du parc. Ils sont
                   seulement non sélectionnables (cf. vehicleOptions pour les exceptions). -->
              <!-- « [selected] » sur chaque option, pas « [value] » seul : ouvert directement en édition, le
                   select retombait sur « Auto » alors que le signal portait bien le véhicule (recette du 28/09 au soir). -->
              <!-- « Auto » en DEMANDE seulement (troisième passe, T12) : en édition, le PATCH sans véhicule
                   n'en change pas — la réservation restait sur le sien sous un toast « enregistré ». Le
                   véhicule de la réservation absent de la liste (hors du périmètre affiché) y figure
                   quand même, présélectionné : sans lui, le navigateur montrait le premier de la liste. -->
              <select class="rs-in" [value]="vehicleId()" (change)="vehicleId.set($any($event.target).value)">
                @if (mode() !== 'edit') {
                  <option value="" [selected]="!vehicleId()">Auto (le 1er disponible conforme)</option>
                } @else if (vehiculeHorsListe(); as vh) {
                  <option [value]="vh.id" [selected]="vh.id === vehicleId()">{{ vh.label }} — véhicule actuel de la réservation</option>
                }
                @for (v of vehicleOptions(); track v.id) {
                  <option [value]="v.id" [disabled]="v.disabled" [selected]="v.id === vehicleId()">{{ v.label }}@if (v.aBord) { · à bord : {{ v.aBord }} }@if (v.horsService) { — hors service ({{ v.horsService }}) } @else if (v.silence) { — boîtier muet depuis {{ v.silence }} }</option>
                }
              </select>
              @if (horsServiceCount() > 0) {
                <span class="rs-hint">{{ horsServiceCount() }} véhicule(s) grisé(s) : déclaré(s) hors service. Ils reviennent dès leur remise en service.</span>
              }
              @if (dormantCount() > 0) {
                <!-- « redeviennent sélectionnables » et non « réapparaissent » : ils n'ont
                     jamais disparu de la liste — les faire disparaître laisserait croire à une
                     sortie de parc. Le mot compte : c'est ce que l'exploitant voit à l'écran. -->
                <span class="rs-hint">
                  {{ dormantCount() }} véhicule(s) grisé(s) : boîtier muet depuis plus d'une semaine.
                  Ils redeviennent sélectionnables d'eux-mêmes dès la première trame reçue.
                </span>
              }
            </div>

            <!--
              GROUPE QUI UTILISE LE VÉHICULE (refonte UX du 28/09, point 9).
              Pré-rempli avec le groupe du véhicule choisi, modifiable ; « Autre… » ouvre un texte libre.
              ⚠️ Ce champ n'écrit JAMAIS le groupe du véhicule : un groupe peut prêter sa voiture à un
              autre — le véhicule garde le sien, la réservation dit qui s'en sert.
            -->
            @if (canManage()) {
              <div class="rs-f">
                <span class="rs-lbl-row"><span><lucide-icon [img]="UsersIcon" [size]="12"></lucide-icon> Groupe qui utilise le véhicule</span></span>
                <!--
                  Revue du 29/09 (C7/C34/C48, C33, C40) :
                  - les options sont celles de LA société (du véhicule choisi, du bandeau, ou de la
                    réservation éditée) — jamais un mélange de clients ;
                  - en édition, le groupe posé figure dans la liste même quand plus aucun véhicule listé
                    ne le porte : le champ dit la vérité, et l'enregistrer ne l'efface plus ;
                  - en « Auto », le champ dit « Groupe du véhicule attribué » : c'est ce que le serveur posera.
                -->
                <div class="rs-grid">
                  <select class="rs-in" [value]="groupChoice()" (change)="choisirGroupe($any($event.target).value)" aria-label="Groupe de la réservation">
                    @if (mode() === 'request' && (!vehicleId() || groupChoice() === GROUPE_DEFAUT)) {
                      <option [value]="GROUPE_DEFAUT" [selected]="groupChoice() === GROUPE_DEFAUT">{{ vehicleId() ? 'Groupe du véhicule (par défaut)' : 'Groupe du véhicule attribué' }}</option>
                    }
                    <option value="" [selected]="groupChoice() === ''">— Aucun groupe —</option>
                    @for (g of groupOptionsFeuille(); track g.id) {
                      <option [value]="g.id" [selected]="g.id === groupChoice()">{{ g.name }}@if (g.note) { ({{ g.note }}) }</option>
                    }
                    <option [value]="GROUPE_AUTRE" [selected]="groupChoice() === GROUPE_AUTRE">Autre…</option>
                  </select>
                  @if (groupChoice() === GROUPE_AUTRE) {
                    <input type="text" class="rs-in" maxlength="60" placeholder="Nom du groupe" aria-label="Nom du groupe"
                           [value]="groupName()" (input)="saisirNomGroupe($any($event.target).value)">
                  }
                </div>
                @if (groupChoice() === GROUPE_AUTRE && !groupName().trim()) {
                  <!-- « Autre… » sans nom = aucun groupe : ça se dit avant l'envoi, pas après. -->
                  <span class="rs-hint rs-hint--manque">Sans nom, la réservation n'aura aucun groupe.</span>
                }
                <span class="rs-hint">
                  @if (mode() === 'edit') {
                    Le groupe posé sur la réservation : changer de véhicule ne le change pas.
                  } @else if (vehicleGroupName(); as vg) {
                    Par défaut, le groupe du véhicule ({{ vg }}).
                  } @else if (vehicleId()) {
                    Ce véhicule n'a pas de groupe.
                  } @else {
                    Par défaut, le groupe du véhicule que la réservation recevra.
                  }
                  Le véhicule garde son propre groupe : ici, c'est celui qui s'en sert pour cette réservation.
                </span>
              </div>
            }

            <!-- Loader explicatif : l'utilisateur comprend ce que fait l'IA et combien de temps ça prend -->
            @if (aiLoading()) {
              <div class="rs-ai-loading">
                <lucide-icon [img]="LoaderIcon" [size]="16" class="rs-spin"></lucide-icon>
                <div>
                  <p class="rs-ai-loading-t">Analyse en cours… (10–30 s)</p>
                  <p class="rs-ai-loading-s">L'IA compare les places, l'énergie et le coût au km des véhicules disponibles pour proposer le placement le plus adapté et le moins cher.</p>
                </div>
              </div>
            }
            @if (aiError()) { <div class="rs-alert rs-alert--err"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ aiError() }}</div> }
            @if (aiNoMatch()) { <div class="rs-alert rs-alert--warn"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ aiNotes() || 'Aucun véhicule ne couvre bien le besoin sur ce créneau.' }}</div> }
            <!-- Transparence : véhicules écartés AVANT le raisonnement IA (résultats non faussés en silence) -->
            @if (aiExcludedInfo()) { <div class="rs-alert rs-alert--info">{{ aiExcludedInfo() }}</div> }
            @if (aiProposals().length > 0) {
              <div class="rs-ai-list">
                <span class="rs-ai-hint">Proposé par l'IA — touchez pour choisir. Le n°1 est le meilleur compromis besoin / coût :</span>
                @for (p of aiProposals(); track p.vehicleId; let i = $index) {
                  <button type="button" class="rs-ai-card" [class.rs-ai-card--on]="vehicleId() === p.vehicleId" (click)="vehicleId.set(p.vehicleId)">
                    <div class="rs-ai-top">
                      <span class="rs-rank">#{{ i + 1 }}</span>
                      <span class="rs-plate">{{ p.plate || '—' }}</span>
                      <span class="rs-chip" [ngClass]="scoreClass(p.score)">{{ p.score * 100 | number:'1.0-0' }}%</span>
                    </div>
                    <p class="rs-ai-reason">{{ p.reasoning }}</p>
                    <span class="rs-ai-seats">
                      {{ valOf(p.seats) }} places
                      @if (p.energy) { · <span class="rs-tag">{{ energyLabel(p.energy) }}</span> }
                      @if (p.costPerKm != null) { · <span class="rs-tag rs-tag--cost">≈ {{ p.costPerKm | number:'1.2-2' }} €/km</span> }
                    </span>
                  </button>
                }
                @if (aiCost() != null) {
                  <p class="rs-ai-cost">Coût de cette analyse IA : ≈ {{ aiCost() | number:'1.2-2' }} €</p>
                }
              </div>
            }

          </div>
          <!-- L'erreur vit dans le PIED, hors du corps défilant : au fond d'une feuille longue, un refus
               (« impossible de réserver dans le passé ») restait invisible — recette du 28/09 au soir. -->
          @if (reqError()) { <div class="rs-alert rs-alert--err rs-alert--foot"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ reqError() }}</div> }
          <div class="rs-foot">
            @if (mode() === 'edit') {
              <button type="button" class="rs-btn rs-btn--no" [disabled]="submitting()" (click)="cancelResa()">Annuler la réservation</button>
              <button type="button" class="rs-btn rs-btn--primary" [disabled]="submitting()" (click)="saveEdit()">
                @if (submitting()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="rs-spin"></lucide-icon> }
                {{ submitting() ? 'Enregistrement…' : 'Enregistrer' }}
              </button>
            } @else {
              <button type="button" class="rs-btn rs-btn--primary" [disabled]="submitting() || needsFleet() || repartitionEnCours()" (click)="submit()">
                @if (submitting()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="rs-spin"></lucide-icon> }
                {{ submitting() ? 'Envoi…' : (canManage() ? 'Réserver' : 'Déposer la demande') }}
              </button>
            }
          </div>
        }

        <!-- ───── À VALIDER ───── -->
        @if (mode() === 'validate') {
          <div class="rs-body">
            @if (queueLoading()) {
              <div class="rs-skel"></div><div class="rs-skel"></div>
            } @else if (pending().length === 0) {
              <div class="rs-empty"><lucide-icon [img]="InboxIcon" [size]="36" class="rs-empty-ic"></lucide-icon><p>Aucune demande en attente.</p></div>
            } @else {
              <!--
                F13 (recette du 28/09) — UNE demande, UNE carte, UNE décision. Une demande publique de
                11 places pré-retient deux véhicules de 9 : ils portent le même « bookingRef » et
                s'affichaient comme deux demandes indépendantes, qu'on pouvait valider à moitié.
              -->
              @for (g of groupes(); track g.cle) {
                <div class="rs-q" [class.rs-q--groupe]="g.items.length > 1">
                  <div class="rs-q-top">
                    @if (g.items.length > 1) {
                      <span class="rs-plate">{{ g.items.length }} véhicules</span>
                    } @else {
                      <span class="rs-plate">{{ g.chef.vehiclePlate || '—' }}</span>
                    }
                    <span class="rs-q-when">{{ g.chef.startAt | date:'dd MMM HH:mm' }} → {{ g.chef.endAt | date:(memeJour(g.chef) ? 'HH:mm' : 'dd MMM HH:mm') }}@if (dureeJours(g.chef) > 1) { <span class="rs-q-duree">· {{ dureeJours(g.chef) }} jours</span> }</span>
                  </div>
                  <p class="rs-q-title">{{ g.chef.title }}</p>
                  @if (g.items.length > 1) {
                    <p class="rs-q-req">
                      @for (r of g.items; track r.id) { <span class="rs-plate">{{ r.vehiclePlate || '—' }}</span> }
                      · un seul demandeur, {{ g.items.length }} véhicules pré-retenus
                    </p>
                  }
                  @if (publicInfo(g.chef); as pi) {
                    <p class="rs-q-req">
                      <lucide-icon [img]="UserIcon" [size]="12"></lucide-icon> {{ pi.requester }}
                      @if (pi.contact) { · <span class="rs-q-contact">{{ pi.contact }}</span> }
                      @if (pi.seats) { · {{ pi.seats }} places demandées }
                    </p>
                  }
                  <!-- Sièges auto : le valideur doit voir AVANT de dire oui ce qui est déjà à bord du
                       véhicule pré-retenu et ce qu'il faudra sortir du stock — la validation refuse (409)
                       s'il n'en reste pas. -->
                  @if (besoinSieges(g.chef); as bs) {
                    <p class="rs-q-req"><lucide-icon [img]="BabyIcon" [size]="12"></lucide-icon> Sièges auto : {{ bs }}</p>
                  }
                  <!-- Groupe qui utilise le véhicule, décidé À LA VALIDATION (point 9) : pré-rempli avec le
                       groupe DÉJÀ POSÉ sur la demande (même saisi en texte libre, même porté par aucun
                       véhicule listé), sinon celui du véhicule pré-retenu ; les options sont celles de la
                       société de la demande. Rien n'est envoyé tant que le valideur n'y touche pas
                       (revue du 29/09, C8/C36/C40). Plusieurs véhicules aux groupes différents : la
                       carte le dit (« Groupes différents (Nord, Sud) », qui ne change rien), et un
                       choix s'applique à tous (R10). -->
                  <div class="rs-q-groupe">
                    <lucide-icon [img]="UsersIcon" [size]="12"></lucide-icon>
                    <span class="rs-q-groupe-l">Groupe</span>
                    <select class="rs-in rs-in--xs" [value]="groupeValidation(g)" (change)="choisirGroupeValidation(g.cle, $any($event.target).value)" [attr.aria-label]="'Groupe qui utilise le véhicule'">
                      @if (libelleMixte(g); as mixte) {
                        <option [value]="GROUPE_PAR_VEHICULE" [selected]="groupeValidation(g) === GROUPE_PAR_VEHICULE">{{ mixte }}</option>
                      }
                      <option value="" [selected]="groupeValidation(g) === ''">— Aucun —</option>
                      @for (og of optionsCarte(g); track og.id) {
                        <option [value]="og.id" [selected]="og.id === groupeValidation(g)">{{ og.name }}@if (og.note) { ({{ og.note }}) }</option>
                      }
                    </select>
                  </div>
                  <!--
                    Lot 3b — CE QUE LA VALIDATION VA DÉPLACER.
                    Quand aucun véhicule n'était libre de tout engagement, la demande a pris celui
                    qu'une proposition de l'agent retenait sur ce créneau. Valider écarte cette
                    proposition : ça se dit AVANT le clic, pas après.
                  -->
                  @for (r of g.items; track r.id) {
                    @if (deplacements(r); as dep) {
                      <p class="rs-q-deplace">
                        <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
                        @if (g.items.length > 1) { {{ r.vehiclePlate }} : }
                        Valider écartera {{ dep.length }} proposition{{ dep.length > 1 ? 's' : '' }} de l'agent
                        sur ce créneau ({{ dep.join(', ') }}). Le véhicule revient à ce demandeur.
                      </p>
                    }
                  }
                  <div class="rs-q-actions">
                    <button type="button" class="rs-btn rs-btn--ok" [disabled]="busyId() === g.cle" (click)="confirmGroupe(g)"><lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> Valider@if (g.items.length > 1) { les {{ g.items.length }} }</button>
                    <button type="button" class="rs-btn rs-btn--no" [disabled]="busyId() === g.cle" (click)="rejectGroupe(g)">Refuser@if (g.items.length > 1) { les {{ g.items.length }} }</button>
                  </div>
                </div>
              }
            }
          </div>
        }
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    .rs { display: flex; flex-direction: column; padding: 2px 2px 0; }
    .rs-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle); }
    .rs-title { display: flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .rs-x { width: 34px; height: 34px; border-radius: 9px; color: var(--fg-tertiary); display: inline-flex; align-items: center; justify-content: center; }
    .rs-x:hover { color: var(--fg-primary); background: var(--bg-tertiary); }
    .rs-seg { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); margin: 10px 0; }
    .rs-seg-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--fg-tertiary); }
    .rs-seg-btn--on { background: var(--bg-primary); color: var(--tracky-light); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .rs-badge { font-size: 11px; font-weight: 800; padding: 0 6px; border-radius: 999px; background: rgba(56,189,248,.18); color: #38BDF8; }
    .rs-body { display: flex; flex-direction: column; gap: 10px; overflow-y: auto; max-height: 58vh; max-height: 58dvh; padding: 2px; }
    .rs-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .rs-alert--foot { margin-top: 8px; }
    /* « 12 places » : la proposition de répartition, sous le champ Places. */
    .rs-split { display: flex; flex-direction: column; gap: 6px; padding: 10px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px dashed color-mix(in srgb, var(--tracky-light) 45%, var(--border-subtle)); }
    .rs-split-t { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 0; font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
    .rs-split-t lucide-icon { color: var(--tracky-light); }
    .rs-split-btn { align-self: flex-start; }
    .rs-split-btn:disabled { opacity: .55; }
    .rs-split-bilan { display: flex; flex-direction: column; gap: 4px; padding-top: 6px; border-top: 1px solid var(--border-subtle); }
    .rs-split-ok, .rs-split-ko { display: flex; align-items: flex-start; gap: 5px; font-size: 12px; line-height: 1.4; }
    .rs-split-ok { color: var(--texte-succes, var(--tracky-light)); }
    .rs-split-ko { color: var(--texte-alerte); }
    .rs-split-ok lucide-icon, .rs-split-ko lucide-icon { flex-shrink: 0; margin-top: 2px; }
    .rs-f { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--fg-tertiary); }
    .rs-f > span:first-child, .rs-lbl-row { font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .rs-lbl-row { display: flex; align-items: center; justify-content: space-between; }
    .rs-in { width: 100%; padding: 10px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-strong); color: var(--fg-primary); font-size: 16px; }
    .rs-in:focus { outline: none; border-color: var(--tracky-light); box-shadow: 0 0 0 3px rgba(16,224,160,.14); }
    .rs-ai { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--tracky-light); text-transform: none; letter-spacing: 0; padding: 3px 8px; border-radius: 8px; background: rgba(16,224,160,.1); }
    .rs-ai:disabled { opacity: .6; }
    .rs-ai-list { display: flex; flex-direction: column; gap: 8px; }
    .rs-ai-hint { font-size: 11.5px; color: var(--fg-tertiary); }
    .rs-hint { font-size: 11px; color: var(--fg-tertiary); line-height: 1.35; text-transform: none; letter-spacing: 0; font-weight: 400; }
    .rs-hint--manque { color: var(--texte-attente); }
    .rs-sub-lbl { text-transform: none; letter-spacing: 0; }
    .rs-sub-lbl em { font-style: normal; font-weight: 400; color: var(--fg-tertiary); }
    /* L'icône et le libellé sur UNE ligne (l'icône est un bloc : sans ceci elle passe au-dessus). */
    .rs-lbl-row > span { display: inline-flex; align-items: center; gap: 4px; }
    .rs-ai-card { text-align: left; padding: 11px; border-radius: 12px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .rs-ai-card--on { border-color: var(--tracky-light); box-shadow: 0 0 0 1px var(--tracky-light) inset; background: rgba(16,224,160,.06); }
    .rs-ai-top { display: flex; align-items: center; gap: 8px; }
    .rs-rank { font-size: 12px; font-weight: 800; color: var(--fg-tertiary); }
    .rs-ai-top .rs-plate { flex: 1; }
    .rs-ai-reason { font-size: 12px; color: var(--fg-secondary); margin-top: 6px; line-height: 1.4; }
    .rs-ai-seats { font-size: 11px; color: var(--fg-tertiary); margin-top: 5px; display: block; }
    .rs-tag { font-weight: 700; color: var(--fg-secondary); }
    .rs-tag--cost { color: var(--tracky-light); }
    .rs-ai-cost { font-size: 11px; color: var(--fg-tertiary); text-align: right; margin: 2px 2px 0; }
    .rs-ai-loading {
      display: flex; align-items: flex-start; gap: 10px; padding: 12px;
      border-radius: 12px; background: rgba(16,224,160,.06);
      border: 1px solid color-mix(in srgb, var(--tracky-light) 30%, var(--border-subtle));
    }
    .rs-ai-loading lucide-icon { color: var(--tracky-light); flex-shrink: 0; margin-top: 1px; }
    .rs-ai-loading-t { font-size: 12.5px; font-weight: 700; color: var(--fg-primary); margin: 0; }
    .rs-ai-loading-s { font-size: 11.5px; color: var(--fg-tertiary); margin: 3px 0 0; line-height: 1.45; }
    .rs-plate { font-weight: 800; color: var(--fg-primary); letter-spacing: .3px; }
    .rs-chip { font-size: 12px; font-weight: 800; padding: 2px 9px; border-radius: 999px; }
    .rs-chip--hi { color: #10B981; background: rgba(16,185,129,.13); }
    .rs-chip--mid { color: var(--texte-attente); background: color-mix(in srgb, var(--warning) 14%, transparent); }
    .rs-chip--lo { color: var(--texte-alerte); background: color-mix(in srgb, var(--danger) 13%, transparent); }
    .rs-alert { display: flex; align-items: center; gap: 7px; padding: 9px 11px; border-radius: 10px; font-size: 12px; }
    .rs-alert--err { background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--texte-alerte); }
    .rs-alert--warn { background: color-mix(in srgb, var(--warning) 12%, transparent); color: var(--texte-attente); }
    .rs-alert--info { background: var(--bg-tertiary); color: var(--fg-secondary); }
    .rs-retro { display: flex; gap: 9px; align-items: flex-start; padding: 10px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); cursor: pointer; }
    .rs-retro--on { border-color: var(--tracky-light); background: color-mix(in srgb, var(--tracky-light) 8%, transparent); }
    .rs-retro input { margin-top: 2px; width: 16px; height: 16px; accent-color: var(--tracky-light); flex-shrink: 0; cursor: pointer; }
    .rs-retro-txt { display: flex; flex-direction: column; gap: 2px; }
    .rs-retro-t { font-size: 13px; font-weight: 700; color: var(--fg-primary); }
    .rs-retro-s { font-size: 11.5px; color: var(--fg-tertiary); line-height: 1.35; }
    .rs-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 0 max(6px, env(safe-area-inset-bottom)); margin-top: 2px; border-top: 1px solid var(--border-subtle); }
    .rs-btn { display: inline-flex; align-items: center; gap: 6px; padding: 10px 16px; border-radius: 10px; font-size: 13px; font-weight: 700; }
    .rs-btn--primary { background: var(--tracky, #10B981); color: #fff; }
    .rs-btn--primary:disabled { opacity: .55; }
    .rs-btn--ok { background: rgba(16,224,160,.12); color: var(--tracky-light); border: 1px solid rgba(16,224,160,.25); }
    .rs-btn--no { background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    .rs-btn:disabled { opacity: .55; }
    .rs-q { padding: 11px; border-radius: 12px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    /* F13 : une demande groupée (plusieurs véhicules) se distingue d'un trait plus appuyé. */
    .rs-q--groupe { border-left: 3px solid var(--tracky-light); }
    .rs-q-top { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .rs-q-when { font-size: 11.5px; color: var(--fg-tertiary); }
    .rs-q-groupe { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 11.5px; color: var(--fg-tertiary); }
    .rs-q-groupe lucide-icon { color: var(--tracky-light); }
    .rs-q-groupe-l { font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .rs-in--xs { flex: 1; min-height: 34px; padding: 5px 8px; font-size: 13px; }
    .rs-q-duree { font-weight: 800; color: var(--texte-info); }
    .rs-q-title { font-size: 13px; font-weight: 600; color: var(--fg-primary); margin: 6px 0 0; }
    .rs-q-req { display: flex; align-items: center; gap: 5px; flex-wrap: wrap; font-size: 11.5px; color: var(--fg-tertiary); margin: 5px 0 0; }
    .rs-q-contact { font-weight: 700; color: var(--tracky-light); }
    .rs-q-deplace { display: flex; align-items: flex-start; gap: 6px; margin: 8px 0 0;
                    padding: 8px 10px; border-radius: 9px; font-size: 11.5px; line-height: 1.45;
                    background: color-mix(in srgb, var(--warning) 12%, transparent); color: var(--texte-attente); }
    .rs-q-actions { display: flex; gap: 8px; margin-top: 9px; }
    .rs-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 26px; text-align: center; font-size: 13px; color: var(--fg-tertiary); }
    .rs-empty-ic { opacity: .3; }
    .rs-skel { height: 64px; border-radius: 12px; background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: rs-sh 1.3s infinite; }
    @keyframes rs-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .rs-spin { animation: rs-spin 1s linear infinite; }
    @keyframes rs-spin { to { transform: rotate(360deg); } }
    /* ── Dark : les bordures à 8 % de blanc sont presque invisibles sur le fond
       sombre. On renforce les traits pour structurer la feuille et détacher les
       champs (bordures d'inputs + séparateurs haut/bas + cartes). ── */
    :host-context([data-theme='dark']) .rs-in { border-color: rgba(255,255,255,.15); color-scheme: dark; }
    :host-context([data-theme='dark']) .rs-in:focus { border-color: var(--tracky-light); }
    :host-context([data-theme='dark']) .rs-head,
    :host-context([data-theme='dark']) .rs-foot { border-color: rgba(255,255,255,.10); }
    :host-context([data-theme='dark']) .rs-seg,
    :host-context([data-theme='dark']) .rs-ai-card,
    :host-context([data-theme='dark']) .rs-q { border-color: rgba(255,255,255,.12); }

    @media (max-width: 480px) { .rs-grid { grid-template-columns: 1fr; } }
  `],
})
export class ReservationSheetComponent {
  private readonly api = inject(AgendaApiService);
  private readonly ai = inject(AiApiService);
  private readonly aiStatus = inject(AiStatusService);
  private readonly auth = inject(AuthService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);

  readonly open = input(false);
  readonly vehicles = input<ReservationSheetVehicle[]>([]);
  /** Date pré-sélectionnée (clic sur un jour du calendrier), format 'YYYY-MM-DD'. */
  readonly defaultDate = input<string | null>(null);
  /** Mode initial à l'ouverture ('request' ou 'validate'). */
  readonly startMode = input<'request' | 'validate'>('request');
  /** Réservation à ÉDITER (ouvre la feuille en mode édition). Null = création / validation. */
  readonly editReservation = input<VehicleEventDto | null>(null);
  readonly closed = output<void>();
  readonly created = output<void>();

  protected readonly SparklesIcon = Sparkles;
  protected readonly CheckIcon = Check;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly LoaderIcon = Loader;
  protected readonly CalendarCheckIcon = CalendarCheck;
  protected readonly InboxIcon = Inbox;
  protected readonly XIcon = X;
  protected readonly UserIcon = User;
  protected readonly BabyIcon = Baby;
  protected readonly UsersIcon = Users;
  protected readonly GROUPE_AUTRE = GROUPE_AUTRE;
  protected readonly GROUPE_DEFAUT = GROUPE_DEFAUT;
  protected readonly GROUPE_PAR_VEHICULE = GROUPE_PAR_VEHICULE;

  protected readonly mode = signal<'request' | 'validate' | 'edit'>('request');
  protected readonly canManage = computed(() => this.perms.can('reservations_manage'));
  /** « Suggérer avec l'IA » appelle `placementSuggest` → fonction `placement` (pas l'interrupteur maître). */
  protected readonly canAi = computed(() => this.perms.can('ai_optimize') && this.aiStatus.can('placement'));
  /** Super-admin sans société choisie : réserver mélangerait toutes les flottes → on gate. */
  protected readonly needsFleet = computed(
    () => this.auth.user()?.role === 'SUPER_ADMIN' && !this.fleetFilter.selectedFleetId(),
  );

  // Demande
  protected readonly startAt = signal('');
  protected readonly endAt = signal('');
  protected readonly minSeats = signal('');
  /** Sièges auto demandés, par type (stock de la société — pas une capacité du véhicule). */
  protected readonly childSeatsBaby = signal('');
  protected readonly childSeatsChild = signal('');
  /** Ce que le créneau permet (stock, politique, sièges à bord du véhicule choisi) — rechargé à chaque changement. */
  protected readonly seatsAvail = signal<ChildSeatAvailabilityDto | null>(null);
  /**
   * Le besoin saisi tient-il ? Avec un véhicule choisi : ses sièges à bord d'abord, le stock pour le
   * reste (ou rien, sous « installés seulement »). Sans véhicule (« Auto ») : on ne juge que le stock —
   * le serveur choisira un véhicule équipé s'il en existe un.
   */
  protected readonly seatsManqueTexte = computed<string | null>(() => {
    const a = this.seatsAvail();
    if (!a) return null;
    const need = this.besoin();
    if (need.baby <= 0 && need.child <= 0) return null;
    const vehicule = !!this.vehicleId() && !!a.vehicleInstalled;
    const aBord = vehicule ? a.vehicleInstalled! : { baby: 0, child: 0 };
    const reste = { baby: Math.max(0, need.baby - aBord.baby), child: Math.max(0, need.child - aBord.child) };
    if (a.policy === 'INSTALLED_ONLY') {
      if (!vehicule) return reste.baby > 0 || reste.child > 0 ? 'il faudra un véhicule qui a déjà ces sièges à bord.' : null;
      return reste.baby > 0 || reste.child > 0 ? 'il en manque à bord de ce véhicule.' : null;
    }
    const manque = reste.baby > a.available.baby || reste.child > a.available.child;
    if (!manque) return null;
    return vehicule ? 'il en manque pour cette demande.' : 'le stock seul ne suffit pas : il faudra un véhicule déjà équipé.';
  });
  protected readonly seatsManque = computed(() => this.seatsManqueTexte() !== null);
  protected readonly reason = signal('');
  /**
   * Édition : le motif tel qu'à l'ouverture (troisième passe, T13). L'enregistrement n'envoie `reason`
   * que s'il en diffère — chaîne vide comprise : `reason || undefined` ne transmettait jamais un motif
   * vidé, et l'ancien revenait à la réouverture sous un toast « enregistré ».
   */
  private readonly motifOuverture = signal('');
  protected readonly vehicleId = signal('');

  // ─── Groupe qui utilise le véhicule (point 9) ────────────────────────────────────────────
  /**
   * Choix du sélecteur : '' (aucun), un id de groupe de la société, GROUPE_AUTRE (texte libre) ou,
   * en demande « Auto », GROUPE_DEFAUT (le groupe du véhicule que le serveur attribuera).
   */
  protected readonly groupChoice = signal('');
  /** Nom saisi quand « Autre… » est choisi. */
  protected readonly groupName = signal('');
  /**
   * Vrai dès que le défaut (groupe du véhicule) ne doit plus suivre le véhicule choisi : l'utilisateur
   * a touché au champ, ou la feuille est en édition (le groupe posé tient).
   */
  protected readonly groupTouched = signal(false);
  /**
   * Édition : vrai seulement si l'utilisateur a touché au champ APRÈS l'ouverture (revue du 29/09,
   * C7/C34/C48). Distinct de `groupTouched`, que l'ouverture en édition pose à vrai : l'édition
   * envoyait TOUJOURS `group`, et un groupe posé absent des options partait en `null` — le serveur
   * l'effaçait (« null retire ») quand on ne décalait que l'heure de fin.
   */
  private readonly groupEdited = signal(false);
  /** Édition : le groupe posé sur la réservation à l'ouverture (null = aucun). */
  private readonly groupePose = signal<ReservationGroupDto | null>(null);

  /**
   * Groupes PAR SOCIÉTÉ, tirés des véhicules proposés (dédup par id, triés) — revue du 29/09, C40.
   * Un véhicule sans société connue (appelant qui ne la fournit pas) compte pour toutes.
   */
  private readonly groupesIndex = computed(() => {
    const tous = new Map<string, GroupeOption>();
    const sansSociete = new Map<string, GroupeOption>();
    const parSociete = new Map<string, Map<string, GroupeOption>>();
    for (const v of this.vehicles()) {
      if (!v.group?.id) continue;
      const o: GroupeOption = { id: v.group.id, name: v.group.name };
      if (!tous.has(o.id)) tous.set(o.id, o);
      let cible = sansSociete;
      if (v.fleetId) {
        cible = parSociete.get(v.fleetId) ?? new Map<string, GroupeOption>();
        parSociete.set(v.fleetId, cible);
      }
      if (!cible.has(o.id)) cible.set(o.id, o);
    }
    const trie = (m: Map<string, GroupeOption>) => [...m.values()].sort((a, b) => a.name.localeCompare(b.name));
    const listes = new Map<string, GroupeOption[]>();
    for (const [fleetId, m] of parSociete) {
      for (const [id, o] of sansSociete) if (!m.has(id)) m.set(id, o);
      listes.set(fleetId, trie(m));
    }
    return { tous: trie(tous), sansSociete: trie(sansSociete), listes };
  });

  /** Les groupes d'UNE société (sans société : tous — le cas d'un utilisateur qui n'en a qu'une). */
  private groupesDe(fleetId: string | null | undefined): GroupeOption[] {
    const idx = this.groupesIndex();
    if (!fleetId) return idx.tous;
    return idx.listes.get(fleetId) ?? idx.sansSociete;
  }

  /**
   * Société du bandeau — SEULEMENT pour un super-admin qui en a choisi une (revue du 29/09, S0).
   * `selectedFleetId()` lit le localStorage sans regarder le rôle, et la déconnexion ne l'efface pas :
   * un gestionnaire client qui ouvrait la feuille après une session super-admin sur le même navigateur
   * héritait de la société d'un AUTRE client — liste de groupes vide en « Auto », et 403 « Flotte
   * hors périmètre » sur la demande, la suggestion IA, les sièges et la file. Non-super-admin : null,
   * le serveur le scope sur sa société.
   */
  private readonly societeBandeau = computed<string | null>(() =>
    this.fleetFilter.isActive() ? this.fleetFilter.selectedFleetId() : null,
  );

  /**
   * Société d'une demande : celle du véhicule choisi ; sinon, pour un super-admin, celle du bandeau,
   * et pour tout autre compte, LA SIENNE — jamais une société restée dans le localStorage (S0).
   */
  private readonly societeDemande = computed(() => {
    const id = this.vehicleId();
    const v = id ? this.vehicles().find((x) => x.id === id) : undefined;
    if (v?.fleetId) return v.fleetId;
    const user = this.auth.user();
    return user?.role === 'SUPER_ADMIN' ? this.societeBandeau() : (user?.fleetId ?? null);
  });

  /**
   * Options du champ Groupe de la feuille. Demande : groupes de la société de la demande. Édition :
   * groupes de la société de la réservation, PLUS le groupe posé s'il n'y figure pas (plus aucun
   * véhicule listé ne le porte, ou il n'est pas dans le périmètre de l'utilisateur).
   */
  protected readonly groupOptionsFeuille = computed<GroupeOption[]>(() => {
    if (this.mode() !== 'edit') return this.groupesDe(this.societeDemande());
    const liste = this.groupesDe(this.editReservation()?.fleetId);
    const pose = this.groupePose();
    if (pose?.id && !liste.some((o) => o.id === pose.id)) return [...liste, { id: pose.id, name: pose.name, note: 'groupe actuel' }];
    return liste;
  });

  /** Nom du groupe du véhicule choisi — la phrase d'aide le nomme. */
  protected readonly vehicleGroupName = computed(() => {
    const id = this.vehicleId();
    if (!id) return null;
    return this.vehicles().find((v) => v.id === id)?.group?.name ?? null;
  });
  /** Groupe choisi À LA VALIDATION, par carte de la file (clé de groupe → valeur du sélecteur, '' = aucun). */
  protected readonly groupesValidation = signal<Record<string, string>>({});

  /**
   * Par carte de la file : ce que le sélecteur montre sans geste du valideur (`defaut`), ses options
   * (groupes de LA société de la demande + les groupes posés qui n'y sont pas) et, si les véhicules de
   * la carte n'ont pas le même défaut, le libellé « Groupes différents (…) » (`mixte`).
   *
   * Le défaut suit l'ordre du serveur quand `group` est absent (`confirm`) : dès que la demande porte
   * une clé `group`, c'est ce groupe posé — texte libre compris, et `null` = « aucun groupe » choisi
   * au dépôt — ; sans clé (demande publique, ancienne demande), celui du véhicule pré-retenu
   * (revue du 29/09, C8/C36).
   *
   * Ce défaut se calcule pour CHAQUE véhicule de la carte, pas pour le seul premier (revue du 29/09,
   * R10). Une demande publique de 11 places pré-retient V1 (Nord) et V2 (Sud) : la carte affichait
   * « Nord » (le premier), la validation sans geste posait Nord sur V1 et Sud sur V2, et re-choisir
   * Nord — égal au défaut affiché — n'envoyait toujours rien : impossible d'imposer un groupe à tous.
   * Maintenant : défauts identiques, la carte montre ce groupe ; défauts différents, elle montre
   * « Groupes différents (Nord, Sud) », présélectionné, qui ne change rien — et tout autre choix, même
   * Nord, part pour tous les véhicules.
   */
  private readonly cartesGroupe = computed(() => {
    const cartes = new Map<string, CarteGroupe>();
    for (const g of this.groupes()) {
      const liste = this.groupesDe(g.chef.fleetId);
      const libres: GroupeOption[] = []; // noms libres posés sur une ligne — en tête
      const ajouts: GroupeOption[] = []; // groupes posés (ou de véhicule) absents de la liste — en queue
      const ajouter = (o: GroupeOption) => {
        if (!liste.some((x) => x.id === o.id) && !ajouts.some((x) => x.id === o.id)) ajouts.push(o);
      };
      // Défaut serveur de chaque ligne : valeur du sélecteur → nom lisible.
      const defauts = new Map<string, string>();
      for (const r of g.items) {
        const meta = (r.metadata as Record<string, unknown> | null) ?? {};
        if ('group' in meta) {
          const pose = groupePoseDe(meta);
          if (pose?.id) {
            ajouter({ id: pose.id, name: pose.name, note: 'groupe posé' });
            defauts.set(pose.id, pose.name);
          } else if (pose) {
            const id = `${GROUPE_POSE_LIBRE}:${pose.name}`;
            if (!libres.some((x) => x.id === id)) libres.push({ id, name: pose.name, note: 'saisi' });
            defauts.set(id, pose.name);
          } else {
            defauts.set('', 'aucun'); // « aucun groupe » posé sur la demande : le serveur le garde
          }
        } else {
          const vg = this.vehicles().find((v) => v.id === r.vehicleId)?.group;
          if (vg?.id) {
            ajouter({ id: vg.id, name: vg.name });
            defauts.set(vg.id, vg.name);
          } else {
            defauts.set('', 'aucun');
          }
        }
      }
      const mixte = defauts.size > 1 ? `Groupes différents (${[...defauts.values()].join(', ')})` : null;
      cartes.set(g.cle, {
        defaut: mixte ? GROUPE_PAR_VEHICULE : ([...defauts.keys()][0] ?? ''),
        options: [...libres, ...liste, ...ajouts],
        mixte,
      });
    }
    return cartes;
  });

  /** « Groupes différents (Nord, Sud) » pour une carte dont les véhicules n'ont pas le même défaut. */
  protected libelleMixte(g: { cle: string }): string | null {
    return this.cartesGroupe().get(g.cle)?.mixte ?? null;
  }

  protected optionsCarte(g: { cle: string }): GroupeOption[] {
    return this.cartesGroupe().get(g.cle)?.options ?? [];
  }
  protected readonly submitting = signal(false);
  protected readonly reqError = signal<string | null>(null);
  /** Consigner une réservation DÉJÀ effectuée (autorise un créneau passé). Réservé aux gestionnaires. */
  protected readonly retroactive = signal(false);
  /** Aujourd'hui (YYYY-MM-DD local) — borne minimale du picker hors mode « déjà effectuée ».
   *  Dépend de open() pour se rafraîchir à chaque ouverture du sheet. */
  protected readonly todayIso = computed(() => {
    void this.open();
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });

  /**
   * Édition : le créneau tel qu'à l'ouverture, en chaînes LOCALES à la minute (celles du sélecteur).
   * On compare ces chaînes, jamais les ISO : `toLocalInput` tronque les secondes, et un début posé
   * avec des secondes (lien public, agent) paraîtrait toujours « modifié ». Null hors édition.
   */
  private readonly creneauOuverture = signal<{ debut: string; fin: string } | null>(null);

  /**
   * Édition d'une réservation dont le début n'a pas bougé (revue du 29/09, C44). Une réservation du
   * lundi au mercredi, modifiée le mardi, ne pouvait plus être prolongée, regroupée ni réaffectée :
   * le sélecteur criait « début déjà passé », `slot()` refusait, et le client renvoyait toujours
   * `startAt` — le serveur refusait donc aussi. Un début inchangé n'est plus ni renvoyé ni contrôlé.
   */
  protected readonly debutInchange = computed(() => {
    const o = this.creneauOuverture();
    return this.mode() === 'edit' && !!o && this.startAt() === o.debut;
  });

  /**
   * Borne du sélecteur : aucune en « déjà effectuée » ni pour le début inchangé d'une réservation
   * DÉJÀ COMMENCÉE (C44 — sinon le « début déjà passé » rouge revient). Une réservation À VENIR garde
   * sa borne même début inchangé (troisième passe, T10) : levée, le calendrier natif ne grisait plus
   * les jours passés, un clic sur hier était retenu, et la borne ne revenait qu'après coup — résumé
   * rouge et refus à l'enregistrement, au lieu de l'avis « date non retenue » du sélecteur (R11).
   * Début déplacé en édition : aujourd'hui, ou le jour d'origine s'il est plus ancien — sinon, revenir
   * au début d'origine en le tapant le ferait ramener à aujourd'hui.
   */
  protected readonly minDayCreneau = computed(() => {
    if (this.retroactive()) return '';
    const o = this.mode() === 'edit' ? this.creneauOuverture() : null;
    // `o.debut` est une chaîne LOCALE 'YYYY-MM-DDTHH:mm' : `new Date` la lit à l'heure locale.
    if (this.debutInchange() && o && new Date(o.debut).getTime() <= Date.now()) return '';
    const today = this.todayIso();
    const jourOrigine = o?.debut.slice(0, 10) ?? '';
    return jourOrigine && jourOrigine < today ? jourOrigine : today;
  });

  /**
   * Options du sélecteur de véhicule, dormance comprise.
   *
   * SEUIL : {@link DORMANT_STOP_COUNTING_MS} (7 j) et NON le seuil d'action (72 h). Ce
   * sélecteur n'envoie aucune commande au boîtier — c'est un vivier de proposition, et le
   * fichier partagé range explicitement la réservation dans cette famille : ici le coût
   * d'une exclusion à tort est ÉLEVÉ (on retirerait du parc réservable un vrai véhicule
   * garé pour un pont ou une semaine d'atelier). 72 h griserait un véhicule simplement
   * immobilisé un long week-end. Les gardes à 72 h restent réservées aux BOUTONS
   * (couper, armer, sonder), où l'échec est certain et immédiat.
   *
   * Deux exceptions volontaires au grisage, sinon on casserait des usages légitimes :
   *  - le véhicule DÉJÀ sélectionné, et en édition le véhicule DE LA RÉSERVATION même après un
   *    détour par un autre (T12 : sinon, dormant ou hors service, on ne pouvait plus y revenir —
   *    et le serveur l'accepte, puisqu'il n'y a alors aucun changement de véhicule), restent
   *    sélectionnables, sans quoi la feuille deviendrait inenregistrable ;
   *  - en « réservation déjà effectuée », on consigne une sortie PASSÉE : l'état actuel du
   *    boîtier n'a aucune importance, et refuser l'écriture ferait perdre l'information.
   */
  protected readonly vehicleOptions = computed(() => {
    const now = Date.now();
    const selected = this.vehicleId();
    const propre = this.mode() === 'edit' ? (this.editReservation()?.vehicleId ?? null) : null;
    const retro = this.retroactive();
    return this.vehicles().map((v) => {
      const tracker = v.tracker ?? null;
      const dormant = isVehicleDormant(
        { trackerId: tracker?.id, lastSeenAt: tracker?.lastSeenAt },
        now,
        DORMANT_STOP_COUNTING_MS,
      );
      const brand = v.brand ? ` · ${v.brand} ${v.model ?? ''}`.trimEnd() : '';
      // « 12 places » (29/09) : les places de chaque véhicule, conducteur compris — rien si inconnues.
      const places = typeof v.seats === 'number' && v.seats > 0 ? ` · ${v.seats} pl.` : '';
      // Hors service DÉCLARÉ : grisé même en édition (le serveur refuserait la réaffectation),
      // sauf s'il est déjà le véhicule de la réservation — sinon la feuille devient inenregistrable.
      const horsService = horsServiceLabel(v.outOfServiceReason);
      return {
        id: v.id,
        label: `${v.plate || '—'}${places}${brand}`,
        horsService,
        // Sièges auto déjà installés : celui qui choisit le véhicule voit ce qu'il n'aura pas à installer.
        aBord: siegesLabel({ baby: v.childSeatsBaby ?? 0, child: v.childSeatsChild ?? 0 }),
        // On DATE le silence au lieu de dire « indisponible » : l'exploitant sait quoi faire.
        silence: dormant ? formatSilenceLabel(tracker?.lastSeenAt, now) : null,
        disabled: (!!horsService || dormant) && v.id !== selected && v.id !== propre && !retro,
      };
    });
  });

  /**
   * Édition : le véhicule de la réservation quand la liste ne le propose pas (hors du périmètre
   * affiché par l'agenda). Une option le représente, présélectionnée — sans elle, et sans « Auto »
   * en édition (T12), le navigateur affichait le premier véhicule de la liste pendant que
   * l'enregistrement gardait l'ancien. Null hors édition, ou s'il est listé.
   */
  protected readonly vehiculeHorsListe = computed<{ id: string; label: string } | null>(() => {
    if (this.mode() !== 'edit') return null;
    const edit = this.editReservation();
    if (!edit?.vehicleId || this.vehicles().some((v) => v.id === edit.vehicleId)) return null;
    return { id: edit.vehicleId, label: edit.vehiclePlate || 'Véhicule actuel' };
  });

  /** Nombre de véhicules grisés pour DORMANCE — sert la phrase d'explication sous le champ. */
  protected readonly dormantCount = computed(
    () => this.vehicleOptions().filter((o) => o.disabled && !o.horsService).length,
  );
  /** Nombre de véhicules grisés parce que déclarés HORS SERVICE. */
  protected readonly horsServiceCount = computed(
    () => this.vehicleOptions().filter((o) => o.disabled && !!o.horsService).length,
  );

  // ─── « 12 places » (29/09) — la taille du groupe, dite avant l'envoi ────────────────────────
  //
  // Le 29/09 à 05:10, sur Client test (3 véhicules de 9 places, 4 de 5, 1 de 4), une demande de
  // 12 places a reçu trois fois « aucun véhicule libre » pendant que le panneau du jour affichait
  // 7 véhicules libres sur 8. Le refus était juste — aucun véhicule n'a 12 places —, mais rien ne le
  // disait. La feuille le dit maintenant sous le champ, et propose de RÉPARTIR le groupe.

  /** Places demandées (« Places min. », conducteur compris), ou null. */
  protected readonly placesDemandees = computed<number | null>(() => {
    const n = parseInt(this.minSeats(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  });

  /** Les véhicules de la société de la demande (celle du véhicule choisi, du bandeau, ou du compte). */
  private readonly vehiculesSociete = computed(() => {
    const f = this.societeDemande();
    return this.vehicles().filter((v) => !f || !v.fleetId || v.fleetId === f);
  });

  /**
   * La capacité du parc EN SERVICE de la société affichée — occupés ou non, comme le serveur
   * (`largestSeats`) : le plus grand nombre de places CONNU, et combien de véhicules n'en ont pas de
   * renseigné (revue r5 du 29/09, C9). Même fonction que le panneau du jour (`placesMaxLibres`) : un
   * minibus jamais saisi n'est plus sauté en silence sous une borne « le plus grand en a 9 ».
   */
  private readonly capaciteParc = computed<CapaciteLibres>(() =>
    placesMaxLibres(this.vehiculesSociete().filter((v) => !v.outOfServiceReason), new Set<string>()),
  );

  /** Le plus grand nombre de places CONNU parmi les véhicules en service de la société. Null si aucun n'est renseigné. */
  protected readonly plusGrandEnService = computed<number | null>(() => this.capaciteParc().max);

  /** Le véhicule choisi dans la liste, ou null (« Auto »). */
  private readonly vehiculeChoisi = computed<ReservationSheetVehicle | null>(() => {
    const id = this.vehicleId();
    return id ? (this.vehicles().find((x) => x.id === id) ?? null) : null;
  });

  /**
   * Aucun véhicule en service de la société n'a autant de places que demandé — sauf si le véhicule
   * CHOISI n'a pas de places renseignées (C9) : le serveur l'accepte (il ne refuse pas sur une donnée
   * absente, `assertAssezDePlaces`), on ne propose donc pas de répartir à côté d'un choix valable.
   */
  protected readonly aucunAssezGrand = computed(() => {
    const n = this.placesDemandees();
    const g = this.plusGrandEnService();
    if (n === null || g === null || n <= g) return false;
    const v = this.vehiculeChoisi();
    return !(v && placesInconnues(v.seats));
  });

  /**
   * L'avertissement sous « Places min. » : aucun véhicule assez grand (« Aucun véhicule n'a 12 places :
   * le plus grand en a 9. »), sinon le véhicule CHOISI trop petit (« TEST-004-XX a 5 places, moins que
   * les 12 demandées. » — le serveur refuse ce couple). Null s'il n'y a rien à dire.
   *
   * Revue r5 (C9) — des places NON RENSEIGNÉES ne permettent pas d'affirmer : un véhicule en service
   * sans places saisies qualifie l'avis (« Aucun véhicule renseigné… ; 1 véhicule sans nombre de places
   * renseigné n'a pas été compté »), comme le serveur (`messageAucunVehicule`) et le panneau du jour
   * (`libelleVehiculesLibres`) ; et le véhicule CHOISI sans places renseignées reçoit son propre avis au
   * lieu d'un « aucun véhicule n'a 12 places » écrit sous lui.
   */
  protected readonly avisPlaces = computed<string | null>(() => {
    const n = this.placesDemandees();
    if (n === null) return null;
    const { max: g, inconnus } = this.capaciteParc();
    if (g === null && inconnus > 0) {
      return 'Aucun véhicule de la société n\'a de nombre de places renseigné : complétez-le dans la vue Parc de l\'agenda.';
    }
    const v = this.vehiculeChoisi();
    if (v && placesInconnues(v.seats)) {
      return `Le nombre de places de ${v.plate || 'ce véhicule'} n'est pas renseigné : vérifiez qu'il accueille ${n > 1 ? `les ${n} personnes` : 'la personne'} (conducteur compris), ou complétez-le dans la vue Parc de l'agenda.`;
    }
    if (g !== null && n > g) {
      if (inconnus === 0) return `Aucun véhicule n'a ${n} places : le plus grand en a ${g}.`;
      const nonComptes = inconnus > 1
        ? `${inconnus} véhicules sans nombre de places renseigné n'ont pas été comptés : complétez-les`
        : '1 véhicule sans nombre de places renseigné n\'a pas été compté : complétez-le';
      return `Aucun véhicule renseigné n'a ${n} places : le plus grand en a ${g} (${nonComptes} dans la vue Parc de l'agenda).`;
    }
    if (v && typeof v.seats === 'number' && v.seats > 0 && v.seats < n) {
      return `${v.plate || 'Ce véhicule'} a ${v.seats} places, moins que les ${n} demandées.`;
    }
    return null;
  });

  /**
   * Les évènements du créneau (réservations, immobilisations) de la société, lus SANS plancher de
   * places pour proposer une répartition. La route de suggestion `GET /reservations/suggest` n'existe
   * plus (retirée le 22/09, P2-6) : on relit `GET /agenda/events` sur le créneau — la lecture du
   * panneau du jour — et l'on applique les MÊMES règles que le vivier du serveur (voir `repartition`).
   * `cle` = créneau + société + génération : changer les places ne relit rien.
   */
  private readonly libresCreneau = signal<{ cle: string; from: string; to: string; events: VehicleEventDto[] } | null>(null);
  /**
   * 'repos' (rien à proposer), 'creneau' (créneau incomplet ou passé), 'droit' (lecture de l'agenda non
   * permise), 'chargement', 'pret', 'erreur'.
   */
  protected readonly libresEtat = signal<'repos' | 'creneau' | 'droit' | 'chargement' | 'pret' | 'erreur'>('repos');
  protected readonly libresErreur = signal<string | null>(null);
  /**
   * La lecture des évènements du créneau (`GET /agenda/events`) exige `agenda_view` ; la feuille, elle,
   * s'ouvre à `reservations_request` (revue du 29/09). Sans ce droit, rien n'est lu : un 403 « Permission
   * requise : agenda_view » sortait en toast rouge et dans le cadre, et la fonction ne servait jamais.
   */
  private readonly peutLireLibres = computed(() => this.perms.can('agenda_view'));
  /** Incrémenté après une répartition envoyée : les véhicules libres se relisent. */
  private readonly generationLibres = signal(0);
  private lectureLibres = 0;
  protected readonly repartitionEnCours = signal(false);
  protected readonly bilanRepartition = signal<BilanRepartition | null>(null);
  /**
   * Créneau + société d'une répartition. Les PLACES n'y entrent pas, volontairement : les changer après
   * un envoi partiel redimensionne le MÊME groupe (la proposition vise le nouveau total moins ce qui est
   * déjà retenu) ; remettre à zéro reproposerait le groupe entier — la sur-réservation que
   * {@link RepartitionEntamee} empêche. Un autre créneau, une autre société, ou la réouverture de la
   * feuille repartent de zéro.
   */
  private readonly cleRepartition = computed(() => `${this.startAt()}|${this.endAt()}|${this.societeBandeau() ?? ''}`);
  private readonly repartitionEntamee = signal<RepartitionEntamee | null>(null);
  /** La répartition entamée, si elle porte sur le créneau et la société affichés ; sinon null. */
  protected readonly entameeCourante = computed<RepartitionEntamee | null>(() => {
    const e = this.repartitionEntamee();
    return e && e.cle === this.cleRepartition() ? e : null;
  });

  /**
   * La répartition proposée : la plus petite combinaison des véhicules LIBRES du créneau qui transporte
   * les PASSAGERS du groupe, un conducteur par véhicule ({@link combinaisonMinimale} — revue r5, C7 :
   * « Places min. 13 (conducteur compris) » = 12 passagers, et chaque véhicule de plus emporte son propre
   * conducteur). « Libre » suit le vivier du serveur (`computeSuggestions`) et le panneau du jour : en
   * service, boîtier non muet depuis 7 j, places renseignées, ni réservation ferme (CONFIRMED,
   * IN_PROGRESS) ni immobilisation sur le créneau (même fin effective que le serveur,
   * `effectiveBlockingEndMs`). Seuls les trajets en cours échappent à cette lecture : le serveur refuse
   * alors la ligne (« roule déjà »), et le bilan le dit.
   *
   * Libres SANS places renseignées (revue r5, C9) : ils n'entrent pas dans la combinaison (on ne compte
   * pas sur une donnée absente), mais ils sont COMPTÉS et dits dans le texte — « hors 1 libre sans
   * nombre de places renseigné » —, et ils interdisent de conclure « même en répartissant… n'offrent
   * que X places » : le minibus jamais saisi est peut-être la réponse.
   *
   * Sièges auto : ils partent sur UNE demande, la première — celle du premier véhicule de la
   * combinaison qui peut les recevoir (à bord, puis stock du créneau selon le réglage de la société).
   *
   * Après un envoi PARTIEL (revue du 29/09, {@link RepartitionEntamee}) : la proposition ne couvre plus
   * que le RESTE (passagers du groupe moins les places passagers des véhicules créés), sans aucun des
   * véhicules déjà tentés — créés, quel que soit leur statut (une demande REQUESTED n'occupe pas le
   * vivier, et aurait été redéposée sur le même véhicule), ou refusés (le même refus reviendrait). Les
   * sièges auto partis avec une demande créée ne sont pas redemandés.
   */
  protected readonly repartition = computed<Repartition | null>(() => {
    const lu = this.libresCreneau();
    const demandees = this.placesDemandees();
    if (!lu || demandees === null || !this.aucunAssezGrand()) return null;
    const entamee = this.entameeCourante();
    const retenus = entamee?.passagersRetenus ?? 0;
    // « Conducteur compris » : le groupe = demandées − 1 passagers ; chaque véhicule ajoute SON conducteur.
    const passagers = demandees - 1 - retenus;
    if (passagers <= 0) return null; // déjà couvert par ce qui a été retenu
    const dejaTentes = new Set(entamee?.pris ?? []);
    const debut = Date.parse(lu.from);
    const fin = Date.parse(lu.to);
    const occupes = new Set<string>();
    for (const ev of lu.events) {
      if (ev.status === 'DONE' || ev.status === 'CANCELLED') continue;
      const st = Date.parse(ev.startAt);
      if (Number.isNaN(st)) continue;
      const finEffective = effectiveBlockingEndMs(ev.type, st, ev.endAt ? Date.parse(ev.endAt) : null);
      if (!(st < fin && finEffective > debut)) continue;
      if (ev.type === 'RESERVATION') {
        if (ev.status === 'CONFIRMED' || ev.status === 'IN_PROGRESS') occupes.add(ev.vehicleId);
      } else if (isImmobilizingEvent(ev)) {
        occupes.add(ev.vehicleId);
      }
    }
    const now = Date.now();
    const candidats = this.vehiculesSociete().filter(
      (v) =>
        !v.outOfServiceReason &&
        !occupes.has(v.id) &&
        !dejaTentes.has(v.id) &&
        !isVehicleDormant({ trackerId: v.tracker?.id ?? null, lastSeenAt: v.tracker?.lastSeenAt ?? null }, now, DORMANT_STOP_COUNTING_MS),
    );
    // Libres dont on ne connaît pas les places (C9) : comptés et dits, jamais combinés.
    const inconnus = candidats.filter((v) => placesInconnues(v.seats)).length;
    const libres = candidats
      .filter((v) => !placesInconnues(v.seats))
      .map((v) => ({ id: v.id, plate: v.plate || '—', seats: v.seats as number, source: v }))
      .sort((a, b) => a.plate.localeCompare(b.plate));
    const combo = combinaisonMinimale(libres, passagers);
    // Tout refusé au premier envoi : rien n'est retenu, on « répartit » encore (sans les refusés).
    const complement = (entamee?.creees.length ?? 0) > 0;
    const pl = (k: number, un: string, plusieurs: string) => (k > 1 ? plusieurs : un);
    const aPlacer = `${passagers} passager${pl(passagers, '', 's')}`;
    const nonComptes = inconnus > 1
      ? `${inconnus} libres sans nombre de places renseigné n'ont pas été comptés : complétez-les dans la vue Parc de l'agenda`
      : '1 libre sans nombre de places renseigné n\'a pas été compté : complétez-le dans la vue Parc de l\'agenda';
    if (!combo) {
      const offertes = libres.reduce((t, v) => t + placesPassagers(v.seats), 0);
      const offre = `${offertes} place${pl(offertes, '', 's')} passager${pl(offertes, '', 's')} (un conducteur par véhicule)`;
      let raison: string;
      if (libres.length === 0 && inconnus > 0) {
        raison =
          `Aucun ${complement ? 'autre ' : ''}véhicule libre de ce créneau n'a de nombre de places renseigné (${inconnus}) : ` +
          `complétez-le dans la vue Parc de l'agenda pour ${complement ? `placer les ${aPlacer} restants` : 'répartir le groupe'}.`;
      } else if (complement) {
        raison = libres.length === 0
          ? `Aucun autre véhicule n'est libre sur ce créneau : il reste ${aPlacer} à placer.`
          : `Les véhicules encore libres${inconnus > 0 ? ' dont les places sont renseignées' : ''} sur ce créneau n'offrent que ${offre} : il reste ${aPlacer} à placer${inconnus > 0 ? ` ; ${nonComptes}` : ''}.`;
      } else if (libres.length === 0) {
        raison = 'Aucun véhicule n\'est libre sur ce créneau, quelle que soit sa taille : impossible de répartir le groupe.';
      } else {
        const verbe = pl(libres.length, 'offre', 'offrent');
        raison = inconnus > 0
          ? `${libres.length > 1 ? `Les ${libres.length} véhicules libres` : 'Le seul véhicule libre'} dont les places sont renseignées n'${verbe} que ${offre} pour ${aPlacer} ; ${nonComptes}.`
          : `Même en répartissant, ${libres.length > 1 ? `les ${libres.length} véhicules libres` : 'le seul véhicule libre'} sur ce créneau n'${verbe} que ${offre} pour ${aPlacer}.`;
      }
      return { vehicules: [], total: 0, texte: null, avisSieges: null, raison, complement };
    }
    let ordre = combo;
    let avisSieges: string | null = null;
    const need = entamee?.siegesPlaces ? { baby: 0, child: 0 } : this.besoin();
    if (need.baby > 0 || need.child > 0) {
      const a = this.seatsAvail();
      const i = combo.findIndex((x) => this.couvreSieges(x.source, need, a) !== false);
      if (i > 0) ordre = [combo[i], ...combo.filter((_, j) => j !== i)];
      avisSieges =
        i < 0
          ? `Les sièges auto (${siegesLabel(need)}) ne tiennent sur aucun de ces véhicules sur ce créneau : la demande qui les porte risque d'être refusée.`
          : `Sièges auto (${siegesLabel(need)}) demandés avec ${ordre[0].plate}.`;
    }
    const total = ordre.reduce((t, v) => t + v.seats, 0);
    const offerts = ordre.reduce((t, v) => t + placesPassagers(v.seats), 0);
    const k = ordre.length;
    // Le compte réel, dit en clair (C7) : l'exploitant voit que chaque véhicule emporte son conducteur.
    const detail =
      `${ordre.map((v) => `${v.plate} (${v.seats} pl.)`).join(' + ')} = ${total} place${pl(total, '', 's')}, ` +
      `dont ${k} conducteur${pl(k, '', 's')} : ${offerts} place${pl(offerts, '', 's')} passager${pl(offerts, '', 's')} pour ${aPlacer}`;
    const hors = inconnus > 0 ? ` (${nonComptes})` : '';
    return {
      vehicules: ordre.map((v) => ({ id: v.id, plate: v.plate, seats: v.seats })),
      total,
      texte: complement
        ? `Compléter le groupe (${retenus} passager${pl(retenus, '', 's')} déjà couvert${pl(retenus, '', 's')}, il en reste ${passagers}) : ${detail}${hors}`
        : `Répartir le groupe : ${detail}${hors}`,
      raison: null,
      avisSieges,
      complement,
    };
  });

  /** Libellé du bouton de répartition : « Réserver ces 2 véhicules », « Compléter le groupe : demander ce véhicule »… */
  protected libelleRepartition(rp: Repartition): string {
    const verbe = this.canManage() ? 'réserver' : 'demander';
    const quoi = rp.vehicules.length > 1 ? `ces ${rp.vehicules.length} véhicules` : 'ce véhicule';
    return rp.complement ? `Compléter le groupe : ${verbe} ${quoi}` : `${verbe === 'réserver' ? 'Réserver' : 'Demander'} ${quoi}`;
  }

  /**
   * Ce véhicule peut-il recevoir les sièges auto demandés sur le créneau ? Sièges à bord d'abord, le
   * stock du créneau pour le reste — ou rien sous « installés seulement ». Null : on ne sait pas (la
   * disponibilité n'est pas lue) ; le serveur tranchera.
   */
  private couvreSieges(
    v: ReservationSheetVehicle,
    need: { baby: number; child: number },
    a: ChildSeatAvailabilityDto | null,
  ): boolean | null {
    if (need.baby <= 0 && need.child <= 0) return true;
    if (!a) return null;
    const reste = {
      baby: Math.max(0, need.baby - (v.childSeatsBaby ?? 0)),
      child: Math.max(0, need.child - (v.childSeatsChild ?? 0)),
    };
    if (a.policy === 'INSTALLED_ONLY') return reste.baby === 0 && reste.child === 0;
    return reste.baby <= a.available.baby && reste.child <= a.available.child;
  }

  // IA placement
  protected readonly aiLoading = signal(false);
  protected readonly aiError = signal<string | null>(null);
  protected readonly aiNoMatch = signal(false);
  protected readonly aiNotes = signal<string | null>(null);
  protected readonly aiProposals = signal<{ vehicleId: string; plate: string | null; seats: number | null; energy?: string | null; costPerKm?: number | null; score: number; reasoning: string }[]>([]);
  /** Phrase « N véhicule(s) écarté(s) » (immobilisés / capacité inconnue), sinon null. */
  protected readonly aiExcludedInfo = signal<string | null>(null);
  /** Coût € de l'appel IA (transparence), affiché après l'analyse. */
  protected readonly aiCost = signal<number | null>(null);

  // File de validation
  protected readonly queueLoading = signal(false);
  protected readonly pending = signal<VehicleEventDto[]>([]);
  protected readonly busyId = signal<string | null>(null);

  constructor() {
    this.aiStatus.ensureLoaded(); // « Suggérer avec l'IA » masqué si l'IA est coupée pour la flotte
    // À l'ouverture : mode ÉDITION si une réservation est fournie, sinon (ré)initialise le
    // créneau depuis la date cliquée (ou la prochaine heure) pour une demande / validation.
    effect(() => {
      if (!this.open()) return;
      const edit = this.editReservation();
      this.resetAi();
      this.reqError.set(null);
      this.bilanRepartition.set(null);
      this.repartitionEntamee.set(null); // une réouverture = un nouveau groupe
      if (edit) {
        const meta = (edit.metadata ?? {}) as { reason?: string; retroactive?: boolean; criteria?: ReservationCriteria };
        const debut = toLocalInput(new Date(edit.startAt));
        const fin = edit.endAt ? toLocalInput(new Date(edit.endAt)) : '';
        this.startAt.set(debut);
        this.endAt.set(fin);
        this.creneauOuverture.set({ debut, fin });
        this.vehicleId.set(edit.vehicleId);
        this.reason.set(meta.reason ?? '');
        this.motifOuverture.set(meta.reason ?? '');
        this.retroactive.set(meta.retroactive === true);
        this.minSeats.set(meta.criteria?.minSeats ? String(meta.criteria.minSeats) : '');
        this.childSeatsBaby.set(meta.criteria?.childSeatsBaby ? String(meta.criteria.childSeatsBaby) : '');
        this.childSeatsChild.set(meta.criteria?.childSeatsChild ? String(meta.criteria.childSeatsChild) : '');
        // Le groupe posé sur la réservation, tel quel — on n'y substitue pas celui du véhicule.
        // `groupTouched` à vrai : le défaut ne suit pas le véhicule. `groupEdited` à faux : tant que
        // l'utilisateur n'y touche pas, l'enregistrement n'envoie pas `group` (le serveur n'y touche pas).
        const g = groupePoseDe(edit.metadata);
        this.groupePose.set(g);
        this.groupTouched.set(true);
        this.groupEdited.set(false);
        if (!g) { this.groupChoice.set(''); this.groupName.set(''); }
        else if (g.id) { this.groupChoice.set(g.id); this.groupName.set(''); }
        else { this.groupChoice.set(GROUPE_AUTRE); this.groupName.set(g.name); }
        this.mode.set('edit');
        return;
      }
      const base = this.defaultDate() ? new Date(`${this.defaultDate()}T09:00:00`) : new Date();
      if (!this.defaultDate()) { base.setMinutes(0, 0, 0); base.setHours(base.getHours() + 1); }
      this.startAt.set(toLocalInput(base));
      this.endAt.set(toLocalInput(new Date(base.getTime() + 60 * 60 * 1000)));
      this.vehicleId.set('');
      this.minSeats.set(''); this.childSeatsBaby.set(''); this.childSeatsChild.set(''); this.reason.set(''); this.motifOuverture.set('');
      this.retroactive.set(false);
      this.creneauOuverture.set(null);
      this.groupChoice.set(''); this.groupName.set(''); this.groupTouched.set(false); this.groupesValidation.set({});
      this.groupEdited.set(false); this.groupePose.set(null);
      const m = this.startMode() === 'validate' && this.canManage() ? 'validate' : 'request';
      this.mode.set(m);
      if (m === 'validate') void this.loadQueue();
    });
    // Le groupe de la réservation SUIT le véhicule choisi (son groupe) tant que l'utilisateur n'a
    // pas décidé lui-même — ensuite, c'est son choix qui tient, même si le véhicule change.
    effect(() => {
      const id = this.vehicleId();
      const touche = this.groupTouched();
      const ouvert = this.open();
      if (!ouvert || touche || this.mode() !== 'request') return;
      // « Auto » : aucun véhicule encore — le champ dit que ce sera celui du véhicule attribué
      // (revue du 29/09, C33), au lieu d'un « — Aucun groupe — » que le serveur démentirait.
      if (!id) { this.groupChoice.set(GROUPE_DEFAUT); this.groupName.set(''); return; }
      const g = this.vehicles().find((v) => v.id === id)?.group ?? null;
      this.groupChoice.set(g?.id ?? '');
      this.groupName.set('');
    });
    // Disponibilité des sièges auto sur le créneau saisi — relue à chaque changement de créneau
    // (ou de société), en mode demande et en mode édition. Best-effort : une lecture qui échoue
    // laisse simplement la ligne vide ; le serveur revalide de toute façon à l'envoi.
    //
    // La fenêtre lue est CELLE QUE LE SERVEUR CONTRÔLERA (troisième passe, T11) — sinon la ligne dit
    // le contraire de ce qu'il appliquera :
    //  - édition : [max(début, maintenant), fin), comme `update()` (C44) — les heures écoulées
    //    n'engagent plus aucun siège. Lue depuis le début, une réservation terminée lundi matin (mais
    //    jamais close) comptait encore, et la prolongation du mardi s'affichait « il en manque » alors
    //    que le serveur l'accepte. Tout le créneau écoulé : rien à contrôler, rien à afficher ;
    //  - « déjà effectuée » : le serveur ne contrôle aucun siège (édition : la case OU la réservation
    //    déjà marquée telle ; demande : la case ET un début passé) — rien à afficher non plus.
    effect(() => {
      const ouvert = this.open();
      const mode = this.mode();
      const s = this.startAt();
      const e = this.endAt();
      const fleetId = this.societeBandeau() ?? undefined;
      const edit = this.editReservation();
      const vehicleId = this.vehicleId() || undefined; // ses sièges à bord entrent dans le compte
      const retro = this.retroactive();
      if (!ouvert || mode === 'validate' || !s || !e) { this.viderSieges(); return; }
      const si = new Date(s); const ei = new Date(e);
      if (Number.isNaN(si.getTime()) || Number.isNaN(ei.getTime()) || ei.getTime() <= si.getTime()) { this.viderSieges(); return; }
      if (this.needsFleet()) { this.viderSieges(); return; }
      const maintenant = Date.now();
      const dejaEffectuee = mode === 'edit'
        ? retro || (edit?.metadata as { retroactive?: unknown } | null | undefined)?.retroactive === true
        : retro && si.getTime() < maintenant;
      if (dejaEffectuee) { this.viderSieges(); return; }
      const debutLu = mode === 'edit' ? Math.max(si.getTime(), maintenant) : si.getTime();
      if (debutLu >= ei.getTime()) { this.viderSieges(); return; }
      void this.chargerSieges(
        { startAt: new Date(debutLu).toISOString(), endAt: ei.toISOString(), fleetId, excludeId: mode === 'edit' ? edit?.id : undefined, vehicleId },
        debutLu > si.getTime(),
      );
    });
    // « 12 places » (29/09) — dès qu'aucun véhicule n'est assez grand, en DEMANDE, sur un créneau à
    // venir : les évènements du créneau sont relus (une seule fois par créneau et par société ;
    // changer les places ne relit rien) pour proposer une répartition. Hors de ce cas, rien n'est lu.
    effect(() => {
      const actif =
        this.open() && this.mode() === 'request' && this.aucunAssezGrand() && !this.retroactive() && !this.needsFleet();
      const s = this.startAt();
      const e = this.endAt();
      const fleetId = this.societeBandeau() ?? undefined;
      const generation = this.generationLibres();
      const peutLire = this.peutLireLibres();
      untracked(() => {
        if (!actif) {
          this.lectureLibres++;
          this.libresCreneau.set(null);
          this.libresEtat.set('repos');
          return;
        }
        if (!peutLire) {
          // Sans `agenda_view`, `GET /agenda/events` répond 403 : on ne l'appelle pas (revue du 29/09).
          this.lectureLibres++;
          this.libresCreneau.set(null);
          this.libresEtat.set('droit');
          return;
        }
        const si = new Date(s);
        const ei = new Date(e);
        if (!s || !e || Number.isNaN(si.getTime()) || Number.isNaN(ei.getTime()) || ei.getTime() <= si.getTime() || si.getTime() < Date.now()) {
          this.lectureLibres++;
          this.libresCreneau.set(null);
          this.libresEtat.set('creneau');
          return;
        }
        const from = si.toISOString();
        const to = ei.toISOString();
        const cle = `${from}|${to}|${fleetId ?? ''}|${generation}`;
        if (this.libresCreneau()?.cle === cle && this.libresEtat() === 'pret') return;
        void this.chargerLibres(cle, from, to, fleetId);
      });
    });
  }

  /** Lit les évènements du créneau pour la répartition ; une réponse en retard n'écrase pas la dernière. */
  private async chargerLibres(cle: string, from: string, to: string, fleetId: string | undefined): Promise<void> {
    const n = ++this.lectureLibres;
    this.libresEtat.set('chargement');
    this.libresErreur.set(null);
    try {
      const events = await firstValueFrom(this.api.listEvents({ from, to, fleetId }));
      if (n !== this.lectureLibres) return;
      this.libresCreneau.set({ cle, from, to, events });
      this.libresEtat.set('pret');
    } catch (e) {
      swallow('reservation-sheet:libresCreneau', e);
      if (n !== this.lectureLibres) return;
      this.libresCreneau.set(null);
      this.libresEtat.set('erreur');
      this.libresErreur.set(apiErrorMessage(e, 'Les véhicules libres de ce créneau n\'ont pas pu être lus : impossible de proposer une répartition.'));
    }
  }

  /** Numéro de la dernière lecture partie : une réponse en retard ne doit pas écraser la dernière. */
  private siegesLecture = 0;
  /**
   * Vrai quand la ligne des sièges a été lue à partir de MAINTENANT (édition d'une réservation
   * commencée) : le libellé dit « sur la suite du créneau », pas « sur ce créneau ».
   */
  protected readonly seatsDepuisMaintenant = signal(false);
  private async chargerSieges(
    q: { startAt: string; endAt: string; fleetId?: string; excludeId?: string; vehicleId?: string },
    depuisMaintenant = false,
  ): Promise<void> {
    const n = ++this.siegesLecture;
    try {
      const a = await firstValueFrom(this.api.childSeatAvailability(q));
      if (n === this.siegesLecture) { this.seatsAvail.set(a); this.seatsDepuisMaintenant.set(depuisMaintenant); }
    } catch (e) {
      swallow('reservation-sheet:childSeats', e);
      if (n === this.siegesLecture) this.seatsAvail.set(null);
    }
  }

  /**
   * Vide la ligne des sièges ET périme la lecture en vol : cocher « déjà effectuée » pendant une
   * lecture la laissait sinon réafficher, à son retour, un stock que le serveur ne contrôlera pas.
   */
  private viderSieges(): void {
    this.siegesLecture++;
    this.seatsAvail.set(null);
  }

  /** Le besoin de sièges saisi, en entiers (vide ou invalide = 0). */
  private besoin(): { baby: number; child: number } {
    const lire = (v: string) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? Math.min(50, n) : 0; };
    return { baby: lire(this.childSeatsBaby()), child: lire(this.childSeatsChild()) };
  }

  /**
   * « 1 bébé · 2 enfant (1 bébé à bord · 1 enfant du stock) » — le besoin d'une demande, et ce que
   * son véhicule pré-retenu a déjà à bord. Sans besoin : null.
   */
  protected besoinSieges(r: VehicleEventDto): string | null {
    const c = (r.metadata as { criteria?: ReservationCriteria } | null)?.criteria;
    const need = { baby: c?.childSeatsBaby ?? 0, child: c?.childSeatsChild ?? 0 };
    const besoin = siegesLabel(need);
    if (!besoin) return null;
    const v = this.vehicles().find((x) => x.id === r.vehicleId);
    const aBord = { baby: Math.min(need.baby, v?.childSeatsBaby ?? 0), child: Math.min(need.child, v?.childSeatsChild ?? 0) };
    const duStock = { baby: need.baby - aBord.baby, child: need.child - aBord.child };
    const detail = [siegesLabel(aBord) ? `${siegesLabel(aBord)} à bord` : '', siegesLabel(duStock) ? `${siegesLabel(duStock)} du stock` : ''].filter(Boolean);
    return detail.length > 0 ? `${besoin} (${detail.join(' · ')})` : besoin;
  }

  protected valOf(n: number | null): string { return n === null || n === undefined ? '—' : String(n); }
  protected scoreClass(v: number): string { return v >= 0.7 ? 'rs-chip--hi' : v >= 0.4 ? 'rs-chip--mid' : 'rs-chip--lo'; }

  /**
   * Plaques dont une proposition de l'agent sera écartée si l'on valide (lot 3b), sinon `null`.
   *
   * Vide dans le cas normal : ce bandeau n'apparaît que le jour où le parc était entièrement
   * pré-rempli et où la demande a dû déplacer quelque chose.
   */
  protected deplacements(r: VehicleEventDto): string[] | null {
    const brut = (r.metadata as Record<string, unknown> | null)?.['deplaceePropositions'];
    if (!Array.isArray(brut) || brut.length === 0) return null;
    const plaques = brut
      .map((d) => (d as { plate?: unknown })?.plate)
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    return plaques.length > 0 ? plaques : null;
  }

  /** Infos du demandeur PUBLIC (P4) si la demande vient d'un lien public, sinon null. */
  /**
   * F13 (recette du 28/09) — les véhicules d'une même demande publique (même `bookingRef`) forment
   * UNE carte, validée ou refusée d'un seul geste. Une demande interne, ou sans référence, reste seule.
   */
  protected readonly groupes = computed(() => {
    const parCle = new Map<string, VehicleEventDto[]>();
    for (const r of this.pending()) {
      const ref = (r.metadata as { bookingRef?: unknown } | null)?.bookingRef;
      const cle = typeof ref === 'string' && ref ? `ref:${ref}` : `id:${r.id}`;
      const l = parCle.get(cle);
      if (l) l.push(r);
      else parCle.set(cle, [r]);
    }
    return [...parCle.entries()].map(([cle, items]) => ({ cle, items, chef: items[0] }));
  });

  /** La fin tombe-t-elle le même jour que le début ? Sinon la file écrit la date de fin (F9). */
  /** Jours civils couverts par une réservation (1 = même jour) — la file le dit sans ouvrir. */
  protected dureeJours(r: VehicleEventDto): number {
    if (!r.endAt) return 1;
    const a = new Date(r.startAt); const b = new Date(r.endAt);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 1;
    const ja = new Date(a.getFullYear(), a.getMonth(), a.getDate()).getTime();
    const jb = new Date(b.getFullYear(), b.getMonth(), b.getDate()).getTime();
    return jb < ja ? 1 : Math.round((jb - ja) / 86400000) + 1;
  }

  protected memeJour(r: VehicleEventDto): boolean {
    if (!r.endAt) return true;
    const a = new Date(r.startAt);
    const b = new Date(r.endAt);
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  }

  protected async confirmGroupe(g: { cle: string; items: VehicleEventDto[] }): Promise<void> {
    this.busyId.set(g.cle);
    let faits = 0;
    try {
      // Le groupe part avec la validation SEULEMENT si le valideur a changé le choix de la carte
      // (revue du 29/09, C8/C36/C33). Sans geste — ou revenu au choix d'origine —, la clé est omise :
      // chaque véhicule garde son défaut serveur (groupe déjà posé, texte libre compris, sinon celui
      // de SON véhicule) — et la carte l'a dit : ce groupe commun, ou « Groupes différents (…) » (R10).
      // Un choix, lui, part pour TOUS les véhicules de la carte, même s'il est le groupe de l'un d'eux.
      // Envoyer la valeur affichée écrasait un groupe libre par celui du véhicule.
      // « — Aucun — » choisi part en `null` : aucun groupe, explicitement.
      const corps = this.corpsValidation(g);
      for (const r of g.items) {
        await firstValueFrom(this.api.confirmReservation(r.id, corps));
        faits++;
        this.pending.update((l) => l.filter((x) => x.id !== r.id));
      }
      this.toast.success(
        g.items.length > 1 ? `${faits} véhicules validés` : 'Réservation validée',
        g.items.map((r) => r.vehiclePlate ?? '').filter(Boolean).join(', '),
      );
      this.created.emit();
    } catch (e) {
      swallow('reservation-sheet:confirmGroupe', e);
      // Une validation à moitié faite se DIT : ce qui est validé l'est, le reste attend encore.
      this.toast.error(faits > 0 ? `Validé ${faits} sur ${g.items.length}` : 'Échec', this.errMsg(e));
      if (faits > 0) this.created.emit();
    } finally {
      this.busyId.set(null);
    }
  }

  protected async rejectGroupe(g: { cle: string; items: VehicleEventDto[] }): Promise<void> {
    this.busyId.set(g.cle);
    let faits = 0;
    try {
      for (const r of g.items) {
        await firstValueFrom(this.api.cancelReservation(r.id));
        faits++;
        this.pending.update((l) => l.filter((x) => x.id !== r.id));
      }
      this.toast.success(
        g.items.length > 1 ? `${faits} véhicules refusés` : 'Demande refusée',
        g.items.map((r) => r.vehiclePlate ?? '').filter(Boolean).join(', '),
      );
      this.created.emit();
    } catch (e) {
      swallow('reservation-sheet:rejectGroupe', e);
      this.toast.error(faits > 0 ? `Refusé ${faits} sur ${g.items.length}` : 'Échec', this.errMsg(e));
      if (faits > 0) this.created.emit();
    } finally {
      this.busyId.set(null);
    }
  }

  protected publicInfo(r: VehicleEventDto): { requester: string; contact: string; seats: number | null } | null {
    const m = r.metadata as Record<string, unknown> | null;
    if (!m || m['public'] !== true) return null;
    return {
      requester: typeof m['requester'] === 'string' ? (m['requester'] as string) : 'Demande publique',
      contact: typeof m['requesterContact'] === 'string' ? (m['requesterContact'] as string) : '',
      seats: typeof m['seatsNeeded'] === 'number' ? (m['seatsNeeded'] as number) : null,
    };
  }

  /** Libellé court d'énergie (badge de proposition). */
  protected energyLabel(e: string | null | undefined): string {
    switch (e) {
      case 'ELECTRIQUE': return 'Électrique';
      case 'DIESEL': return 'Diesel';
      case 'ESSENCE': return 'Essence';
      case 'HYBRIDE': return 'Hybride';
      default: return e ?? '';
    }
  }

  protected setValidate(): void {
    this.mode.set('validate');
    void this.loadQueue();
  }

  private resetAi(): void {
    this.aiProposals.set([]); this.aiError.set(null); this.aiNoMatch.set(false); this.aiNotes.set(null);
    this.aiExcludedInfo.set(null); this.aiCost.set(null);
  }

  /** Compose la phrase de transparence sur les véhicules écartés avant le raisonnement IA. */
  private excludedInfo(immobilized: number, unknownCapacity: number): string | null {
    const parts: string[] = [];
    if (immobilized > 0) parts.push(`${immobilized} immobilisé(s) (incident ou maintenance)`);
    if (unknownCapacity > 0) parts.push(`${unknownCapacity} sans capacité renseignée (à compléter dans Parc & capacités)`);
    if (parts.length === 0) return null;
    return `Écartés d'office : ${parts.join(' · ')}.`;
  }

  protected choisirGroupe(valeur: string): void {
    this.groupTouched.set(true);
    this.groupEdited.set(true);
    this.groupChoice.set(valeur);
    if (valeur !== GROUPE_AUTRE) this.groupName.set('');
  }

  protected saisirNomGroupe(nom: string): void {
    this.groupName.set(nom);
    this.groupTouched.set(true);
    this.groupEdited.set(true);
  }

  /**
   * Ce que dit le champ, pour le serveur : un groupe de la société (id), un nom libre, ou null
   * (aucun — « — Aucun groupe — », ou « Autre… » laissé sans nom, ce que la feuille dit à l'écran).
   * Un id introuvable dans les options part avec son id (le serveur relit le nom, ou refuse en 400
   * visible) : le transformer en null effaçait un groupe en silence.
   */
  private groupePayload(): ReservationGroupDto | null {
    const c = this.groupChoice();
    if (!c || c === GROUPE_DEFAUT) return null;
    if (c === GROUPE_AUTRE) {
      const name = this.groupName().trim();
      return name ? { id: null, name } : null;
    }
    const g = this.groupOptionsFeuille().find((x) => x.id === c);
    return { id: c, name: g?.name ?? '' };
  }

  /** Édition : le champ dit-il encore le groupe posé à l'ouverture ? (re-choisi après un détour compris) */
  private groupeCommeALOuverture(): boolean {
    const p = this.groupePose();
    const c = this.groupChoice();
    if (!p) return c === '' || (c === GROUPE_AUTRE && !this.groupName().trim());
    if (p.id) return c === p.id;
    return c === GROUPE_AUTRE && this.groupName().trim() === p.name;
  }

  /**
   * La clé `group` du corps envoyé, ou rien (revue du 29/09). Le contrat serveur : absent = le
   * défaut (demande : groupe du véhicule retenu ; édition : on ne touche à rien), `null` = aucun.
   *  - Demande : envoyée seulement si un gestionnaire a touché au champ et n'a pas laissé « Groupe
   *    du véhicule attribué ».
   *  - Édition : envoyée seulement si le champ a été modifié APRÈS l'ouverture et ne dit plus le
   *    groupe posé — renvoyer un groupe posé depuis supprimé ferait refuser (400) une simple
   *    prolongation.
   */
  private champGroupe(): { group?: ReservationGroupDto | null } {
    if (!this.canManage()) return {};
    if (this.mode() === 'edit') {
      if (!this.groupEdited() || this.groupeCommeALOuverture()) return {};
      return { group: this.groupePayload() };
    }
    if (!this.groupTouched() || this.groupChoice() === GROUPE_DEFAUT) return {};
    return { group: this.groupePayload() };
  }

  /** Groupe affiché sur une carte de la file : choisi par le valideur, sinon le défaut de la carte. */
  protected groupeValidation(g: { cle: string }): string {
    const choisi = this.groupesValidation()[g.cle];
    if (choisi !== undefined) return choisi;
    return this.cartesGroupe().get(g.cle)?.defaut ?? '';
  }

  /**
   * Corps de la validation d'une carte, le MÊME pour chacun de ses véhicules : `{}` tant que le
   * valideur n'a pas changé le choix d'origine (ou est revenu à « Groupes différents ») ; sinon le
   * groupe choisi, imposé à tous (R10) — « — Aucun — » en `null`, un nom libre avec un id null.
   */
  private corpsValidation(g: { cle: string }): { group?: ReservationGroupDto | null } {
    const carte = this.cartesGroupe().get(g.cle);
    const choisi = this.groupesValidation()[g.cle];
    if (choisi === undefined || !carte || choisi === carte.defaut || choisi === GROUPE_PAR_VEHICULE) return {};
    if (!choisi) return { group: null };
    const o = carte.options.find((x) => x.id === choisi);
    if (choisi.startsWith(`${GROUPE_POSE_LIBRE}:`)) return o ? { group: { id: null, name: o.name } } : {};
    return { group: { id: choisi, name: o?.name ?? '' } };
  }

  protected choisirGroupeValidation(cle: string, valeur: string): void {
    this.groupesValidation.update((m) => ({ ...m, [cle]: valeur }));
  }

  private criteria(): ReservationCriteria {
    const s = parseInt(this.minSeats(), 10);
    const need = this.besoin();
    return {
      minSeats: Number.isFinite(s) && s > 0 ? s : undefined,
      childSeatsBaby: need.baby > 0 ? need.baby : undefined,
      childSeatsChild: need.child > 0 ? need.child : undefined,
    };
  }

  private slot(): { startAt: string; endAt: string } | null {
    const s = this.startAt(); const e = this.endAt();
    if (!s || !e) { this.reqError.set('Renseignez le créneau.'); return null; }
    const si = new Date(s).toISOString(); const ei = new Date(e).toISOString();
    if (new Date(ei).getTime() <= new Date(si).getTime()) { this.reqError.set('La fin doit être après le début.'); return null; }
    // Dates passées bloquées, sauf consignation d'une réservation déjà effectuée (le backend revalide)
    // — et sauf, en édition, un début INCHANGÉ : une réservation déjà commencée se prolonge, change de
    // groupe ou de véhicule sans qu'on la « déplace dans le passé » (revue du 29/09, C44). Ce début
    // n'est alors pas renvoyé, et le serveur ne le contrôle pas non plus.
    if (!this.retroactive() && !this.debutInchange() && new Date(si).getTime() < Date.now()) {
      this.reqError.set(
        this.mode() === 'edit'
          ? 'Impossible de déplacer le début dans le passé. Remets le début d\'origine, ou coche « réservation déjà effectuée » pour une sortie déjà réalisée.'
          : 'Impossible de réserver dans le passé. Coche « réservation déjà effectuée » pour enregistrer une sortie déjà réalisée.',
      );
      return null;
    }
    return { startAt: si, endAt: ei };
  }

  protected async suggestAi(): Promise<void> {
    this.reqError.set(null); this.resetAi();
    if (this.needsFleet()) { this.aiError.set('Choisis une société dans le sélecteur en haut de page avant de lancer l\'IA.'); return; }
    const slot = this.slot();
    if (!slot) return;
    this.aiLoading.set(true);
    try {
      const res = await firstValueFrom(this.ai.placementSuggest({
        ...slot,
        fleetId: this.societeBandeau() ?? undefined,
        reason: this.reason() || undefined,
        criteria: this.criteria(),
      }));
      this.aiProposals.set(res.proposals);
      this.aiNoMatch.set(res.noGoodMatch);
      this.aiNotes.set(res.notes ?? null);
      this.aiExcludedInfo.set(this.excludedInfo(res.excludedImmobilized ?? 0, res.excludedUnknownCapacity ?? 0));
      this.aiCost.set(res.aiCostEur ?? null);
      if (res.proposals.length > 0) this.vehicleId.set(res.proposals[0].vehicleId); // pré-sélectionne le meilleur
    } catch (e) {
      swallow('reservation-sheet:suggestAi', e);
      this.aiError.set(this.errMsg(e));
    } finally {
      this.aiLoading.set(false);
    }
  }

  protected async submit(): Promise<void> {
    if (this.repartitionEnCours()) return;
    this.reqError.set(null);
    this.bilanRepartition.set(null);
    if (this.needsFleet()) { this.reqError.set('Choisis une société dans le sélecteur en haut de page avant de réserver.'); return; }
    const slot = this.slot();
    if (!slot) return;
    this.submitting.set(true);
    try {
      const res = await firstValueFrom(this.api.requestReservation({
        vehicleId: this.vehicleId() || undefined,
        fleetId: this.societeBandeau() ?? undefined,
        startAt: slot.startAt,
        endAt: slot.endAt,
        reason: this.reason() || undefined,
        criteria: this.criteria(),
        retroactive: this.retroactive() || undefined,
        // Un gestionnaire choisit le groupe ; un simple demandeur (ou le défaut laissé tel quel) laisse
        // le serveur poser celui du véhicule. « — Aucun groupe — » part en null : aucun, explicitement.
        ...this.champGroupe(),
      }));
      this.created.emit();
      // #5 — le backend place la réservation selon le droit de l'appelant : CONFIRMED (directement
      // dans l'agenda) s'il peut gérer, sinon REQUESTED (demande à valider). On reflète le résultat.
      if (res.status === 'CONFIRMED') {
        this.toast.success(
          this.retroactive() ? 'Réservation enregistrée' : 'Réservé',
          this.retroactive() ? 'La sortie déjà effectuée est consignée à sa date.' : 'La réservation est placée dans l\'agenda.',
        );
      } else {
        this.toast.success('Demande déposée', 'À valider par un gestionnaire.');
      }
      this.closed.emit();
    } catch (e) {
      swallow('reservation-sheet:submit', e);
      this.reqError.set(this.errMsg(e));
    } finally {
      this.submitting.set(false);
    }
  }

  /**
   * « 12 places » (29/09) — réserver la répartition proposée : UNE demande par véhicule, envoyées
   * l'une après l'autre, chacune avec son `vehicleId`, SANS plancher de places (le serveur refuse un
   * véhicule choisi plus petit que `minSeats` : c'est la répartition qui couvre le groupe), avec le
   * même créneau, le même groupe et le même motif suffixé « (1/2) », « (2/2) ». Les sièges auto sont
   * demandés sur la première seulement (un groupe = un besoin de sièges). Réservations INTERNES par la
   * route habituelle (`POST /reservations/request`) : ni lien public, ni courriel au demandeur.
   *
   * Un refus n'arrête pas les suivantes, et ne défait RIEN : ce qui a été créé reste créé, et le bilan
   * le dit (créées, refusées avec le motif du serveur tel quel). Tout réussi : la feuille se referme,
   * comme une réservation simple.
   *
   * Revue du 29/09 — un envoi partiel est MÉMORISÉ ({@link RepartitionEntamee}) : la proposition
   * suivante ne complète que le reste, sans les véhicules déjà tentés, et le bilan s'y cumule. Un
   * complément numérote ses motifs « (complément 1/1) » : les numéros du premier envoi sont déjà pris.
   */
  protected async reserverRepartition(): Promise<void> {
    const rp = this.repartition();
    if (!rp || rp.vehicules.length === 0 || this.repartitionEnCours() || this.submitting()) return;
    const entamee = this.entameeCourante();
    const bilanPrecedent = entamee ? this.bilanRepartition() : null;
    this.reqError.set(null);
    if (this.needsFleet()) { this.reqError.set('Choisis une société dans le sélecteur en haut de page avant de réserver.'); return; }
    if (this.retroactive()) return; // une sortie déjà effectuée se consigne véhicule par véhicule
    const slot = this.slot();
    if (!slot) return;
    this.bilanRepartition.set(null);
    const cle = this.cleRepartition();
    const besoin = this.placesDemandees();
    // Les sièges auto déjà partis avec une demande créée ne sont pas redemandés par un complément.
    const need = entamee?.siegesPlaces ? { baby: 0, child: 0 } : this.besoin();
    const avecSieges = need.baby > 0 || need.child > 0;
    const motif = this.reason().trim() || `Groupe de ${besoin ?? rp.total} places réparti`;
    const groupe = this.champGroupe();
    const fleetId = this.societeBandeau() ?? undefined;
    const n = rp.vehicules.length;
    const complement = rp.complement; // une partie du groupe est déjà retenue sur ce créneau
    const creees: BilanRepartition['creees'] = [];
    const refusees: BilanRepartition['refusees'] = [];
    let passagersCrees = 0;
    let siegesPlaces = entamee?.siegesPlaces ?? false;
    this.repartitionEnCours.set(true);
    try {
      for (const [i, v] of rp.vehicules.entries()) {
        const criteria: ReservationCriteria =
          i === 0
            ? {
                ...(need.baby > 0 ? { childSeatsBaby: need.baby } : {}),
                ...(need.child > 0 ? { childSeatsChild: need.child } : {}),
              }
            : {};
        try {
          const res = await firstValueFrom(
            this.api.requestReservation({
              vehicleId: v.id,
              fleetId,
              startAt: slot.startAt,
              endAt: slot.endAt,
              reason: complement ? `${motif} (complément ${i + 1}/${n})` : `${motif} (${i + 1}/${n})`,
              criteria,
              ...groupe,
            }),
          );
          creees.push({ plate: v.plate, statut: res.status });
          passagersCrees += placesPassagers(v.seats); // son conducteur est assis : il ne couvre pas un passager (C7)
          if (i === 0 && avecSieges) siegesPlaces = true;
        } catch (e) {
          swallow('reservation-sheet:repartition', e);
          refusees.push({ plate: v.plate, motif: this.errMsg(e) });
        }
      }
    } finally {
      this.repartitionEnCours.set(false);
    }
    // Chaque véhicule tenté — créé (quel que soit son statut) ou refusé — sort des propositions suivantes.
    const suite: RepartitionEntamee = {
      cle,
      pris: [...(entamee?.pris ?? []), ...rp.vehicules.map((v) => v.id)],
      passagersRetenus: (entamee?.passagersRetenus ?? 0) + passagersCrees,
      creees: [...(entamee?.creees ?? []), ...creees],
      siegesPlaces,
    };
    this.repartitionEntamee.set(suite);
    if (creees.length > 0) this.created.emit();
    if (refusees.length === 0) {
      // Revue r5 (C10) : le toast se bâtit sur les statuts CUMULÉS du groupe — ce qui est ferme d'un
      // côté, ce qui attend un gestionnaire de l'autre —, jamais sur « au moins une demande ».
      const { titre, corps } = toastRepartition(suite.creees, complement);
      this.toast.success(titre, corps);
      this.closed.emit();
      return;
    }
    // Refus : la feuille reste ouverte sur le bilan (cumulé avec celui de l'envoi précédent), et les
    // véhicules libres se relisent ; la proposition suivante ne complète que le reste.
    this.bilanRepartition.set({
      creees: [...(bilanPrecedent?.creees ?? []), ...creees],
      refusees: [...(bilanPrecedent?.refusees ?? []), ...refusees],
    });
    this.generationLibres.update((g) => g + 1);
    if (creees.length > 0) {
      this.toast.error(`Répartition incomplète : ${creees.length} sur ${n}`, 'Ce qui a été créé est conservé — voir le bilan dans la feuille.');
    }
  }

  /** #4 — Enregistrer l'édition d'une réservation (créneau / véhicule / motif / critères). */
  protected async saveEdit(): Promise<void> {
    this.reqError.set(null);
    const edit = this.editReservation();
    if (!edit) return;
    const slot = this.slot();
    if (!slot) return;
    // Plus d'« Auto » en édition (T12) : une réservation garde toujours un véhicule, et un PATCH sans
    // `vehicleId` le laisserait tel quel sous un toast « enregistré ». Garde défensive.
    if (!this.vehicleId()) { this.reqError.set('Choisis un véhicule : une réservation garde toujours le sien.'); return; }
    // N'envoyer que les bornes MODIFIÉES (revue du 29/09, C44) : un `startAt` renvoyé tel quel
    // suffisait au serveur pour tenir le créneau pour « changé » et refuser un début déjà passé.
    // Comparaison sur les chaînes locales à la minute, comme le sélecteur les écrit.
    const o = this.creneauOuverture();
    const finInchangee = !!o && this.endAt() === o.fin;
    // Motif : envoyé dès qu'il diffère de celui de l'ouverture, VIDE compris (T13) — le serveur
    // l'efface alors ; inchangé, la clé est omise et le serveur n'y touche pas.
    const motif = this.reason().trim();
    const motifChange = motif !== this.motifOuverture().trim();
    this.submitting.set(true);
    try {
      await firstValueFrom(this.api.updateReservation(edit.id, {
        ...(this.debutInchange() ? {} : { startAt: slot.startAt }),
        ...(finInchangee ? {} : { endAt: slot.endAt }),
        ...(motifChange ? { reason: motif } : {}),
        criteria: this.criteria(),
        vehicleId: this.vehicleId() || undefined,
        retroactive: this.retroactive() || undefined,
        // Absent tant que le groupe n'a pas été modifié : le serveur n'y touche pas (C7/C34/C48).
        ...this.champGroupe(),
      }));
      this.toast.success('Réservation modifiée', 'Les changements sont enregistrés.');
      this.created.emit();
      this.closed.emit();
    } catch (e) {
      swallow('reservation-sheet:saveEdit', e);
      this.reqError.set(this.errMsg(e));
    } finally {
      this.submitting.set(false);
    }
  }

  /** #4 — Annuler une réservation validée depuis le mode édition. */
  protected async cancelResa(): Promise<void> {
    const edit = this.editReservation();
    if (!edit) return;
    this.submitting.set(true);
    try {
      await firstValueFrom(this.api.cancelReservation(edit.id));
      this.toast.success('Réservation annulée', '');
      this.created.emit();
      this.closed.emit();
    } catch (e) {
      swallow('reservation-sheet:cancelResa', e);
      this.reqError.set(this.errMsg(e));
    } finally {
      this.submitting.set(false);
    }
  }

  private async loadQueue(): Promise<void> {
    this.queueLoading.set(true);
    try {
      // Le filtre société du bandeau (SUPER_ADMIN) : sans lui, la file mélangeait les demandes de
      // toutes les sociétés — « Demander » le portait déjà, « À valider » l'avait oublié (28/09).
      this.pending.set(
        await firstValueFrom(
          this.api.listReservations({ status: 'REQUESTED', fleetId: this.societeBandeau() ?? undefined }),
        ),
      );
    } catch (err) {
      swallow('reservation-sheet:loadQueue', err);
      this.pending.set([]);
    } finally {
      this.queueLoading.set(false);
    }
  }

  protected async confirm(r: VehicleEventDto): Promise<void> {
    this.busyId.set(r.id);
    try {
      await firstValueFrom(this.api.confirmReservation(r.id));
      this.pending.update((l) => l.filter((x) => x.id !== r.id));
      this.toast.success('Réservation validée', r.vehiclePlate ?? '');
      this.created.emit();
    } catch (e) {
      swallow('reservation-sheet:confirm', e);
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.busyId.set(null);
    }
  }

  protected async reject(r: VehicleEventDto): Promise<void> {
    this.busyId.set(r.id);
    try {
      await firstValueFrom(this.api.cancelReservation(r.id));
      this.pending.update((l) => l.filter((x) => x.id !== r.id));
      this.toast.success('Demande refusée', r.vehiclePlate ?? '');
      this.created.emit();
    } catch (e) {
      swallow('reservation-sheet:reject', e);
      this.toast.error('Échec', this.errMsg(e));
    } finally {
      this.busyId.set(null);
    }
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse && e.status === 503) {
      return apiErrorMessage(e, 'Copilote IA non configuré côté serveur (ANTHROPIC_API_KEY).');
    }
    return apiErrorMessage(e, e instanceof HttpErrorResponse ? `Erreur (${e.status}).` : 'Une erreur est survenue.');
  }
}
