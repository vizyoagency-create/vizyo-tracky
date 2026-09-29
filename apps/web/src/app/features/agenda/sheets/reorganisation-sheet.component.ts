import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { DatePipe } from '@angular/common';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { Subscription } from 'rxjs';
import { AlertTriangle, ArrowRightLeft, Check, Loader, LucideAngularModule, Shuffle, X } from 'lucide-angular';
import type {
  EcarterPropositionsDto,
  EcartPropositionsResultDto,
  OrigineReservation,
  ReorganisationResultDto,
  ReorganiserReservationsDto,
  ReservationsReorganisablesDto,
} from '@vizyo/tracky-shared';
import { apiErrorMessage } from '../../../core/error/api-error';
import { swallow } from '../../../core/error/swallow';
import { QUIET_ERRORS_HEADER } from '../../../core/interceptors/auth.interceptor';
import { AuthService } from '../../../core/services/auth.service';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { BottomSheetComponent } from '../../../shared/ui/bottom-sheet/bottom-sheet.component';
import { AgendaSyncService } from '../agenda-sync.service';
import {
  compteAgentMemorise,
  type CompteAgentMemorise,
  compteDeLaListe,
  horsFenetrePreset,
  libellePeriode,
  lotExactDeSimulation,
  memoriserCompteAgent,
  ongletPropositionsVisible,
  origineAgentVisible,
  type QuoiReorganiser,
  quoiALOuverture,
  raisonsVideRefusees,
  rienAReorganiser,
} from '../agenda.utils';

/** Fenêtres proposées — celles qu'on veut réellement reprendre, pas un sélecteur de dates. */
const FENETRES = [
  { cle: '7', libelle: '7 jours', jours: 7 },
  { cle: '14', libelle: '14 jours', jours: 14 },
  { cle: '30', libelle: '30 jours', jours: 30 },
] as const;

const URL_REORGANISER = '/api/reservations/reorganiser';
/** 29/09 (piste 3) — simuler / écarter un lot de propositions de l'agent. */
const URL_ECARTER_PROPOSITIONS = '/api/agenda/agent/proposals/ecarter';

/** Durée examinée quand le pré-réglage a un début mais pas de fin (immobilisation sans date de fin). */
const JOURS_SANS_FIN = 30;

export type ActionReorganisation = 'reaffecter' | 'annuler' | 'decaler';

/** Véhicule proposé comme destination d'une réaffectation. */
export interface VehiculeReorganisation {
  id: string;
  plate: string | null;
  /**
   * Société du véhicule (revue du 29/09) : une réservation ne change pas de société — les
   * destinations proposées sont celles de la société du véhicule qu'on libère.
   */
  fleetId?: string;
}

/**
 * Pré-réglage de la feuille quand on l'ouvre DEPUIS un geste (ex. après avoir posé une
 * immobilisation) : le véhicule, la fenêtre, l'action. Sans, la feuille s'ouvre sur ses défauts.
 */
export interface PresetReorganisation {
  vehicleId?: string | null;
  from?: string | null;
  to?: string | null;
  action?: ActionReorganisation | null;
  /**
   * Réservations que le geste d'origine n'a PAS pu reprendre, avec le motif RENDU PAR LE SERVEUR
   * (contre-revue du 29/09). Ce sont de vrais refus — rien d'autre : la feuille ne devine plus ce
   * que la réorganisation « ne reprendrait pas ». Réaffecter scinde désormais une réservation en
   * cours (la partie d'avant reste, la suite part) ; l'ancienne liste « hors de portée — à annuler
   * une par une » annonçait non reprise une réservation que la simulation comptait dans son lot.
   */
  nonReprises?: { id?: string | null; plate: string | null; startAt: string; endAt: string | null; motif: string }[];
  /**
   * 29/09 (piste 3) — l'onglet d'ouverture. `propositions` : ouverte après une immobilisation qui
   * tombe sur des propositions de l'agent (le véhicule part au garage, ses trajets proposés n'ont
   * plus lieu d'être). Absent : décidé par `quoiALOuverture`.
   */
  quoi?: QuoiReorganiser | null;
  /**
   * Troisième passe (T3) — liste BLANCHE : les ids des réservations refusées que la feuille doit
   * reprendre, et elles SEULES. Présente, elle part dans le corps (simulation ET application ; le
   * serveur filtre avant plafond, aperçu et `attendu`) et la feuille le dit. Sans elle, la feuille
   * ouverte sur toute la période d'immobilisation reprenait aussi les réservations que le
   * gestionnaire avait choisi de « Laisser ». Seul un bouton explicite l'élargit à toute la période.
   */
  ids?: string[];
}

type NonReprise = NonNullable<PresetReorganisation['nonReprises']>[number];
type LigneApercu = ReorganisationResultDto['apercu'][number];

/**
 * Fenêtre imposée par un pré-réglage. `sansFin` : le geste d'origine n'avait pas de fin (une
 * immobilisation sans date de fin) — la fenêtre vaut alors JOURS_SANS_FIN jours à partir du début.
 */
interface FenetreImposee {
  from: string;
  to: string;
  sansFin: boolean;
}

/** Ce qui part au serveur — construit AU MOMENT de la simulation, jamais dans un computed. */
interface CorpsReorganisation {
  from: string;
  to: string;
  origine: OrigineReservation;
  action: ActionReorganisation;
  decalageMinutes?: number;
  versVehicleId?: string;
  vehicleId?: string;
  fleetId?: string;
  /** Liste blanche (T3) : seulement ces réservations — renvoyée à l'identique à l'application. */
  ids?: string[];
}

/** 29/09 (piste 3) — ce qui part au serveur pour les propositions : la fenêtre et le véhicule, rien d'autre. */
interface CorpsPropositions {
  from: string;
  to: string;
  vehicleId?: string;
  fleetId?: string;
}

/** La lecture courante des propositions (simulation, ou compte-rendu d'un « Écarter »). */
interface LecturePropositions {
  corps: CorpsPropositions;
  fenetre: string;
  /** Faux après application : le compte-rendu ne se réapplique pas. */
  applicable: boolean;
  r: EcartPropositionsResultDto;
}

/** Une lecture COURANTE : le corps envoyé, la fenêtre qu'il couvre, et la réponse du serveur. */
interface Lecture {
  corps: CorpsReorganisation;
  /** La fenêtre RÉELLEMENT envoyée, en toutes lettres — celle que citent les textes du vide. */
  fenetre: string;
  /** Faux pour un comptage seul (Réaffecter sans véhicule) ou après application : rien à appliquer. */
  applicable: boolean;
  r: ReorganisationResultDto;
}

/**
 * ── RÉORGANISER (lot 3c du 23/09, refondu le 28/09 — point 4 de la commande) ─────────────────
 *
 * ┌─ POURQUOI CET ÉCRAN EXISTE ───────────────────────────────────────────────┐
 * │ Reprendre d'un coup les réservations À VENIR : un véhicule part au garage │
 * │ (→ réaffecter les siennes), une journée tombe (→ annuler), les horaires   │
 * │ glissent (→ décaler). Une par une, par la feuille d'édition, n'est pas    │
 * │ tenable — 108 réservations sur 21 véhicules chez cdef31 le 23/09.         │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * **La feuille ouvre sur une SIMULATION, toujours.** On montre combien de réservations sont
 * concernées, lesquelles, et seulement ensuite on propose d'appliquer.
 *
 * Refonte du 28/09 : la feuille s'ouvrait sur « Aucune réservation ne correspond » — sa cible par
 * défaut, « posées par l'agent », est structurellement vide depuis que l'agent ne réserve plus
 * fermement. Maintenant : les trois cas sont nommés, chaque choix porte son COMPTE, un véhicule se
 * cible, le vide s'explique, et le geste qui manquait — réaffecter — existe.
 *
 * Revue du 29/09 — ce que la feuille GARANTIT désormais (elle le promettait sans le tenir) :
 *  - on n'applique QUE la simulation affichée : le corps simulé est gardé tel quel et renvoyé à
 *    l'identique ; le bouton est éteint pendant qu'une simulation court ; une réponse périmée
 *    (critère changé entre-temps, feuille refermée) est ignorée. Avant : passer d'un véhicule
 *    (3 réservations) à « Tous » laissait « Annuler ces 3 » actif… sur tout le parc ;
 *  - … et le serveur n'écrit que si le lot qu'il RECALCULE a encore le nombre affiché (`attendu`,
 *    contre-revue du 29/09) : même corps ne voulait pas dire même lot — deux demandes du lien
 *    public arrivées pendant que la feuille restait ouverte étaient annulées (et leur courriel de
 *    refus envoyé) sans avoir jamais été montrées. Sur un 409 « la liste a changé », rien n'est
 *    écrit : la feuille relance la simulation et le dit. Quatrième revue (C0) : le nombre seul
 *    laissait passer une réservation partie compensée par une arrivée — l'application renvoie donc
 *    aussi le lot EXACT de la simulation (`lotIds` → `ids`, liste blanche) : une arrivée n'entre
 *    jamais dans le lot, une sortie fait tomber `attendu` ;
 *  - « maintenant » est relu à chaque simulation (il était figé dans un computed : la fenêtre
 *    « 7 jours » rétrécissait tant que l'agenda restait ouvert) ;
 *  - une fenêtre imposée (période d'immobilisation) se voit et se quitte : les 7/14/30 jours ne
 *    font plus semblant de s'appliquer, et les textes citent la fenêtre réellement envoyée — y
 *    compris sans date de fin (« à partir du …, 30 jours »), qui était abandonnée en silence ;
 *  - Réaffecter demande un véhicule, et TOUT le parc se choisit dans la liste — même un véhicule
 *    dont la seule réservation est déjà commencée (il tombe en panne en pleine location) ; un
 *    super-admin choisit d'abord une société ;
 *  - seuls les VRAIS refus (motif du serveur) sont listés : Réaffecter scinde une réservation en
 *    cours à la coupe, max(début de la fenêtre, maintenant) — rien n'est plus « hors de portée ».
 *
 * Troisième passe du 29/09 :
 *  - ouverte après un refus, la feuille ne reprend QUE les réservations refusées (`ids`, liste
 *    blanche) et le dit ; « Élargir à toute la période » est un geste explicite (T3) ;
 *  - une demande en attente (REQUESTED) n'est jamais annoncée « scindée » : elle se valide ou se
 *    refuse. Celles que le serveur refusera d'office sont rangées dans les refus avec leur motif, et
 *    le bilan comme le bouton ne comptent que ce qui partira (T4) — `attendu` reste le lot entier.
 *
 * Quatrième revue du 29/09 : lot limité aux refusées puis durée changée, le vide cite « hors de la
 * fenêtre choisie » et propose de revenir à la période de l'immobilisation (C7) ; sous cette limite,
 * les boutons d'origine et la plaque du lot ne portent plus de nombres qui comptaient tout le véhicule (D1).
 *
 * 29/09 (piste 3 du propriétaire) — LES PROPOSITIONS DE L'AGENT. L'agenda de cdef31 n'a que des
 * propositions (307, aucune réservation à venir) : un onglet « Réservations | Propositions de l'agent »
 * (IA active seulement) les reprend sur la même fenêtre et le même véhicule. Un seul geste : les
 * écarter — un véhicule part au garage, une journée tombe. Même discipline : simulation d'abord, et
 * l'on n'écarte que le lot affiché (ses identifiants). La feuille s'ouvre sur les propositions quand il
 * n'y a qu'elles, et la page l'ouvre sur elles après une immobilisation qui en recouvre.
 */
@Component({
  selector: 'app-reorganisation-sheet',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, LucideAngularModule, BottomSheetComponent],
  template: `
    <app-bottom-sheet [open]="open()" [ariaLabel]="titre()" (closed)="closed.emit()">
      <div class="ro">
        <div class="ro-head">
          <h3 class="ro-title"><lucide-icon [img]="ShuffleIcon" [size]="15"></lucide-icon> {{ titre() }}</h3>
          <button type="button" class="ro-x" (click)="closed.emit()" aria-label="Fermer"><lucide-icon [img]="XIcon" [size]="18"></lucide-icon></button>
        </div>

        <div class="ro-body">
          @if (ongletVisible()) {
            <!-- 29/09 (piste 3 du propriétaire) : Réorganiser reprend AUSSI les propositions de l'agent —
                 l'agenda de cdef31 n'a qu'elles. Chaque bouton porte son compte sur la fenêtre et le
                 véhicule choisis (dernière liste lue). IA coupée : pas d'onglet, rien de l'agent. -->
            <div class="ro-f">
              <span>Quoi</span>
              <div class="ro-seg">
                <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="quoiEffectif() === 'reservations'" [disabled]="envoi() || envoiP()"
                        (click)="choisirQuoi('reservations')">Réservations@if (compteOngletReservations() !== null) { <span class="ro-n">{{ compteOngletReservations() }}</span> }</button>
                <!-- Relecture du 29/09 : « Propositions de l'agent 307 » passait sur deux lignes à 390 px ;
                     sur téléphone le bouton dit « Propositions » (l'intro dit de qui). -->
                <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="quoiEffectif() === 'propositions'" [disabled]="envoi() || envoiP()"
                        [attr.aria-label]="'Propositions de l’agent' + (compteOngletPropositions() !== null ? ' : ' + compteOngletPropositions() : '')"
                        (click)="choisirQuoi('propositions')"><span class="ro-lg">Propositions de l'agent</span><span class="ro-sm">Propositions</span>@if (compteOngletPropositions() !== null) { <span class="ro-n">{{ compteOngletPropositions() }}</span> }</button>
              </div>
            </div>
          }
          @if (quoiEffectif() === 'reservations' && rien()) {
            <!-- 29/09 (piste 1 du propriétaire) : « Réorganiser est vide chez cdef31 et on n'y comprend
                 rien ». Quand aucune réservation ne chevauche les 30 prochains jours, la feuille le dit
                 EN TÊTE — ce qu'elle fait, pourquoi il n'y a rien, où sont les propositions de l'agent —
                 au lieu d'aligner des « (0) » au-dessus d'une dernière ligne. -->
            <div class="ro-rien" role="status">
              <p class="ro-rien-t"><lucide-icon [img]="CheckIcon" [size]="16"></lucide-icon> Rien à réorganiser</p>
              <p class="ro-rien-l">{{ texteRien() }}</p>
              <p class="ro-rien-s">
                Réorganiser reprend d'un coup des réservations déjà posées — un véhicule part au garage,
                une journée tombe, les horaires glissent. Il n'y en a aucune à reprendre pour l'instant.
              </p>
              @if (textePropositions(); as tp) {
                <!-- 29/09 (piste 3) : elles ne se traitaient que dans l'Assistant IA ; elles se reprennent d'ici. -->
                <p class="ro-rien-s"><strong>{{ tp }}</strong> : {{ suitePropositions() }}</p>
                <button type="button" class="ro-lien" (click)="choisirQuoi('propositions')">Voir les propositions de l'agent</button>
              } @else {
                <p class="ro-rien-s">Une réservation se pose avec « Réserver » : dès qu'il y en aura, elle se réorganisera d'ici.</p>
              }
            </div>
          } @else {
          @if (quoiEffectif() === 'propositions') {
            <p class="ro-intro">
              Écarter d'un coup les <strong>propositions de l'agent</strong> — les réservations qu'il suggère,
              en pointillé dans le calendrier. Un véhicule part au garage, une journée tombe : elles n'ont plus
              lieu d'être. Rien n'est écarté avant que vous ayez vu la liste.
            </p>
          } @else {
          <p class="ro-intro">
            Reprendre d'un coup les réservations <strong>à venir</strong>. Le passé n'est jamais touché,
            et rien n'est appliqué avant que vous ayez vu la liste.
          </p>
          <ul class="ro-cas">
            <li><strong>Un véhicule part au garage</strong> → ses réservations passent sur un autre : <em>Réaffecter</em>.</li>
            <li><strong>Une journée tombe</strong> (sortie annulée, fermeture) → <em>Annuler</em> le lot.</li>
            <li><strong>Les horaires glissent</strong> → <em>Décaler</em> le lot de quelques minutes ou heures.</li>
          </ul>
          }

          @if (needsFleet()) {
            <!-- Super-admin sur « Toutes les sociétés » : un lot mêlerait les réservations de plusieurs
                 clients, et « Vers quel véhicule » proposerait les plaques de tout le monde (revue du 29/09). -->
            <p class="ro-note">
              <lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon>
              <span>Choisissez une société dans le bandeau en haut de page : on réorganise le parc d'une société à la fois.</span>
            </p>
          } @else {
            <!-- Critères figés pendant l'application : la réponse doit décrire le lot qu'on vient d'écrire.
                 « Quand » et le véhicule choisi sont COMMUNS aux deux onglets : un véhicule part au garage,
                 on voit ses réservations puis ses propositions sur la même période. -->
            <fieldset class="ro-criteres" [disabled]="envoi() || envoiP()">
              <div class="ro-f">
                <span>Quand</span>
                @if (fenetrePreset()) {
                  <!-- La période imposée par le geste d'origine est un choix VISIBLE, et on peut y revenir.
                       Sans date de fin, elle se dit « à partir du …, 30 jours » au lieu de disparaître. -->
                  <div class="ro-seg">
                    <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="fenetreFixeActive()"
                            (click)="fenetreFixeActive.set(true)">Période de l'immobilisation : {{ periodePreset() }}</button>
                  </div>
                }
                <div class="ro-seg">
                  @for (f of fenetres; track f.cle) {
                    <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="!fenetreFixeActive() && fenetre() === f.jours"
                            (click)="choisirDuree(f.jours)">{{ f.libelle }}</button>
                  }
                </div>
              </div>

              @if (quoiEffectif() === 'propositions') {
                <div class="ro-f">
                  <span>Véhicule</span>
                  <!-- Seuls les véhicules qui ont des propositions sur la fenêtre (dernière liste lue) ; le
                       véhicule choisi reste toujours dans la liste, même à 0. -->
                  <select class="ro-in" [value]="vehicleId()" (change)="choisirVehicule($any($event.target).value)" aria-label="Véhicule concerné">
                    <option value="" [selected]="vehicleId() === ''">Tous les véhicules@if (totalP() !== null) { ({{ totalP() }}) }</option>
                    @for (v of optionsVehiculeP(); track v.vehicleId) {
                      <option [value]="v.vehicleId" [selected]="v.vehicleId === vehicleId()">{{ v.plate || '—' }} ({{ v.n }})</option>
                    }
                    @if (vehicleId() && !vehiculeDansListeP()) {
                      <option [value]="vehicleId()" selected>{{ plaqueDe(vehicleId()) }}@if (totalP() !== null) { (0) }</option>
                    }
                  </select>
                  @if (texteListeVehiculesP(); as tl) {
                    <span class="ro-detail">{{ tl }}</span>
                  }
                </div>
              } @else {
              <div class="ro-f">
                <span>Véhicule</span>
                <!-- 29/09 (piste 2 du propriétaire) : seuls les véhicules qui ONT des réservations sur la
                     fenêtre (optionsVehicule) — plus 30 lignes à « (0) ». Le véhicule qui tombe en panne
                     en pleine réservation y est, par sa réservation en cours (le compte porte sur ce qui
                     chevauche la fenêtre) ; le véhicule choisi reste toujours dans la liste. -->
                <select class="ro-in" [value]="vehicleId()" (change)="choisirVehicule($any($event.target).value)" aria-label="Véhicule concerné">
                  <option value="" [selected]="vehicleId() === ''">Tous les véhicules@if (listeConnue()) { ({{ totalOrigine() }}) }</option>
                  @for (v of optionsVehicule(); track v.vehicleId) {
                    <!-- D1 (29/09) : pas de « (n) » sur le véhicule d'un lot limité aux refusées — il compterait
                         tout le véhicule. Les autres gardent le leur : les choisir lève la limite. -->
                    <option [value]="v.vehicleId" [selected]="v.vehicleId === vehicleId()">{{ v.plate || '—' }}@if (compteVehiculeVisible(v.vehicleId)) { ({{ v.n }}) }</option>
                  }
                  @if (vehicleId() && !vehiculeDansListe()) {
                    <option [value]="vehicleId()" selected>{{ plaqueDe(vehicleId()) }}@if (compteVehiculeVisible(vehicleId())) { (0) }</option>
                  }
                </select>
                @if (texteListeVehicules(); as tl) {
                  <span class="ro-detail">{{ tl }}</span>
                }
              </div>

              <div class="ro-f">
                <span>Quelles réservations</span>
                @if (idsPreset().length > 0) {
                  <!-- T3 : ouverte après un refus, la feuille ne reprend QUE les refusées (liste blanche
                       envoyée au serveur) — pas celles laissées sur le véhicule, ni celles arrivées
                       depuis. Élargir est un geste explicite, et réversible. -->
                  <div class="ro-limite" [class.ro-limite--off]="!limiteActive()">
                    @if (limiteActive()) {
                      <span>
                        <strong>{{ idsPreset().length }} réservation{{ idsPreset().length > 1 ? 's' : '' }} refusée{{ idsPreset().length > 1 ? 's' : '' }} à reprendre</strong>
                        — {{ idsPreset().length > 1 ? 'elles seules' : 'elle seule' }} : les réservations laissées{{ vehiculePreset() ? ' sur ' + plaqueDe(vehiculePreset()) : '' }} à la création, et celles arrivées depuis, ne sont pas touchées.
                      </span>
                      <button type="button" class="ro-lien" (click)="elargir()">Élargir à toute la période</button>
                    } @else {
                      <span>
                        <strong>Toute la période</strong> — y compris les réservations laissées sur le véhicule à la création : relisez la liste avant d'appliquer.
                      </span>
                      <button type="button" class="ro-lien" (click)="revenirAuxRefus()">Ne reprendre que {{ idsPreset().length > 1 ? 'les ' + idsPreset().length + ' réservations refusées' : 'la réservation refusée' }}</button>
                    }
                  </div>
                }
                <!-- Comptes du véhicule choisi quand il y en a un : un compte de TOUT le parc sous un
                     filtre véhicule annonçait des réservations que le clic ne donnait pas.
                     Quatrième revue du 29/09 (D1) : lot limité aux refusées, les nombres des boutons
                     (« Toutes 3 ») comptaient tout le véhicule, pas le lot — ils se taisent ; le lot est dit
                     par le bandeau, le bilan et le bouton. La ligne de détail reste, et dit son périmètre. -->
                <!-- 29/09 (IA désactivée) : IA coupée, « Posées par l'agent » ne reste que s'il filtre de
                     VRAIES réservations (compte > 0) ou s'il est le filtre actif ; à 0, lui et le « · 0 de
                     l'agent » du détail disparaissent (boutonAgentVisible). La mention « agent » des lignes
                     de l'aperçu reste : c'est l'histoire de la réservation. Revue du 29/09 : le compte
                     qui en décide est celui de la SOCIÉTÉ, mémorisé — le bouton ne surgit plus au retour
                     de chaque première simulation, et ne disparaît plus sur une erreur. -->
                <div class="ro-seg">
                  <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="origine() === 'toutes'"
                          (click)="origine.set('toutes')">Toutes@if (comptesBoutons(); as c) { <span class="ro-n">{{ c.agent + c.public + c.manuelle }}</span> }</button>
                  @if (boutonAgentVisible()) {
                    <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="origine() === 'auto'"
                            (click)="origine.set('auto')">Posées par l'agent@if (comptesBoutons(); as c) { <span class="ro-n">{{ c.agent }}</span> }</button>
                  }
                </div>
                @if (comptes(); as c) {
                  <span class="ro-detail">{{ plaqueLue() ? 'Sur ' + plaqueLue() : 'Sur la fenêtre' }}{{ lotLimite() ? ', toute la période (pas seulement les refusées)' : '' }} : {{ c.manuelle }} saisie{{ c.manuelle > 1 ? 's' : '' }} à la main · {{ c.public }} du lien public@if (boutonAgentVisible()) { · {{ c.agent }} de l'agent}.</span>
                }
                <!-- 29/09 : l'avertissement ne parle que d'une liste qui contient quelque chose. -->
                @if (origine() === 'toutes' && lotNonVide()) {
                  <span class="ro-avert">
                    <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
                    Inclut les réservations saisies par des personnes : relisez la liste avant d'appliquer.
                  </span>
                }
              </div>

              <div class="ro-f">
                <span>Que faire</span>
                <div class="ro-seg">
                  <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="action() === 'reaffecter'" [disabled]="!vehicleId()"
                          (click)="action.set('reaffecter')"><lucide-icon [img]="SwapIcon" [size]="13"></lucide-icon> Réaffecter</button>
                  <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="action() === 'annuler'"
                          (click)="action.set('annuler')">Annuler</button>
                  <button type="button" class="ro-seg-btn" [class.ro-seg-btn--on]="action() === 'decaler'"
                          (click)="action.set('decaler')">Décaler</button>
                </div>
                <!-- 29/09 : seulement s'il y a un véhicule à choisir — sans réservation, rien à réaffecter. -->
                @if (!vehicleId() && action() !== 'reaffecter' && optionsVehicule().length > 0) {
                  <span class="ro-detail">Réaffecter demande un véhicule : choisissez d'abord celui qui part au garage.</span>
                }
              </div>

              @if (action() === 'reaffecter' && vehicleId()) {
                <label class="ro-f">
                  <span>Vers quel véhicule</span>
                  <select class="ro-in" [value]="versVehicleId()" (change)="versVehicleId.set($any($event.target).value)">
                    <option value="auto" [selected]="versVehicleId() === 'auto'">Auto — le premier véhicule libre et conforme à chaque réservation</option>
                    @for (v of destinations(); track v.id) {
                      <option [value]="v.id" [selected]="v.id === versVehicleId()">{{ v.plate || '—' }}</option>
                    }
                  </select>
                  <span class="ro-detail">
                    @if (versVehicleId() === 'auto') {
                      Chaque réservation prend le premier véhicule libre sur son créneau qui respecte ses critères (places, sièges auto, équipements) — jamais celui d'origine. Le groupe de la réservation ne change pas.
                    } @else {
                      Toutes passent sur {{ plaqueDe(versVehicleId()) }} — refusée ligne par ligne s'il est déjà pris, hors service, ou sans les sièges demandés.
                    }
                    Une réservation déjà commencée au début de la fenêtre est scindée : la partie d'avant reste sur {{ plaqueDe(vehicleId()) }}, la suite part.
                    Une demande pas encore validée ne se scinde pas : elle se valide ou se refuse.
                  </span>
                </label>
              }

              @if (action() === 'decaler') {
                <label class="ro-f">
                  <span>De combien (minutes, négatif pour avancer)</span>
                  <input type="number" step="15" class="ro-in" inputmode="numeric"
                         [value]="decalage()" (input)="decalage.set(+$any($event.target).value || 0)">
                </label>
              }
              }
            </fieldset>

            @if (quoiEffectif() === 'propositions') {
              <!-- 29/09 (piste 3) : la simulation des propositions — même discipline que les réservations :
                   on voit le lot, on écarte CE lot (ses identifiants repartent au serveur), rien d'autre. -->
              @if (chargementP()) {
                <div class="ro-sk"></div>
              } @else if (erreurP(); as e) {
                <p class="ro-err"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ e }}</p>
              } @else if (lueP(); as l) {
                @if (l.r.simulation && l.r.concernees === 0) {
                  <div class="ro-vide">
                    @if (l.r.vehiculeNonGere) {
                      <!-- Relecture du 29/09 : un véhicule choisi dont on ne gère pas les réservations — un lot
                           vide qui dit pourquoi, plus un 403 (et son toast rouge) pendant qu'on regardait l'autre onglet. -->
                      <p><strong>Vous ne gérez pas les réservations de {{ plaqueDe(l.corps.vehicleId ?? '') }}</strong> :
                        {{ l.r.horsGestion > 1 ? 'ses ' + l.r.horsGestion + ' propositions ' + l.fenetre + ' ne se retirent pas' : (l.r.horsGestion === 1 ? 'sa proposition ' + l.fenetre + ' ne se retire pas' : 'ses propositions ne se retirent pas') }} d'ici.</p>
                    } @else {
                      <p><strong>Aucune proposition de l'agent{{ surPlaqueP(l) }}</strong> {{ l.fenetre }} : rien à écarter.</p>
                      @if (l.r.horsGestion > 0) {
                        <p>{{ horsGestionTexte(l.r.horsGestion, false) }}</p>
                      }
                    }
                    @if (l.corps.vehicleId && (totalP() ?? 0) > 0) {
                      <button type="button" class="ro-lien" (click)="choisirVehicule('')">Voir tous les véhicules ({{ totalP() }})</button>
                    } @else if (plusLoinP(l)) {
                      <button type="button" class="ro-lien" (click)="choisirDuree(30)">Voir sur 30 jours</button>
                    }
                  </div>
                } @else {
                  <div class="ro-bilan" [class.ro-bilan--fait]="!l.r.simulation">
                    <span class="ro-bilan-n">{{ l.r.simulation ? l.r.concernees : l.r.ecartees }}</span>
                    <span class="ro-bilan-l">
                      @if (l.r.simulation) {
                        proposition{{ l.r.concernees > 1 ? 's' : '' }} de l'agent {{ l.r.concernees > 1 ? 'seraient écartées' : 'serait écartée' }}{{ surPlaqueP(l) }} {{ l.fenetre }}
                      } @else {
                        proposition{{ l.r.ecartees > 1 ? 's' : '' }} écartée{{ l.r.ecartees > 1 ? 's' : '' }}{{ surPlaqueP(l) }}
                        @if (l.r.dejaTraitees > 0) {
                          · {{ dejaTraiteesTexte(l.r.dejaTraitees) }}
                        }
                        @if (l.r.restees > 0) {
                          · {{ resteesTexte(l.r.restees) }}
                        }
                      }
                    </span>
                  </div>

                  @if (l.r.plafonne) {
                    <p class="ro-avert ro-avert--bloc">
                      <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
                      Plus de 500 propositions : seules les 500 premières sont prises. Relancez ensuite.
                    </p>
                  }

                  @if (l.r.apercu.length > 0) {
                    <ul class="ro-apercu">
                      @for (a of l.r.apercu; track a.id) {
                        <li>
                          <span class="ro-plate">{{ a.plate || '—' }}</span>
                          <span class="ro-when">{{ a.startAt | date:'EEE d MMM · HH:mm' }}–{{ a.endAt | date:'HH:mm' }}</span>
                          @if (a.destinationLabel) { <span class="ro-dest">{{ a.destinationLabel }}</span> }
                        </li>
                      }
                      @if (l.r.concernees > l.r.apercu.length) {
                        <li class="ro-reste">… et {{ l.r.concernees - l.r.apercu.length }} autre{{ l.r.concernees - l.r.apercu.length > 1 ? 's' : '' }}</li>
                      }
                    </ul>
                  }

                  @if (l.r.horsGestion > 0) {
                    <span class="ro-detail">{{ horsGestionTexte(l.r.horsGestion, true) }}</span>
                  }
                  @if (l.r.simulation) {
                    @if (lotIaEnCours()) {
                      <!-- Relecture du 29/09 : un « Tout réserver / Tout écarter » de l'Assistant IA tourne sur
                           la société — deux intentions contraires ne partent pas en même temps. -->
                      <p class="ro-avert ro-avert--bloc">
                        <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
                        Un lot « Tout réserver / Tout écarter » tourne dans l'Assistant IA : attendez son bilan avant d'écarter.
                      </p>
                    }
                    <span class="ro-detail">
                      Une proposition écartée ne revient pas : l'agent ne repropose pas un trajet qui chevauche une
                      proposition déjà traitée du même véhicule. Elle n'immobilisait aucun véhicule, et personne n'est prévenu.
                    </span>
                    <button type="button" class="ro-lien" (click)="ouvrirIa.emit()">Les revoir une par une dans l'Assistant IA</button>
                  }
                }
              }
            } @else {
            @if (nonReprises().length > 0) {
              <!-- Les VRAIS refus du geste d'origine, avec le motif du serveur (contre-revue du 29/09).
                   Plus de « hors de portée » deviné ici : Réaffecter scinde une réservation en cours,
                   et la simulation ci-dessous dit elle-même ce qu'elle reprend. -->
              <div class="ro-refus">
                <span class="ro-refus-t"><lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon> {{ nonReprises().length }} réservation{{ nonReprises().length > 1 ? 's' : '' }} refusée{{ nonReprises().length > 1 ? 's' : '' }}</span>
                @for (n of nonReprises(); track $index) {
                  <span class="ro-refus-l">{{ n.plate || '—' }} · {{ n.startAt | date:'EEE d MMM HH:mm' }}@if (n.endAt) { → {{ n.endAt | date:'EEE d MMM HH:mm' }} } — {{ n.motif }}</span>
                }
                <span class="ro-refus-n">
                  Le geste précédent n'a pas pu {{ nonReprises().length > 1 ? 'les' : 'la' }} reprendre (motif du serveur) :
                  {{ nonReprises().length > 1 ? 'elles sont restées telles quelles' : 'elle est restée telle quelle' }}.
                </span>
              </div>
            }

            @if (avis(); as a) {
              <!-- Le lot a changé entre la simulation et le clic : rien n'est écrit, on le DIT. -->
              <p class="ro-avert ro-avert--bloc">
                <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
                <span>{{ a }}</span>
              </p>
            }

            @if (reaffecterSansVehicule()) {
              <div class="ro-vide">
                <p><strong>Choisissez d'abord le véhicule qui part au garage</strong>, dans la liste « Véhicule » : ses réservations passeront sur un autre. Réaffecter tout le parc d'un coup n'est pas proposé.</p>
              </div>
            } @else if (chargement()) {
              <div class="ro-sk"></div>
            } @else if (erreur(); as e) {
              <p class="ro-err"><lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> {{ e }}</p>
            } @else if (lue(); as l) {
              @if (l.r.concernees === 0) {
                <!-- Le vide s'écrit avec la fenêtre, l'origine et le véhicule de la simulation lue. -->
                <div class="ro-vide">
                  @if (l.corps.ids; as ids) {
                    <!-- T3 : le lot était limité aux refusées — dire « rien à venir » parlerait de tout le véhicule. -->
                    <p><strong>Rien à {{ infinitif(l.corps.action) }} parmi {{ ids.length > 1 ? 'les ' + ids.length + ' réservations refusées' : 'la réservation refusée' }}</strong>{{ surPlaque() }} {{ l.fenetre }} :
                      {{ videRefusees(l.corps) }}</p>
                    @if (peutRevenirALaPeriode(l.corps)) {
                      <!-- C7 (quatrième revue du 29/09) : une durée cliquée a sorti la réservation refusée de la
                           fenêtre. Revenir remet ensemble le véhicule, la période, la limite aux refusées et
                           « Toutes ». C13 (cinquième revue) : proposé seulement si la fenêtre lue écarte
                           vraiment une refusée que la période prenait — décidé sur leurs dates. -->
                      <button type="button" class="ro-lien" (click)="revenirAuxRefus()">Revenir à la période de l'immobilisation</button>
                    }
                    @if (l.corps.origine === 'auto') {
                      <button type="button" class="ro-lien" (click)="origine.set('toutes')">Prendre toutes les réservations</button>
                    }
                    <button type="button" class="ro-lien" (click)="elargir()">Élargir à toute la période</button>
                  } @else if (l.corps.origine === 'auto' && autresQueAgent() !== 0) {
                    <!-- 29/09 : « il propose, vous validez » n'est vrai que si l'IA est active — coupée, l'agenda
                         ne montre plus ses propositions. -->
                    <p><strong>Aucune réservation posée par l'agent</strong>{{ surPlaque() }} {{ l.fenetre }}@if (iaActive()) { — l'agent ne réserve plus fermement depuis le 23/09 : il propose, vous validez}.</p>
                    @if (autresQueAgent(); as n) {
                      <p>{{ plaqueLue() ? 'Sur ' + plaqueLue() + ', il y a' : 'Il y a' }} {{ n }} réservation{{ n > 1 ? 's' : '' }} saisie{{ n > 1 ? 's' : '' }} à la main ou venue{{ n > 1 ? 's' : '' }} du lien public.</p>
                    }
                    <button type="button" class="ro-lien" (click)="origine.set('toutes')">Prendre toutes les réservations</button>
                  } @else if (avantFenetre(); as k) {
                    <!-- La liste « Véhicule » compte ce qui CHEVAUCHE la fenêtre ; annuler et décaler ne
                         prennent que ce qui COMMENCE dedans. Sans ce texte : « AB-123 (1) » dans la
                         liste, et « Rien à venir sur AB-123 » juste dessous. -->
                    <p><strong>Rien à {{ l.corps.action === 'decaler' ? 'décaler' : 'annuler' }}{{ surPlaque() }}</strong> {{ l.fenetre }} :
                      {{ k }} réservation{{ k > 1 ? 's débordent' : ' déborde' }} sur la fenêtre mais commence{{ k > 1 ? 'nt' : '' }} avant — Annuler et Décaler ne prennent que ce qui commence dedans.
                      Réaffecter {{ k > 1 ? 'les reprend' : 'la reprend' }} à partir du début de la fenêtre ; la partie d'avant reste{{ plaqueLue() ? surPlaque() : ' sur son véhicule' }}.</p>
                    @if (plaqueLue()) {
                      <button type="button" class="ro-lien" (click)="action.set('reaffecter')">Réaffecter plutôt</button>
                    } @else if (optionsVehicule().length === 1) {
                      <!-- Réaffecter demande UN véhicule : quand un seul en porte, le bouton le choisit. -->
                      <button type="button" class="ro-lien" (click)="reaffecterDepuis(optionsVehicule()[0].vehicleId)">Réaffecter celle{{ k > 1 ? 's' : '' }} de {{ optionsVehicule()[0].plate || 'ce véhicule' }}</button>
                    } @else {
                      <p>Pour réaffecter, choisissez d'abord le véhicule dans la liste « Véhicule ».</p>
                    }
                  } @else if (refusSurVehiculeLu()) {
                    <p><strong>Rien d'autre à reprendre</strong>{{ surPlaque() }} {{ l.fenetre }} : les réservations refusées ci-dessus restent sur leur véhicule, avec leur motif.</p>
                  } @else if (plaqueLue(); as p) {
                    <p><strong>Rien à venir sur {{ p }}</strong> {{ l.fenetre }} : aucune réservation à reprendre.</p>
                  } @else {
                    <p><strong>Aucune réservation à venir</strong> {{ l.fenetre }} : rien à réorganiser.</p>
                    <!-- 29/09 : une fenêtre courte vide ne dit rien des jours d'après — le compte des 30 jours, si. -->
                    @if (plusLoin(l); as n) {
                      <p>{{ n > 1 ? n + ' réservations' : 'Une réservation' }} plus loin, dans les 30 prochains jours.</p>
                      <button type="button" class="ro-lien" (click)="choisirDuree(30)">Voir sur 30 jours</button>
                    }
                  }
                </div>
              } @else {
                <div class="ro-bilan" [class.ro-bilan--fait]="!l.r.simulation">
                  <!-- T4 : en simulation, on compte ce qui PARTIRA — le lot moins les refus que le serveur
                       prévoit déjà (une demande en attente qui déborde sur la coupe). -->
                  <span class="ro-bilan-n">{{ l.r.simulation ? prevues(l.r) : l.r.appliquees }}</span>
                  <span class="ro-bilan-l">
                    @if (l.r.simulation) {
                      réservation{{ prevues(l.r) > 1 ? 's' : '' }} {{ prevues(l.r) > 1 ? 'seraient' : 'serait' }}
                      {{ verbe(prevues(l.r), l.corps.action) }} {{ l.fenetre }}
                      @if (l.r.refusees.length > 0) {
                        · {{ l.r.refusees.length }} ne le {{ l.r.refusees.length > 1 ? 'seraient' : 'serait' }} pas (motif plus bas)
                      }
                    } @else {
                      réservation{{ l.r.appliquees > 1 ? 's' : '' }} reprise{{ l.r.appliquees > 1 ? 's' : '' }}
                    }
                  </span>
                </div>

                @if (l.r.plafonne) {
                  <p class="ro-avert ro-avert--bloc">
                    <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
                    Plus de 500 réservations : seules les 500 premières sont reprises. Relancez ensuite.
                  </p>
                }

                @if (l.r.apercu.length > 0) {
                  <ul class="ro-apercu">
                    <!-- Par index : deux demandes en attente peuvent partager véhicule et début. -->
                    @for (a of l.r.apercu; track $index) {
                      <li>
                        <span class="ro-plate">{{ a.plate || '—' }}</span>
                        <span class="ro-when">{{ a.startAt | date:'EEE d MMM · HH:mm' }}</span>
                        @if (lignesRefusees().has($index)) {
                          <!-- Refus rendu par le serveur (prévu en simulation, constaté après) : elle ne part pas,
                               elle n'est donc pas « scindée » — le motif est dans le bloc des refus. -->
                          <span class="ro-tag ro-tag--refus" [title]="l.r.simulation ? 'Ne serait pas reprise : voir le motif plus bas.' : 'Non reprise : voir le motif plus bas.'">non reprise</span>
                        } @else if (scindee(a, l.corps)) {
                          <span class="ro-tag ro-tag--coupe" title="Commencée avant la fenêtre : la partie d'avant reste sur ce véhicule, la suite part.">scindée</span>
                        }
                        @if (a.origine === 'agent') { <span class="ro-tag">agent</span> }
                        @else if (a.origine === 'public') { <span class="ro-tag ro-tag--public">lien public</span> }
                      </li>
                    }
                    @if (l.r.concernees > l.r.apercu.length) {
                      <li class="ro-reste">… et {{ l.r.concernees - l.r.apercu.length }} autre{{ l.r.concernees - l.r.apercu.length > 1 ? 's' : '' }}</li>
                    }
                  </ul>
                }

                @if (l.r.refusees.length > 0) {
                  <!-- Aussi en SIMULATION (T4) : une demande en attente qui déborde sur la coupe est refusée
                       d'office par le serveur — elle se dit ici, avec son motif, avant le clic. -->
                  <div class="ro-refus">
                    <span class="ro-refus-t">
                      <lucide-icon [img]="AlertIcon" [size]="12"></lucide-icon>
                      @if (l.r.simulation) {
                        {{ l.r.refusees.length }} ne {{ l.r.refusees.length > 1 ? 'seraient' : 'serait' }} pas reprise{{ l.r.refusees.length > 1 ? 's' : '' }}
                      } @else {
                        {{ l.r.refusees.length }} non reprise{{ l.r.refusees.length > 1 ? 's' : '' }}
                      }
                    </span>
                    @for (ref of l.r.refusees.slice(0, 5); track $index) {
                      <span class="ro-refus-l">{{ ref.plate || '—' }} · {{ ref.startAt | date:'dd/MM HH:mm' }} — {{ ref.motif }}</span>
                    }
                    @if (l.r.refusees.length > 5) {
                      <span class="ro-refus-l">… et {{ l.r.refusees.length - 5 }} autre{{ l.r.refusees.length - 5 > 1 ? 's' : '' }}</span>
                    }
                    @if (l.r.simulation && prevues(l.r) === 0) {
                      <span class="ro-refus-n">Rien à appliquer : aucune réservation de la liste ne pourrait partir — le motif de chacune est ci-dessus.</span>
                    }
                  </div>
                }
              }
            }
            }
          }
          }
        </div>

        <div class="ro-foot">
          @if (quoiEffectif() === 'propositions') {
            @if (!needsFleet()) {
              @if (lueP(); as l) {
                @if (l.r.simulation && l.applicable && l.r.concernees > 0) {
                  <!-- Nomme ce qu'il fait et combien — le lot de la simulation LUE, renvoyé par ses identifiants. -->
                  <button type="button" class="ro-btn ro-btn--go" [disabled]="envoiP() || chargementP() || lotIaEnCours()"
                          [attr.title]="lotIaEnCours() ? 'Un lot tourne dans l’Assistant IA : attendez son bilan.' : null" (click)="ecarterPropositions()">
                    @if (envoiP() || chargementP()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="ro-spin"></lucide-icon> }
                    @if (chargementP()) {
                      Simulation en cours…
                    } @else {
                      Écarter {{ l.r.concernees > 1 ? 'ces ' + l.r.concernees + ' propositions' : 'cette proposition' }}
                    }
                  </button>
                } @else if (!l.r.simulation) {
                  <button type="button" class="ro-btn ro-btn--ok" (click)="closed.emit()">
                    <lucide-icon [img]="CheckIcon" [size]="15"></lucide-icon> Terminé
                  </button>
                }
              }
            }
          } @else if (rien()) {
            <button type="button" class="ro-btn ro-btn--ok" (click)="closed.emit()">Fermer</button>
          } @else if (!needsFleet() && !reaffecterSansVehicule()) {
            @if (lue(); as l) {
              @if (l.r.simulation && l.applicable && prevues(l.r) > 0) {
                <!-- Le bouton d'application NOMME ce qu'il fait et COMBIEN — ceux de la simulation LUE,
                     qu'il renverra à l'identique. Éteint tant qu'une nouvelle simulation court. Il compte
                     ce qui PARTIRA (T4) ; « attendu », lui, reste le lot entier que le serveur recalcule. -->
                <button type="button" class="ro-btn" [class.ro-btn--go]="l.corps.action === 'annuler'" [class.ro-btn--ok2]="l.corps.action !== 'annuler'"
                        [disabled]="envoi() || chargement()" (click)="appliquer()">
                  @if (envoi() || chargement()) { <lucide-icon [img]="LoaderIcon" [size]="15" class="ro-spin"></lucide-icon> }
                  @if (chargement()) {
                    Simulation en cours…
                  } @else {
                    {{ libelleAction(l.corps.action) }} {{ prevues(l.r) > 1 ? 'ces ' + prevues(l.r) + ' réservations' : 'cette réservation' }}
                  }
                </button>
              } @else if (!l.r.simulation) {
                <button type="button" class="ro-btn ro-btn--ok" (click)="closed.emit()">
                  <lucide-icon [img]="CheckIcon" [size]="15"></lucide-icon> Terminé
                </button>
              }
            }
          }
        </div>
      </div>
    </app-bottom-sheet>
  `,
  styles: [`
    .ro { display: flex; flex-direction: column; padding: 2px 2px 0; }
    .ro-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; border-bottom: 1px solid var(--border-subtle); }
    .ro-title { display: flex; align-items: center; gap: 7px; font-size: 15px; font-weight: 700; color: var(--fg-primary); font-family: var(--font-display, inherit); }
    .ro-x { width: 34px; height: 34px; border-radius: 9px; color: var(--fg-tertiary); display: inline-flex; align-items: center; justify-content: center; }
    .ro-body { display: flex; flex-direction: column; gap: 12px; overflow-y: auto; max-height: 62vh; max-height: 62dvh; padding: 12px 2px 2px; }
    .ro-intro { font-size: 13px; color: var(--fg-secondary); line-height: 1.5; margin: 0; }
    .ro-intro strong { color: var(--fg-primary); }
    .ro-cas { margin: 0; padding: 9px 11px; border-radius: 10px; background: var(--bg-tertiary); list-style: none; display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--fg-secondary); line-height: 1.45; }
    .ro-cas strong { color: var(--fg-primary); }
    .ro-cas em { font-style: normal; font-weight: 700; color: var(--texte-succes); }
    /* Un fieldset pour pouvoir figer TOUS les critères d'un coup pendant l'application — sans sa
       bordure ni sa largeur minimale (min-content), qui déborderait sur un téléphone. */
    .ro-criteres { border: 0; margin: 0; padding: 0; min-width: 0; min-inline-size: 0; display: flex; flex-direction: column; gap: 12px; }
    .ro-f { display: flex; flex-direction: column; gap: 5px; font-size: 11.5px; color: var(--fg-tertiary); }
    .ro-f > span:first-child { font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .ro-seg { display: flex; gap: 2px; padding: 3px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .ro-seg-btn { flex: 1; min-height: 40px; padding: 8px 6px; border-radius: 8px; font-size: 12.5px; font-weight: 600; color: var(--fg-tertiary); cursor: pointer; background: transparent; border: 0;
                  display: inline-flex; align-items: center; justify-content: center; gap: 5px; }
    .ro-seg-btn--on { background: var(--bg-primary); color: var(--texte-succes); box-shadow: 0 1px 2px rgba(0,0,0,.12); }
    .ro-seg-btn:disabled { opacity: .45; cursor: not-allowed; }
    .ro-n { font-size: 10.5px; font-weight: 800; padding: 0 6px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-secondary); }
    .ro-seg-btn--on .ro-n { background: color-mix(in srgb, var(--tracky-light) 16%, transparent); color: var(--texte-succes); }
    .ro-in { width: 100%; padding: 10px 11px; border-radius: 10px; background: var(--bg-secondary); border: 1px solid var(--border-strong); color: var(--fg-primary); font-size: 15px; text-transform: none; letter-spacing: 0; }
    .ro-in:disabled { opacity: .6; }
    .ro-detail { font-size: 11.5px; color: var(--fg-tertiary); text-transform: none; letter-spacing: 0; font-weight: 400; line-height: 1.4; }
    .ro-avert { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--texte-attente); text-transform: none; letter-spacing: 0; font-weight: 400; }
    .ro-avert--bloc { padding: 8px 10px; border-radius: 9px; background: color-mix(in srgb, var(--warning) 12%, transparent); }
    .ro-note { display: flex; align-items: flex-start; gap: 7px; margin: 0; padding: 11px 12px; border-radius: 11px; background: var(--bg-tertiary); font-size: 12.5px; color: var(--fg-secondary); line-height: 1.45; }
    .ro-bilan { display: flex; align-items: baseline; gap: 9px; padding: 13px 14px; border-radius: 12px;
                background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .ro-bilan--fait { border-color: color-mix(in srgb, var(--tracky-light) 45%, transparent); background: color-mix(in srgb, var(--tracky-light) 8%, transparent); }
    .ro-bilan-n { font-family: var(--font-display); font-size: 26px; font-weight: 800; line-height: 1; color: var(--fg-primary); font-variant-numeric: tabular-nums; }
    .ro-bilan-l { font-size: 12.5px; color: var(--fg-secondary); line-height: 1.4; }
    .ro-apercu { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .ro-apercu li { display: flex; align-items: baseline; gap: 8px; font-size: 12px; color: var(--fg-secondary); }
    .ro-plate { font-weight: 700; color: var(--fg-primary); font-family: var(--font-mono, monospace); }
    .ro-when { color: var(--fg-tertiary); text-transform: capitalize; }
    /* 29/09 (piste 3) : la destination d'une proposition — coupée plutôt que de pousser la ligne hors de l'écran. */
    .ro-dest { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--fg-tertiary); }
    /* Libellé long sur écran large, court sur téléphone (onglet « Propositions de l'agent »). */
    .ro-sm { display: none; }
    @media (max-width: 480px) { .ro-lg { display: none; } .ro-sm { display: inline; } }
    .ro-tag { font-size: 10px; font-weight: 700; padding: 1px 6px; border-radius: 999px; color: var(--texte-violet); border: 1px dashed color-mix(in srgb, var(--violet) 45%, transparent); }
    .ro-tag--public { color: var(--fg-secondary); border-style: solid; border-color: var(--border-strong); }
    .ro-tag--coupe { color: var(--texte-attente); border-style: solid; border-color: color-mix(in srgb, var(--warning) 45%, transparent); }
    .ro-tag--refus { color: var(--texte-alerte); border-style: solid; border-color: color-mix(in srgb, var(--danger) 45%, transparent); }
    /* T3 : le lot limité aux refusées se voit, et se quitte par un bouton — jamais en silence. */
    .ro-limite { display: flex; flex-direction: column; align-items: flex-start; gap: 3px; padding: 9px 11px; border-radius: 10px;
                 background: color-mix(in srgb, var(--tracky-light) 8%, transparent); border: 1px solid color-mix(in srgb, var(--tracky-light) 35%, transparent);
                 font-size: 12px; color: var(--fg-secondary); line-height: 1.45; text-transform: none; letter-spacing: 0; font-weight: 400; }
    .ro-limite strong { color: var(--fg-primary); }
    .ro-limite--off { background: color-mix(in srgb, var(--warning) 10%, transparent); border-color: color-mix(in srgb, var(--warning) 35%, transparent); }
    .ro-reste { color: var(--fg-tertiary); font-style: italic; }
    .ro-refus { display: flex; flex-direction: column; gap: 3px; padding: 10px 11px; border-radius: 10px;
                background: color-mix(in srgb, var(--danger) 9%, transparent); }
    .ro-refus-t { display: flex; align-items: center; gap: 5px; font-size: 12px; font-weight: 700; color: var(--texte-alerte); }
    .ro-refus-l { font-size: 11px; color: var(--fg-secondary); }
    .ro-refus-n { font-size: 11.5px; color: var(--fg-primary); line-height: 1.4; margin-top: 3px; }
    /* Le vide s'explique : ce qu'il y a, ce qu'il n'y a pas, et le geste pour sortir de là. */
    .ro-vide { display: flex; flex-direction: column; gap: 6px; padding: 12px 13px; border-radius: 12px; background: var(--bg-tertiary); font-size: 12.5px; color: var(--fg-secondary); line-height: 1.45; }
    /* 29/09 (piste 1) : rien à réorganiser — dit en tête, en clair, et rien d'autre à l'écran. */
    .ro-rien { display: flex; flex-direction: column; gap: 8px; padding: 16px 16px 14px; border-radius: 14px;
               background: color-mix(in srgb, var(--tracky-light) 7%, var(--bg-tertiary));
               border: 1px solid color-mix(in srgb, var(--tracky-light) 30%, transparent); }
    .ro-rien p { margin: 0; }
    .ro-rien-t { display: flex; align-items: center; gap: 7px; font-family: var(--font-display, inherit); font-size: 16px; font-weight: 800; color: var(--fg-primary); }
    .ro-rien-t lucide-icon { color: var(--texte-succes); }
    .ro-rien-l { font-size: 14px; font-weight: 600; color: var(--fg-primary); line-height: 1.45; }
    .ro-rien-s { font-size: 12.5px; color: var(--fg-secondary); line-height: 1.5; }
    .ro-rien-s strong { color: var(--fg-primary); }
    .ro-vide p { margin: 0; }
    .ro-vide strong { color: var(--fg-primary); }
    .ro-lien { align-self: flex-start; font-size: 12.5px; font-weight: 700; color: var(--texte-succes); text-decoration: underline; padding: 2px 0; }
    .ro-lien:disabled { opacity: .5; cursor: not-allowed; }
    .ro-err { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--texte-alerte); }
    .ro-sk { height: 74px; border-radius: 12px; background: var(--bg-tertiary); }
    .ro-foot { display: flex; gap: 8px; padding: 12px 0 max(6px, env(safe-area-inset-bottom)); border-top: 1px solid var(--border-subtle); }
    .ro-btn { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 7px;
              min-height: 44px; padding: 11px 16px; border-radius: 11px; font-size: 13.5px; font-weight: 700; cursor: pointer; border: 1px solid transparent; }
    .ro-btn--go { background: var(--danger); color: #fff; }
    .ro-btn--ok2 { background: var(--tracky); color: var(--accent-ink); }
    .ro-btn--ok { background: var(--bg-tertiary); color: var(--fg-primary); border-color: var(--border-subtle); }
    .ro-btn:disabled { opacity: .55; }
    .ro-spin { animation: ro-spin 1s linear infinite; }
    @keyframes ro-spin { to { transform: rotate(360deg); } }
    :host-context([data-theme='dark']) .ro-in { border-color: rgba(255,255,255,.15); }
  `],
})
export class ReorganisationSheetComponent {
  readonly open = input(false);
  /** Véhicules du périmètre : destinations possibles d'une réaffectation, et plaques à afficher. */
  readonly vehicles = input<VehiculeReorganisation[]>([]);
  /** Pré-réglage à l'ouverture (véhicule, fenêtre, action) — depuis un autre geste de la page. */
  readonly preset = input<PresetReorganisation | null>(null);
  /**
   * 29/09 — l'IA de la société du bandeau est-elle active ? La page le décide (`visibiliteIa`, statut
   * chargé ET de la société du bandeau) et le passe ici. Faux par défaut : rien de l'agent sans
   * confirmation (opt-in, comme `AiStatusService`).
   */
  readonly iaActive = input(false);
  /**
   * 29/09 (pistes 1 et 4 du propriétaire) — ce que la page sait de la société sans simuler
   * (`GET /reservations/reorganisables`) : réservations vivantes qui chevauchent les 30 prochains
   * jours, et le nom de la société. `null` = inconnu.
   */
  readonly reorganisables = input<ReservationsReorganisablesDto | null>(null);
  /** Propositions de l'agent en attente, montrées par la page (0 si l'IA est coupée). */
  readonly nbPropositions = input(0);
  readonly closed = output<void>();
  /** Émis après une application réelle — l'agenda recharge ses couches. */
  readonly applique = output<void>();
  /** « Ouvrir l'Assistant IA » depuis le vide : la page ferme la feuille et change de vue. */
  readonly ouvrirIa = output<void>();

  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly fleetFilter = inject(FleetFilterService);
  private readonly toast = inject(ToastService);
  private readonly destroyRef = inject(DestroyRef);
  /** Propositions écartées : la page (calendrier, badge, Assistant IA) relit ses propositions. */
  private readonly sync = inject(AgendaSyncService);

  protected readonly ShuffleIcon = Shuffle;
  protected readonly SwapIcon = ArrowRightLeft;
  protected readonly XIcon = X;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly CheckIcon = Check;
  protected readonly LoaderIcon = Loader;

  protected readonly fenetres = FENETRES;
  protected readonly fenetre = signal<number>(30);
  protected readonly vehicleId = signal('');
  /**
   * « Toutes » par défaut (refonte du 28/09) : « posées par l'agent » est vide depuis que l'agent ne
   * réserve plus fermement — un défaut qui ouvre sur du vide n'aide personne. La liste s'affiche
   * TOUJOURS avant d'appliquer, et l'avertissement sur les saisies humaines reste.
   */
  protected readonly origine = signal<OrigineReservation>('toutes');
  protected readonly action = signal<ActionReorganisation>('annuler');
  protected readonly versVehicleId = signal('auto');
  protected readonly decalage = signal(60);
  /**
   * Fenêtre imposée par un pré-réglage (la période d'une immobilisation), et si elle est EN VIGUEUR.
   * Revue du 29/09 : elle écrasait en silence les 7/14/30 jours, dont l'un était allumé par une
   * déduction « (fin − maintenant) arrondie » — cliquer « 30 jours » relançait la même fenêtre de
   * 3 jours, et le vide annonçait « dans les 30 prochains jours ». Désormais un bouton la nomme, les
   * durées la lèvent, et on peut y revenir.
   */
  protected readonly fenetrePreset = signal<FenetreImposee | null>(null);
  protected readonly fenetreFixeActive = signal(false);
  protected readonly periodePreset = signal('');
  /** Refus du geste d'origine, motif du serveur (figés à l'ouverture). */
  protected readonly nonReprises = signal<NonReprise[]>([]);
  /** Véhicule du pré-réglage : celui que visaient les refus ci-dessus (`''` sans pré-réglage). */
  protected readonly vehiculePreset = signal('');
  /**
   * T3 — les ids des réservations refusées du pré-réglage (figés à l'ouverture), et si le lot est
   * LIMITÉ à elles. Vrai à l'ouverture dès qu'il y en a ; seul « Élargir à toute la période » le lève
   * — et « Ne reprendre que … » y revient.
   */
  protected readonly idsPreset = signal<string[]>([]);
  protected readonly limiteeAuxRefus = signal(false);
  /**
   * La limite EN VIGUEUR — relecture du 29/09 (piste 3) : elle vaut sur le véhicule du pré-réglage,
   * et là seulement. Choisir un autre véhicule (depuis l'un ou l'autre onglet) ne la LÈVE plus : il la
   * rend sans objet (les refusées ne sont pas sur lui) ; revenir au véhicule la retrouve. Avant,
   * choisir « Tous » dans l'onglet Propositions puis revenir au véhicule reprenait toute la période —
   * les réservations laissées exprès comprises — sans que l'onglet Réservations soit à l'écran.
   */
  protected readonly limiteActive = computed(
    () =>
      this.limiteeAuxRefus() &&
      this.idsPreset().length > 0 &&
      (!this.vehiculePreset() || this.vehicleId() === this.vehiculePreset()),
  );

  protected readonly chargement = signal(false);
  protected readonly envoi = signal(false);
  protected readonly erreur = signal<string | null>(null);
  /**
   * Ce que la feuille doit dire au-dessus de la simulation — aujourd'hui : « la liste a changé
   * depuis la simulation, rien n'a été appliqué » (409 sur `attendu`). Effacé au critère suivant.
   */
  protected readonly avis = signal<string | null>(null);
  /** La simulation (ou l'application) courante, AVEC le corps qui l'a produite. */
  protected readonly lue = signal<Lecture | null>(null);
  /**
   * Dernière liste par véhicule reçue pendant cette ouverture (`null` = pas encore reçue). Tenue à
   * part de `lue` : une simulation en erreur ne doit pas vider la liste où l'on choisit le véhicule.
   */
  private readonly parVehiculeConnu = signal<NonNullable<ReorganisationResultDto['parVehicule']> | null>(null);

  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  /** Super-admin sans société dans le bandeau : ni simulation, ni application (revue du 29/09). */
  protected readonly needsFleet = computed(() => this.isSuperAdmin() && !this.fleetFilter.selectedFleetId());
  /** Réaffecter sans véhicule source = brasser tout le parc : le serveur le refuse, l'écran aussi. */
  protected readonly reaffecterSansVehicule = computed(() => this.action() === 'reaffecter' && !this.vehicleId());

  protected readonly parVehicule = computed(() => this.parVehiculeConnu() ?? []);
  protected readonly listeConnue = computed(() => this.parVehiculeConnu() !== null);
  /**
   * La liste « Véhicule » — 29/09 (piste 2 du propriétaire) : SEULS les véhicules qui ont des
   * réservations sur la fenêtre lue (compte > 0 de la dernière simulation). Chez cdef31, elle alignait
   * les 30 véhicules du parc à « (0) » : une liste à parcourir pour ne rien trouver.
   *
   * Pourquoi c'est sûr aujourd'hui (la contre-revue du 29/09 avait fait l'inverse) : `parVehicule`
   * compte ce qui CHEVAUCHE la fenêtre, quelle que soit l'action — le véhicule qui tombe en panne en
   * pleine réservation y figure donc, par sa réservation en cours. Un véhicule sans aucune réservation
   * n'a rien à reprendre. Le véhicule CHOISI (ou celui du pré-réglage) reste toujours dans la liste,
   * même à 0 (option ajoutée par le gabarit). Avant la première simulation : rien que « Tous ».
   */
  protected readonly optionsVehicule = computed(() => {
    if (!this.listeConnue()) return [];
    const plaques = new Map(this.vehicles().map((v) => [v.id, v.plate] as const));
    return this.parVehicule()
      .filter((v) => v.n > 0)
      .map((v) => ({ vehicleId: v.vehicleId, plate: plaques.get(v.vehicleId) ?? v.plate, n: v.n }))
      .sort((a, b) => (a.plate ?? '').localeCompare(b.plate ?? '', 'fr', { numeric: true }));
  });
  /** 29/09 (piste 2) — sous la liste : combien de véhicules ont des réservations, et que seuls ceux-là sont proposés. */
  protected readonly texteListeVehicules = computed(() => {
    const l = this.lue();
    if (!this.listeConnue() || !l) return null;
    const n = this.optionsVehicule().length;
    const agent = l.corps.origine === 'auto';
    const quoi = agent ? "des réservations posées par l'agent" : 'des réservations';
    if (n === 0) return `Aucun véhicule n'a de réservation${agent ? " posée par l'agent" : ''} ${l.fenetre}.`;
    return n > 1
      ? `${n} véhicules ont ${quoi} ${l.fenetre} : seuls ceux-là sont proposés.`
      : `1 véhicule a ${quoi} ${l.fenetre} : seul celui-là est proposé.`;
  });
  /** La simulation lue a au moins une réservation dans son lot (l'avertissement « relisez la liste » n'a de sens qu'alors). */
  protected readonly lotNonVide = computed(() => {
    const l = this.lue();
    return !!l && l.r.concernees > 0;
  });
  /** Ouverte depuis un geste de la page (véhicule, période, refusées) : son vide garde ses propres mots. */
  private readonly ouverteDepuisUnGeste = computed(() => {
    const p = this.preset();
    return !!p && (!!p.vehicleId || !!p.from || (p.ids?.length ?? 0) > 0 || (p.nonReprises?.length ?? 0) > 0);
  });
  /**
   * 29/09 (piste 1) — RIEN À RÉORGANISER : aucune réservation vivante ne chevauche les 30 prochains
   * jours dans la société. La feuille le dit en tête et ne montre rien d'autre (voir `rienAReorganiser`).
   */
  protected readonly rien = computed(() => {
    if (this.needsFleet()) return false;
    const l = this.lue();
    return rienAReorganiser({
      ouverteDepuisUnGeste: this.ouverteDepuisUnGeste(),
      lecture: l
        ? {
            simulation: l.r.simulation,
            origine: l.corps.origine,
            avecVehicule: !!l.corps.vehicleId,
            avecListeBlanche: !!l.corps.ids,
            jours: Math.round((Date.parse(l.corps.to) - Date.parse(l.corps.from)) / 86_400_000),
            // Sans `parVehicule` (API d'avant), on ne conclut pas au vide.
            chevauchantes: l.r.parVehicule ? l.r.parVehicule.reduce((n, v) => n + v.n, 0) : 1,
          }
        : null,
      compteMenu: this.reorganisables()?.total ?? null,
    });
  });
  /** « Aucune réservation à venir chez cdef31 dans les 30 prochains jours. » */
  protected readonly texteRien = computed(() => {
    const s = this.reorganisables()?.societe;
    return `Aucune réservation à venir${s ? ` chez ${s}` : ''} dans les 30 prochains jours.`;
  });
  /**
   * Les propositions de l'agent, quand il y en a (IA active) : ce ne sont pas des réservations — mais,
   * depuis la piste 3 (29/09), elles se reprennent d'ici, dans l'onglet « Propositions de l'agent ».
   */
  protected readonly textePropositions = computed(() => {
    const n = this.iaActive() ? this.nbPropositions() : 0;
    if (n <= 0) return null;
    return n > 1
      ? `Les ${n} propositions de l'agent, elles, se reprennent d'ici`
      : `La proposition de l'agent, elle, se reprend d'ici`;
  });
  /** La suite de la phrase, accordée. */
  protected readonly suitePropositions = computed(() =>
    this.nbPropositions() > 1
      ? "un véhicule part au garage, une journée tombe — écartez-les d'un coup, après avoir vu la liste."
      : "un véhicule part au garage, une journée tombe — écartez-la, après l'avoir vue.",
  );

  // ─── 29/09 (piste 3 du propriétaire) — les propositions de l'agent ───────────────────────────

  /** L'onglet choisi : les réservations, ou les propositions de l'agent (voir `quoiALOuverture`). */
  protected readonly quoi = signal<QuoiReorganiser>('reservations');
  /** IA coupée (ou statut perdu) pendant qu'on est sur les propositions : retour aux réservations. */
  protected readonly quoiEffectif = computed<QuoiReorganiser>(() => (this.iaActive() ? this.quoi() : 'reservations'));
  protected readonly chargementP = signal(false);
  protected readonly envoiP = signal(false);
  protected readonly erreurP = signal<string | null>(null);
  /** La simulation (ou le compte-rendu) des propositions, AVEC le corps qui l'a produite. */
  protected readonly lueP = signal<LecturePropositions | null>(null);
  /** Dernière liste par véhicule des propositions (`null` = pas encore reçue) — tenue à part, comme `parVehiculeConnu`. */
  private readonly parVehiculePConnu = signal<EcartPropositionsResultDto['parVehicule'] | null>(null);
  private lectureP = 0;
  private enVolP: Subscription | null = null;

  /** « Réorganiser des réservations » sans onglet ; « Réorganiser » quand l'onglet dit sur quoi. */
  protected readonly titre = computed(() => (this.ongletVisible() ? 'Réorganiser' : 'Réorganiser des réservations'));
  protected readonly ongletVisible = computed(() =>
    ongletPropositionsVisible({
      iaActive: this.iaActive(),
      sansSociete: this.needsFleet(),
      quoi: this.quoi(),
      propositionsPage: this.nbPropositions(),
      propositionsListe: this.totalP(),
    }),
  );
  /** Le nombre du bouton « Réservations » : ce que chevauche la fenêtre lue (véhicule choisi, ou tous). */
  protected readonly compteOngletReservations = computed(() =>
    this.rien() ? 0 : compteDeLaListe(this.parVehiculeConnu(), this.vehicleId()),
  );
  /** Le nombre du bouton « Propositions de l'agent », sur la même fenêtre et le même véhicule. */
  protected readonly compteOngletPropositions = computed(() => compteDeLaListe(this.parVehiculePConnu(), this.vehicleId()));
  /** Total de la dernière liste des propositions, tous véhicules (`null` = pas encore lue). */
  protected readonly totalP = computed(() => compteDeLaListe(this.parVehiculePConnu(), ''));
  /** La liste « Véhicule » de l'onglet : seuls les véhicules qui ont des propositions sur la fenêtre. */
  protected readonly optionsVehiculeP = computed(() => {
    const liste = this.parVehiculePConnu();
    if (!liste) return [];
    const plaques = new Map(this.vehicles().map((v) => [v.id, v.plate] as const));
    return liste
      .filter((v) => v.n > 0)
      .map((v) => ({ vehicleId: v.vehicleId, plate: plaques.get(v.vehicleId) ?? v.plate, n: v.n }))
      .sort((a, b) => (a.plate ?? '').localeCompare(b.plate ?? '', 'fr', { numeric: true }));
  });
  protected readonly vehiculeDansListeP = computed(() => this.optionsVehiculeP().some((v) => v.vehicleId === this.vehicleId()));
  protected readonly texteListeVehiculesP = computed(() => {
    const l = this.lueP();
    const n = this.optionsVehiculeP().length;
    if (!l || n === 0) return null; // le vide le dit lui-même
    return n > 1
      ? `${n} véhicules ont des propositions ${l.fenetre} : seuls ceux-là sont proposés.`
      : `1 véhicule a des propositions ${l.fenetre} : seul celui-là est proposé.`;
  });

  protected choisirQuoi(q: QuoiReorganiser): void {
    this.quoi.set(q);
    // Une simulation d'arrière-plan en échec (silencieuse, voir `simulerP`) : on la relance en arrivant
    // sur l'onglet, plutôt que d'y laisser une erreur qu'aucun critère changé ne rejouerait.
    if (q === 'propositions' && this.erreurP() && !this.chargementP() && this.open() && this.iaActive() && !this.needsFleet()) {
      const { corps, fenetre } = this.preparerP();
      this.simulerP(corps, fenetre);
    }
  }

  protected surPlaqueP(l: LecturePropositions): string {
    return l.corps.vehicleId ? ` sur ${this.plaqueDe(l.corps.vehicleId)}` : '';
  }

  /**
   * Des propositions hors de ce que l'appelant gère : dites, jamais prises. `autres` : il y en a aussi
   * dans le lot (« N autres… ») — sinon, sans « autres ».
   */
  protected horsGestionTexte(n: number, autres: boolean): string {
    const a = autres ? ' autre' : '';
    return n > 1
      ? `${n}${autres ? ' autres' : ''} propositions portent sur des véhicules dont vous ne gérez pas les réservations : elles ne se retirent pas d'ici.`
      : `Une${a} proposition porte sur un véhicule dont vous ne gérez pas les réservations : elle ne se retire pas d'ici.`;
  }

  /** Écartées ailleurs, réservées ou expirées entre la simulation et le clic (statut relu par le serveur). */
  protected dejaTraiteesTexte(n: number): string {
    return n > 1
      ? `${n} déjà traitées entre-temps (réservées ou écartées ailleurs) : laissées telles quelles`
      : `1 déjà traitée entre-temps (réservée ou écartée ailleurs) : laissée telle quelle`;
  }

  /** Toujours en attente sans avoir été écartées : commencées entre-temps, ou sorties du périmètre. */
  protected resteesTexte(n: number): string {
    return n > 1
      ? `${n} toujours en attente (commencées entre-temps, ou hors de votre périmètre) : non écartées`
      : `1 toujours en attente (commencée entre-temps, ou hors de votre périmètre) : non écartée`;
  }

  /**
   * Relecture du 29/09 — un lot « Tout réserver / Tout écarter » de l'Assistant IA tourne sur la
   * société du bandeau (`AgendaSyncService.lotsEnCours`, clé `société|véhicule`) : « Écarter » attend son
   * bilan, comme le panneau du jour. Les données resteraient cohérentes (écritures sous condition), mais
   * deux intentions contraires ne partent pas en même temps.
   */
  protected readonly lotIaEnCours = computed(() => {
    const prefixe = `${this.fleetFilter.selectedFleetId() ?? '-'}|`;
    return [...this.sync.lotsEnCours()].some((cle) => cle.startsWith(prefixe));
  });

  /** Vide sur une fenêtre courte, tous véhicules : l'agent propose jusqu'à 14 jours — proposer d'élargir. */
  protected plusLoinP(l: LecturePropositions): boolean {
    if (l.corps.vehicleId || this.fenetreFixeActive() || this.nbPropositions() <= 0) return false;
    return Math.round((Date.parse(l.corps.to) - Date.parse(l.corps.from)) / 86_400_000) < 30;
  }
  protected readonly vehiculeDansListe = computed(() => this.optionsVehicule().some((v) => v.vehicleId === this.vehicleId()));
  protected readonly totalOrigine = computed(() => this.parVehicule().reduce((n, v) => n + v.n, 0));

  /** Société des réservations qu'on déplace : celle du véhicule libéré, sinon celle du bandeau. */
  private readonly societeCible = computed(
    () => this.vehicles().find((v) => v.id === this.vehicleId())?.fleetId
      ?? (this.isSuperAdmin() ? this.fleetFilter.selectedFleetId() : null)
      ?? null,
  );
  /**
   * Destinations : jamais le véhicule libéré, jamais un véhicule d'une autre société — un
   * super-admin se voyait proposer les plaques de Client test pour les réservations du cdef31.
   */
  protected readonly destinations = computed(() => {
    const societe = this.societeCible();
    return this.vehicles().filter((v) => v.id !== this.vehicleId() && (!societe || v.fleetId === societe));
  });

  /**
   * Comptes par origine de la simulation LUE : ceux du véhicule quand elle en visait un (le serveur
   * les rend dans `totauxVehicule`), ceux de la société sinon. `null` = pas de compte fiable à dire.
   */
  protected readonly comptes = computed(() => {
    const l = this.lue();
    if (!l) return null;
    return l.corps.vehicleId ? (l.r.totauxVehicule ?? null) : (l.r.totaux ?? null);
  });
  /**
   * Quatrième revue du 29/09 (D1) — la simulation LUE était limitée aux refusées (`ids`). Ses comptes
   * par origine et par véhicule portent sur tout le véhicule (choix du serveur, figé par la spec T3 :
   * c'est ce qu'« Élargir » reprendrait) : ils ne s'affichent pas en NOMBRES sur les boutons, où ils
   * se lisaient comme le lot (« Toutes 3 » au-dessus de « 1 réservation serait réaffectée »).
   */
  protected readonly lotLimite = computed(() => !!this.lue()?.corps.ids);
  /** Les comptes des boutons d'origine : ceux de `comptes()`, sauf sous un lot limité aux refusées (D1). */
  protected readonly comptesBoutons = computed(() => (this.lotLimite() ? null : this.comptes()));
  /** Le « (n) » d'une plaque de la liste Véhicule — tu pour le véhicule d'un lot limité aux refusées (D1). */
  protected compteVehiculeVisible(vehicleId: string): boolean {
    if (!this.listeConnue()) return false;
    return !(this.lotLimite() && vehicleId === this.lue()?.corps.vehicleId);
  }
  /**
   * 29/09 (revue) — dernier compte CONNU des réservations posées par l'agent sur la société du bandeau
   * (`totaux.agent` d'une simulation réussie : toute la société sur la fenêtre simulée, avant les
   * filtres de véhicule et d'origine). Ni remis à zéro à l'ouverture — la feuille reste montée dans la
   * page, rouverte elle sait déjà —, ni effacé par une simulation en erreur, ni changé par le choix
   * d'un véhicule. Voir `CompteAgentMemorise`.
   */
  private readonly compteAgentSociete = signal<CompteAgentMemorise | null>(null);
  /**
   * 29/09 (IA désactivée) — le bouton « Posées par l'agent » (et le « · N de l'agent » du détail).
   * IA coupée, il ne reste que s'il filtre de VRAIES réservations — la société en a au moins une sur
   * la fenêtre (`compteAgentSociete`) —, ou s'il est le filtre actif. Voir `origineAgentVisible`.
   *
   * Revue du 29/09 : il lisait `comptes()`, la simulation AFFICHÉE — `null` à chaque ouverture et après
   * une erreur, celle du véhicule choisi sinon : il surgissait au retour de la première simulation
   * (« Toutes » passant de pleine largeur à moitié), disparaissait sur une erreur, et avec un véhicule
   * sans réservation de l'agent. Le nombre écrit SUR le bouton reste celui du périmètre lu (`comptesBoutons`).
   */
  protected readonly boutonAgentVisible = computed(() =>
    origineAgentVisible({
      iaActive: this.iaActive(),
      compteAgent: compteAgentMemorise(this.compteAgentSociete(), this.fleetFilter.selectedFleetId()),
      selectionnee: this.origine() === 'auto',
    }),
  );
  /** Réservations humaines ou publiques dans le périmètre lu (`null` = inconnu). */
  protected readonly autresQueAgent = computed(() => {
    const c = this.comptes();
    return c ? c.public + c.manuelle : null;
  });
  protected readonly plaqueLue = computed(() => {
    const id = this.lue()?.corps.vehicleId;
    return id ? this.plaqueDe(id) : null;
  });
  protected readonly surPlaque = computed(() => {
    const p = this.plaqueLue();
    return p ? ` sur ${p}` : '';
  });
  /**
   * Réservations du véhicule lu que la liste compte (elles CHEVAUCHENT la fenêtre) mais que
   * l'action lue ne prend pas : annuler et décaler ne touchent que ce qui COMMENCE dans la fenêtre.
   * Seulement sur « Toutes » (le compte par véhicule et le lot portent alors sur la même origine)
   * et hors Réaffecter, qui les prend (scindées à la coupe). 0 = rien à dire.
   */
  protected readonly avantFenetre = computed(() => {
    const l = this.lue();
    // Lot limité aux refusées (T3) : la liste compte tout le véhicule, le lot quelques ids — la
    // différence n'a rien à voir avec ce qui « déborde » sur la fenêtre.
    if (!l || l.corps.ids || l.corps.action === 'reaffecter' || l.corps.origine !== 'toutes' || !l.r.parVehicule) return 0;
    // Recette démo du 29/09 : aussi sur « Tous les véhicules ». La liste disait « 1 véhicule a des
    // réservations » et, juste dessous, « Aucune réservation à venir » — la réservation était EN COURS,
    // qu'Annuler ne prend pas. On compte alors tout ce qui chevauche la fenêtre.
    const n = l.corps.vehicleId
      ? (l.r.parVehicule.find((v) => v.vehicleId === l.corps.vehicleId)?.n ?? 0)
      : l.r.parVehicule.reduce((s, v) => s + v.n, 0);
    return Math.max(0, n - l.r.concernees);
  });
  /** « Réaffecter » depuis le vide de « Tous les véhicules » : on choisit LE véhicule concerné, et l'action. */
  protected reaffecterDepuis(vehicleId: string): void {
    this.choisirVehicule(vehicleId);
    this.action.set('reaffecter');
  }
  /**
   * Lignes de l'aperçu (par index) qui figurent parmi les refus RENDUS PAR LE SERVEUR — prévus en
   * simulation (T4 : une demande en attente qui déborde sur la coupe), constatés après l'application.
   * Un refus ne porte pas d'id : on l'apparie par véhicule et début, chaque refus à UNE ligne au plus,
   * de préférence une demande en attente — deux demandes REQUESTED peuvent partager un créneau (la
   * contrainte d'exclusion ne tient que les réservations fermes), une ligne ferme au même début non.
   */
  protected readonly lignesRefusees = computed(() => {
    const marquees = new Set<number>();
    const l = this.lue();
    if (!l) return marquees;
    const apercu = l.r.apercu;
    for (const x of l.r.refusees) {
      const libres = apercu
        .map((_, i) => i)
        .filter((i) => !marquees.has(i) && apercu[i].startAt === x.startAt && apercu[i].plate === x.plate);
      if (libres.length === 0) continue;
      marquees.add(libres.find((i) => apercu[i].status === 'REQUESTED') ?? libres[0]);
    }
    return marquees;
  });
  /** La simulation lue vise le véhicule des refus listés — sinon « celles ci-dessus » parlerait d'un autre. */
  protected readonly refusSurVehiculeLu = computed(() => {
    const id = this.lue()?.corps.vehicleId;
    return this.nonReprises().length > 0 && !!id && id === this.vehiculePreset();
  });

  private etaitOuverte = false;
  /** Numéro de la dernière requête partie : toute réponse d'un numéro antérieur est périmée. */
  private lecture = 0;
  private enVol: Subscription | null = null;

  constructor() {
    /**
     * À l'OUVERTURE : les pré-réglages s'appliquent ; puis toute modification d'un critère REFAIT la
     * simulation. Ce qui tient le nombre affiché et le bouton d'accord (revue du 29/09 — la
     * promesse était écrite ici sans être tenue) : chaque simulation est NUMÉROTÉE et une réponse
     * périmée est jetée ; le bouton est éteint pendant qu'elle court ; et « appliquer » renvoie le
     * corps de la simulation affichée, pas les critères du moment.
     */
    effect(() => {
      if (!this.open()) {
        if (this.etaitOuverte) {
          this.etaitOuverte = false;
          // Une réponse partie avant la fermeture n'écrira pas dans la prochaine ouverture.
          untracked(() => this.oublierLectures());
        }
        return;
      }
      if (!this.etaitOuverte) {
        this.etaitOuverte = true;
        untracked(() => this.appliquerPreset());
      }
      if (this.needsFleet()) {
        untracked(() => {
          this.oublierLectures();
          this.lue.set(null);
          this.erreur.set(null);
          this.parVehiculeConnu.set(null);
        });
        return;
      }
      // Réaffecter sans véhicule : on ne simule pas le geste (le serveur le refuse), on COMPTE
      // seulement, sous « Annuler » — pour les comptes de la liste « Véhicule » (ce qui chevauche la
      // fenêtre, quelle que soit l'action) pendant qu'on choisit le véhicule. La liste, elle, est le
      // parc entier : elle ne dépend plus de ce comptage. Jamais applicable.
      const comptageSeul = this.action() === 'reaffecter' && !this.vehicleId();
      const { corps, fenetre } = this.preparer(comptageSeul ? 'annuler' : this.action());
      untracked(() => {
        this.avis.set(null); // un critère a changé : l'avis portait sur la liste d'avant
        this.simuler(corps, fenetre, !comptageSeul);
      });
    });

    /**
     * 29/09 (piste 3) — la simulation des PROPOSITIONS, sur la même fenêtre et le même véhicule, dans
     * les deux onglets : le bouton « Propositions de l'agent » porte son compte même quand on regarde
     * les réservations. Elle ne dépend QUE de la fenêtre, du véhicule et de la société — ni de l'onglet,
     * ni des critères des réservations, ni du nombre de propositions de la page : après un « Écarter »,
     * la page relit ses propositions, et le compte-rendu doit rester affiché. IA coupée : rien.
     * Créé APRÈS l'effet d'ouverture : les pré-réglages sont posés quand celui-ci lit les critères.
     */
    effect(() => {
      if (!this.open() || this.needsFleet() || !this.iaActive()) {
        untracked(() => {
          this.oublierLecturesP();
          this.lueP.set(null);
          this.erreurP.set(null);
          this.parVehiculePConnu.set(null);
        });
        return;
      }
      const { corps, fenetre } = this.preparerP();
      untracked(() => this.simulerP(corps, fenetre));
    });
  }

  private appliquerPreset(): void {
    const p = this.preset();
    this.oublierLectures();
    this.lue.set(null);
    this.erreur.set(null);
    this.avis.set(null);
    this.parVehiculeConnu.set(null);
    const vehicule = p?.vehicleId ?? '';
    this.vehicleId.set(vehicule);
    this.vehiculePreset.set(vehicule);
    // Réaffecter demande un véhicule : sans, l'action par défaut reste Annuler.
    const action = p?.action ?? (vehicule ? 'reaffecter' : 'annuler');
    this.action.set(action === 'reaffecter' && !vehicule ? 'annuler' : action);
    this.versVehicleId.set('auto');
    this.origine.set('toutes');
    this.fenetre.set(30);
    const fixe = this.fenetreDuPreset(p);
    this.fenetrePreset.set(fixe);
    this.fenetreFixeActive.set(fixe !== null);
    this.periodePreset.set(fixe ? this.periodeTexte(fixe) : '');
    this.nonReprises.set(p?.nonReprises ?? []);
    const brut = p?.ids;
    const ids = Array.isArray(brut) ? [...new Set(brut.filter((id): id is string => typeof id === 'string' && id !== ''))] : [];
    this.idsPreset.set(ids);
    this.limiteeAuxRefus.set(ids.length > 0);
    // 29/09 (piste 3) : l'onglet d'ouverture est celui qui a quelque chose — les propositions quand il
    // n'y a qu'elles (cdef31), ou celui du geste. Leur lecture, elle, n'est PAS remise à zéro ici :
    // l'effet des propositions l'a vidée à la fermeture et la relance à l'ouverture — l'oublier ici,
    // selon l'ordre des effets, jetterait la simulation qu'il vient de lancer sans la relancer.
    this.quoi.set(
      p?.quoi ??
        quoiALOuverture({
          ouverteDepuisUnGeste: this.ouverteDepuisUnGeste(),
          reservations: this.reorganisables()?.total ?? null,
          iaActive: this.iaActive(),
          propositions: this.nbPropositions(),
        }),
    );
  }

  /**
   * La fenêtre imposée par le pré-réglage. Contre-revue du 29/09 : un « from » SANS « to » — une
   * immobilisation sans date de fin, le cas par défaut du formulaire — était abandonné en silence :
   * la feuille repartait sur « maintenant → 30 jours » et proposait de réaffecter aussi les
   * réservations d'AVANT l'immobilisation, que le véhicule peut honorer. Désormais : JOURS_SANS_FIN
   * jours à partir du début (ramené à maintenant s'il est passé, comme le fait le serveur — le
   * libellé « (30 jours) » reste vrai), et le bouton le nomme.
   */
  private fenetreDuPreset(p: PresetReorganisation | null): FenetreImposee | null {
    if (!p?.from) return null;
    const debut = new Date(p.from).getTime();
    if (!Number.isFinite(debut)) return null;
    if (p.to) return { from: p.from, to: p.to, sansFin: false };
    const base = Math.max(debut, Date.now());
    return { from: p.from, to: new Date(base + JOURS_SANS_FIN * 86_400_000).toISOString(), sansFin: true };
  }

  /**
   * Le corps de la simulation, et sa fenêtre en toutes lettres. « Maintenant » est relu ICI, à chaque
   * simulation (revue du 29/09) : dans un computed, il restait celui de la première évaluation tant
   * qu'aucun critère ne changeait — la feuille est montée en permanence, et « 7 jours » rouvert une
   * semaine plus tard visait une fenêtre déjà passée.
   */
  private preparer(action: ActionReorganisation): { corps: CorpsReorganisation; fenetre: string } {
    const { from, to, fenetre } = this.bornes();
    const corps: CorpsReorganisation = {
      from,
      to,
      origine: this.origine(),
      action,
      decalageMinutes: action === 'decaler' ? this.decalage() : undefined,
      versVehicleId: action === 'reaffecter' ? this.versVehicleId() : undefined,
      vehicleId: this.vehicleId() || undefined,
      fleetId: this.fleetFilter.selectedFleetId() ?? undefined,
      // T3 : la liste blanche part dans le corps SIMULÉ — `appliquer()` le renvoie à l'identique.
      ids: this.limiteActive() ? [...this.idsPreset()] : undefined,
    };
    return { corps, fenetre };
  }

  /**
   * La fenêtre courante — la période imposée si elle est en vigueur, sinon N jours à partir de
   * maintenant, relu ICI (voir `preparer`) — et ses mots. Une seule règle pour les deux onglets
   * (29/09, piste 3) : réservations et propositions d'un même véhicule se lisent sur la même période.
   */
  private bornes(): { from: string; to: string; fenetre: string } {
    const maintenant = Date.now();
    const fixe = this.fenetreFixeActive() ? this.fenetrePreset() : null;
    const jours = this.fenetre();
    return {
      from: fixe?.from ?? new Date(maintenant).toISOString(),
      to: fixe?.to ?? new Date(maintenant + jours * 86_400_000).toISOString(),
      fenetre: fixe ? this.periodeTexte(fixe) : `dans les ${jours} prochains jours`,
    };
  }

  /** Le corps d'une simulation de propositions : la fenêtre, le véhicule et la société, rien d'autre. */
  private preparerP(): { corps: CorpsPropositions; fenetre: string } {
    const { from, to, fenetre } = this.bornes();
    return {
      corps: {
        from,
        to,
        vehicleId: this.vehicleId() || undefined,
        // Super-admin seulement : le filtre est relu du navigateur, quel que soit le rôle (le serveur
        // l'ignore aussi pour les autres).
        fleetId: this.isSuperAdmin() ? (this.fleetFilter.selectedFleetId() ?? undefined) : undefined,
      },
      fenetre,
    };
  }

  /**
   * « du lun. 5 oct. au mer. 7 oct. » — le début est ramené à maintenant, comme le fait le serveur
   * (il ne regarde jamais le passé) : afficher un début passé décrirait une fenêtre non examinée.
   * Sans date de fin : « à partir du ven. 10 oct., 09:00 (30 jours) ». Une fin à minuit pile appartient
   * au jour d'avant (recette démo du 29/09) : voir `libellePeriode`.
   */
  private periodeTexte(fx: FenetreImposee): string {
    return libellePeriode(fx, Date.now(), JOURS_SANS_FIN);
  }

  /**
   * 29/09 — la simulation lue (« Toutes », sans véhicule ni liste blanche) est vide sur une fenêtre de
   * moins de 30 jours, et le compte du menu en trouve sur 30 : combien, pour proposer d'élargir. 0 sinon.
   */
  protected plusLoin(l: Lecture): number {
    const total = this.reorganisables()?.total ?? 0;
    if (total <= 0 || this.fenetreFixeActive() || l.corps.origine !== 'toutes' || l.corps.vehicleId || l.corps.ids) return 0;
    const jours = Math.round((Date.parse(l.corps.to) - Date.parse(l.corps.from)) / 86_400_000);
    if (jours >= 30) return 0;
    // Recette démo du 29/09 : « Une réservation plus loin » comptait AUSSI celle qui chevauche déjà la
    // fenêtre courte (en cours) — la même, annoncée deux fois. Plus loin = les 30 jours moins la fenêtre.
    const dansLaFenetre = (l.r.parVehicule ?? []).reduce((s, v) => s + v.n, 0);
    return Math.max(0, total - dansLaFenetre);
  }

  protected choisirDuree(jours: number): void {
    this.fenetreFixeActive.set(false);
    this.fenetre.set(jours);
  }

  /**
   * Changer le véhicule libéré : une destination devenue impossible (lui-même, autre société) retombe
   * sur Auto. Un AUTRE véhicule que celui du pré-réglage ne porte pas les réservations refusées : la
   * limite aux refusées (T3) est alors sans objet (`limiteActive`), sans être levée — revenir au
   * véhicule la retrouve (relecture du 29/09 : un choix dans l'onglet Propositions la levait en silence).
   */
  protected choisirVehicule(id: string): void {
    this.vehicleId.set(id);
    this.recalerDestination();
  }

  private recalerDestination(): void {
    const vers = this.versVehicleId();
    if (vers !== 'auto' && !this.destinations().some((v) => v.id === vers)) this.versVehicleId.set('auto');
  }

  /** T3 — geste EXPLICITE : reprendre toute la période, y compris les réservations laissées. */
  protected elargir(): void {
    this.limiteeAuxRefus.set(false);
  }

  /**
   * T3 — revenir au périmètre de l'ouverture : le véhicule, la période, les seules refusées, et
   * « Toutes » (l'origine de l'ouverture). Cinquième revue du 29/09 (C13) : l'origine n'était pas
   * remise — lu sous « Posées par l'agent », le retour retombait sur le même vide (une refusée est le
   * plus souvent saisie à la main). Sous un lot limité aux ids, « Toutes » n'ajoute rien d'autre
   * que les refusées elles-mêmes.
   */
  protected revenirAuxRefus(): void {
    if (this.idsPreset().length === 0) return;
    this.vehicleId.set(this.vehiculePreset());
    this.recalerDestination();
    if (this.fenetrePreset()) this.fenetreFixeActive.set(true);
    this.origine.set('toutes');
    this.limiteeAuxRefus.set(true);
  }

  protected plaqueDe(id: string): string {
    return this.vehicles().find((v) => v.id === id)?.plate ?? this.parVehicule().find((v) => v.vehicleId === id)?.plate ?? '—';
  }

  protected libelleAction(action: ActionReorganisation): string {
    return action === 'annuler' ? 'Annuler' : action === 'decaler' ? 'Décaler' : 'Réaffecter';
  }

  protected verbe(n: number, action: ActionReorganisation): string {
    const s = n > 1 ? 's' : '';
    if (action === 'annuler') return `annulée${s}`;
    if (action === 'decaler') return `décalée${s}`;
    return `réaffectée${s}`;
  }

  protected infinitif(action: ActionReorganisation): string {
    return action === 'annuler' ? 'annuler' : action === 'decaler' ? 'décaler' : 'réaffecter';
  }

  /**
   * T3 — pourquoi un lot limité aux refusées est vide : les raisons POSSIBLES seulement, selon le
   * corps lu (le serveur ne dit pas laquelle ; on ne l'invente pas).
   * Quatrième revue du 29/09 (C7) : une durée cliquée (7/14/30 jours) garde la limite ; la réservation
   * refusée, hors de cette fenêtre, n'y est plus — « hors de la fenêtre choisie » vient en tête.
   * Cinquième revue (C13) : seulement si la fenêtre lue l'écarte VRAIMENT — décidé sur les dates des
   * refusées (`nonReprises`, appariées par id), plus sur l'égalité des chaînes : « 30 jours » qui
   * contient la réservation du 10/10 ne cite plus la fenêtre.
   */
  protected videRefusees(corps: CorpsReorganisation): string {
    return raisonsVideRefusees(corps, this.fenetrePreset(), this.nonReprises(), Date.now());
  }

  /**
   * C7 — la simulation LUE écarte une refusée que la période de l'immobilisation prenait : le vide
   * propose d'y revenir. Décidé sur le corps lu (pas sur `fenetreFixeActive`, qui a pu changer depuis)
   * et, depuis C13, sur les dates des refusées — sinon le bouton ramenait au même vide.
   */
  protected peutRevenirALaPeriode(corps: CorpsReorganisation): boolean {
    const fx = this.fenetrePreset();
    return fx !== null && horsFenetrePreset(corps, fx, this.nonReprises(), Date.now());
  }

  /**
   * Réaffecter SCINDE ce qui a commencé avant la coupe — max(début de la fenêtre, maintenant), la
   * règle du serveur : la partie d'avant reste, la suite part. L'aperçu le dit, sinon une
   * réservation commencée hier y paraîtrait déplacée en entier.
   *
   * Troisième passe (T4) : jamais une demande en attente (REQUESTED). Le serveur ne la scinde pas —
   * elle se valide ou se refuse ; « scindée » annonçait une coupe qui n'aurait jamais lieu.
   */
  protected scindee(a: LigneApercu, corps: CorpsReorganisation): boolean {
    if (corps.action !== 'reaffecter' || a.status === 'REQUESTED') return false;
    return new Date(a.startAt).getTime() < Math.max(new Date(corps.from).getTime(), Date.now());
  }

  /**
   * T4 — ce que la simulation fera RÉELLEMENT partir : le lot moins les refus que le serveur prévoit.
   * C'est ce que disent le bilan et le bouton ; `attendu` reste `concernees`, le lot entier que le
   * serveur recalcule au moment d'écrire.
   */
  protected prevues(r: ReorganisationResultDto): number {
    return Math.max(0, r.concernees - (r.simulation ? r.refusees.length : 0));
  }

  /** Périme toute requête de simulation en vol (numéro + désabonnement). */
  private oublierLectures(): void {
    this.lecture++;
    this.enVol?.unsubscribe();
    this.enVol = null;
    this.chargement.set(false);
  }

  private simuler(corps: CorpsReorganisation, fenetre: string, applicable: boolean): void {
    this.enVol?.unsubscribe();
    const n = ++this.lecture;
    this.chargement.set(true);
    this.erreur.set(null);
    this.enVol = this.http
      .post<ReorganisationResultDto>(URL_REORGANISER, { ...corps, simulation: true })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          if (n !== this.lecture) return; // périmée : un critère a changé, ou la feuille s'est refermée
          this.lue.set({ corps, fenetre, applicable, r });
          if (r.parVehicule) this.parVehiculeConnu.set(r.parVehicule);
          // 29/09 (revue) : le compte de l'agent de la société — seule une simulation RÉUSSIE le remplace.
          this.compteAgentSociete.update((m) => memoriserCompteAgent(m, corps.fleetId ?? null, r));
          this.chargement.set(false);
        },
        error: (err) => {
          swallow('reorganisation:simuler', err);
          if (n !== this.lecture) return;
          this.lue.set(null);
          this.erreur.set(apiErrorMessage(err, 'Simulation impossible.'));
          this.chargement.set(false);
        },
      });
  }

  protected appliquer(): void {
    const l = this.lue();
    // Seulement la simulation AFFICHÉE, à jour, et qui propose quelque chose.
    if (this.envoi() || this.chargement() || !l || !l.applicable || !l.r.simulation || this.prevues(l.r) === 0) return;
    // Une simulation encore en vol ne réécrira pas l'écran par-dessus le compte-rendu.
    this.enVol?.unsubscribe();
    this.enVol = null;
    const n = ++this.lecture;
    this.envoi.set(true);
    this.avis.set(null);
    // `attendu` : le serveur recalcule le lot au moment d'écrire ; s'il n'a plus le nombre affiché,
    // il n'écrit RIEN (409) — on n'applique jamais un geste de masse sur un lot que personne n'a vu.
    // Quatrième revue du 29/09 (C0) : et `ids` = le lot EXACT de la simulation (`lotIds`). Le nombre
    // seul laissait passer une réservation sortie (commencée) compensée par une arrivée (une demande
    // du lien public) : la nouvelle était annulée sans avoir été vue, courriel de refus compris. Avec
    // la liste blanche, une arrivée n'entre jamais dans le lot, et une sortie fait tomber `attendu`.
    // `l.corps` n'est pas modifié : c'est lui qui dit à l'écran si le lot était limité aux refusées.
    const corps: ReorganiserReservationsDto = { ...l.corps, simulation: false, attendu: l.r.concernees };
    const lotIds = lotExactDeSimulation(l.r);
    if (lotIds) corps.ids = lotIds; // sous-ensemble de `l.corps.ids` s'il y en avait : rien n'est élargi
    // Sans `lotIds` (API d'avant la quatrième revue), le comportement d'avant : le nombre seul.
    this.http
      .post<ReorganisationResultDto>(URL_REORGANISER, corps)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.envoi.set(false);
          // L'écriture a eu lieu : la page recharge et le toast le dit, même si la feuille a été
          // refermée (et peut-être rouverte ailleurs) entre-temps — seul l'écran n'est pas réécrit.
          if (n === this.lecture) {
            this.lue.set({ ...l, applicable: false, r });
            if (r.parVehicule) this.parVehiculeConnu.set(r.parVehicule);
          }
          this.applique.emit();
          this.toast.success(
            `${r.appliquees} réservation(s) reprise(s)`,
            r.refusees.length > 0 ? `${r.refusees.length} non reprise(s) — voir le détail.` : '',
          );
        },
        error: (err) => {
          swallow('reorganisation:appliquer', err);
          this.envoi.set(false);
          if (err instanceof HttpErrorResponse && err.status === 409) {
            // Le lot a changé depuis la simulation (une réservation arrivée, partie, commencée) :
            // RIEN n'est écrit. Un « Échec » laisserait l'ancienne liste affichée et le même bouton
            // prêt à refaire le même refus — on relance la simulation, et on le dit.
            const motif = apiErrorMessage(err, 'La liste a changé depuis la simulation.');
            if (n === this.lecture) {
              this.avis.set(`${motif} Rien n'a été appliqué : voici la liste à jour — relisez-la avant d'appliquer.`);
              const { corps: neuf, fenetre } = this.preparer(l.corps.action);
              this.simuler(neuf, fenetre, true);
            } else {
              // Feuille refermée (ou critère changé) pendant l'envoi : seul un toast peut encore le dire.
              this.toast.warning('La liste a changé', `${motif} Rien n'a été appliqué : relancez Réorganiser pour revoir la liste.`);
            }
            return;
          }
          this.toast.error('Échec', apiErrorMessage(err, 'La réorganisation n’a pas abouti.'));
        },
      });
  }

  // ─── 29/09 (piste 3) — simuler / écarter un lot de propositions ─────────────────────────────

  /** Périme toute simulation de propositions en vol (numéro + désabonnement). */
  private oublierLecturesP(): void {
    this.lectureP++;
    this.enVolP?.unsubscribe();
    this.enVolP = null;
    this.chargementP.set(false);
  }

  private simulerP(corps: CorpsPropositions, fenetre: string): void {
    this.enVolP?.unsubscribe();
    const n = ++this.lectureP;
    this.chargementP.set(true);
    this.erreurP.set(null);
    // Relecture du 29/09 : cette simulation tourne AUSSI pendant qu'on regarde les réservations (pour le
    // compte de l'onglet). Là, une panne ne lève pas de toast global — l'onglet Propositions dira sa
    // propre erreur quand on l'ouvrira. À l'écran, elle reste un geste de l'utilisateur : toast normal.
    const enArrierePlan = this.quoiEffectif() !== 'propositions';
    this.enVolP = this.http
      .post<EcartPropositionsResultDto>(
        URL_ECARTER_PROPOSITIONS,
        { ...corps, simulation: true } satisfies EcarterPropositionsDto,
        enArrierePlan ? { headers: { [QUIET_ERRORS_HEADER]: '1' } } : {},
      )
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          if (n !== this.lectureP) return; // périmée : un critère a changé, ou la feuille s'est refermée
          this.lueP.set({ corps, fenetre, applicable: true, r });
          this.parVehiculePConnu.set(r.parVehicule);
          this.chargementP.set(false);
        },
        error: (err) => {
          swallow('reorganisation:simulerPropositions', err);
          if (n !== this.lectureP) return;
          this.lueP.set(null);
          this.erreurP.set(apiErrorMessage(err, 'Simulation impossible.'));
          this.chargementP.set(false);
        },
      });
  }

  /**
   * Écarte le lot de la simulation AFFICHÉE : ses identifiants (`lotIds`) repartent en `ids` — le
   * serveur n'écarte que ceux-là, encore en attente. Une proposition arrivée depuis n'est pas dans le
   * lot ; une proposition réservée ou écartée ailleurs entre-temps n'est pas touchée, et le compte-rendu
   * le dit (`dejaTraitees`). La page relit ensuite ses propositions (calendrier, badge, Assistant IA).
   */
  protected ecarterPropositions(): void {
    const l = this.lueP();
    if (this.envoiP() || this.chargementP() || this.lotIaEnCours() || !l || !l.applicable || !l.r.simulation || l.r.concernees === 0) return;
    this.enVolP?.unsubscribe();
    this.enVolP = null;
    const n = ++this.lectureP;
    this.envoiP.set(true);
    const corps: EcarterPropositionsDto = { ...l.corps, simulation: false, ids: [...l.r.lotIds] };
    this.http
      .post<EcartPropositionsResultDto>(URL_ECARTER_PROPOSITIONS, corps)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.envoiP.set(false);
          // L'écriture a eu lieu : la page relit et le toast le dit, même si la feuille a été
          // refermée entre-temps — seul l'écran n'est pas réécrit.
          if (n === this.lectureP) {
            this.lueP.set({ ...l, applicable: false, r });
            this.parVehiculePConnu.set(r.parVehicule);
          }
          this.sync.propositionsModifiees();
          const suite = [
            r.dejaTraitees > 0 ? this.dejaTraiteesTexte(r.dejaTraitees) : '',
            r.restees > 0 ? this.resteesTexte(r.restees) : '',
          ].filter(Boolean).join(' · ');
          if (r.ecartees > 0) {
            this.toast.success(`${r.ecartees} proposition${r.ecartees > 1 ? 's' : ''} écartée${r.ecartees > 1 ? 's' : ''}`, suite ? `${suite}.` : '');
          } else {
            // Relecture du 29/09 : plus de toast VERT « 0 proposition écartée » — rien n'est parti, et l'on dit pourquoi.
            this.toast.warning('Aucune proposition écartée', suite ? `${suite}.` : 'La liste avait changé : relancez la simulation.');
          }
        },
        error: (err) => {
          swallow('reorganisation:ecarterPropositions', err);
          this.envoiP.set(false);
          this.toast.error('Échec', apiErrorMessage(err, 'Les propositions n’ont pas été écartées.'));
        },
      });
  }
}
