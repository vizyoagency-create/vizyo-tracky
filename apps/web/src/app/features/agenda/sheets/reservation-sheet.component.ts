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
} from '@angular/core';
import { DatePipe, DecimalPipe, NgClass } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { apiErrorMessage } from '../../../core/error/api-error';
import {
  LucideAngularModule, Sparkles, Check, AlertTriangle, Loader, CalendarCheck, Inbox, X, User, Baby, Users,
} from 'lucide-angular';
import {
  DORMANT_STOP_COUNTING_MS,
  formatSilenceLabel,
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
}

/** Valeur du sélecteur de groupe quand l'utilisateur veut saisir un nom qui n'est pas un groupe de la société. */
const GROUPE_AUTRE = '__autre__';

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
              <app-datetime-range [start]="startAt()" [end]="endAt()" [minDay]="retroactive() ? '' : todayIso()" (startChange)="startAt.set($event)" (endChange)="endAt.set($event)"></app-datetime-range>
            </div>
            <!-- Consignation rétroactive : autorise un créneau passé pour enregistrer une sortie DÉJÀ faite. -->
            <label class="rs-retro" [class.rs-retro--on]="retroactive()">
              <input type="checkbox" [checked]="retroactive()" (change)="retroactive.set($any($event.target).checked)">
              <span class="rs-retro-txt">
                <span class="rs-retro-t">Réservation déjà effectuée (non enregistrée)</span>
                <span class="rs-retro-s">Coche si la sortie a <strong>déjà eu lieu</strong> : elle sera enregistrée à sa date réelle (passée). Sinon, les dates passées sont bloquées.</span>
              </span>
            </label>
            <label class="rs-f rs-f--sm"><span>Places min.</span><input type="number" min="0" inputmode="numeric" class="rs-in" [value]="minSeats()" (input)="minSeats.set($any($event.target).value)"></label>
            <!--
              SIÈGES AUTO (2026-09-28) — pris sur le STOCK de la société, pas sur le véhicule. Deux
              types, jamais interchangeables : un bébé ne va pas dans un siège enfant, ni l'inverse.
              La ligne sous les champs dit ce qu'il reste sur le créneau saisi : celui qui demande
              sait avant d'envoyer, et pas par un refus.
            -->
            <div class="rs-f">
              <span class="rs-lbl-row"><span><lucide-icon [img]="BabyIcon" [size]="12"></lucide-icon> Sièges auto à installer</span></span>
              <div class="rs-grid">
                <label class="rs-f rs-f--sm"><span class="rs-sub-lbl">Bébé <em>coque, cosy</em></span><input type="number" min="0" max="50" inputmode="numeric" class="rs-in" [value]="childSeatsBaby()" (input)="childSeatsBaby.set($any($event.target).value)" placeholder="0"></label>
                <label class="rs-f rs-f--sm"><span class="rs-sub-lbl">Enfant <em>siège, rehausseur</em></span><input type="number" min="0" max="50" inputmode="numeric" class="rs-in" [value]="childSeatsChild()" (input)="childSeatsChild.set($any($event.target).value)" placeholder="0"></label>
              </div>
              @if (seatsAvail(); as a) {
                @if (a.total.baby === 0 && a.total.child === 0) {
                  <span class="rs-hint">Aucun siège auto renseigné pour cette société — à compter dans « Paramètres de l'agenda ». Une réservation qui en demande sera refusée.</span>
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
                      stock disponible sur ce créneau : <strong>{{ a.available.baby }}</strong> bébé sur {{ a.stock.baby }} · <strong>{{ a.available.child }}</strong> enfant sur {{ a.stock.child }}
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
              <select class="rs-in" [value]="vehicleId()" (change)="vehicleId.set($any($event.target).value)">
                <option value="" [selected]="!vehicleId()">Auto (le 1er disponible conforme)</option>
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
                <div class="rs-grid">
                  <select class="rs-in" [value]="groupChoice()" (change)="choisirGroupe($any($event.target).value)" aria-label="Groupe de la réservation">
                    <option value="" [selected]="groupChoice() === ''">— Aucun groupe —</option>
                    @for (g of groupOptions(); track g.id) {
                      <option [value]="g.id" [selected]="g.id === groupChoice()">{{ g.name }}</option>
                    }
                    <option [value]="GROUPE_AUTRE" [selected]="groupChoice() === GROUPE_AUTRE">Autre…</option>
                  </select>
                  @if (groupChoice() === GROUPE_AUTRE) {
                    <input type="text" class="rs-in" maxlength="60" placeholder="Nom du groupe" aria-label="Nom du groupe"
                           [value]="groupName()" (input)="groupName.set($any($event.target).value); groupTouched.set(true)">
                  }
                </div>
                <span class="rs-hint">
                  @if (vehicleGroupName(); as vg) { Par défaut, le groupe du véhicule ({{ vg }}). } @else if (vehicleId()) { Ce véhicule n'a pas de groupe. }
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
              <button type="button" class="rs-btn rs-btn--primary" [disabled]="submitting() || needsFleet()" (click)="submit()">
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
                       groupe du véhicule pré-retenu, modifiable avant de dire oui. -->
                  <div class="rs-q-groupe">
                    <lucide-icon [img]="UsersIcon" [size]="12"></lucide-icon>
                    <span class="rs-q-groupe-l">Groupe</span>
                    <select class="rs-in rs-in--xs" [value]="groupeValidation(g)" (change)="choisirGroupeValidation(g.cle, $any($event.target).value)" [attr.aria-label]="'Groupe qui utilise le véhicule'">
                      <option value="" [selected]="groupeValidation(g) === ''">— Aucun —</option>
                      @for (og of groupOptions(); track og.id) {
                        <option [value]="og.id" [selected]="og.id === groupeValidation(g)">{{ og.name }}</option>
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
  protected readonly vehicleId = signal('');

  // ─── Groupe qui utilise le véhicule (point 9) ────────────────────────────────────────────
  /** Choix du sélecteur : '' (aucun), un id de groupe de la société, ou GROUPE_AUTRE (texte libre). */
  protected readonly groupChoice = signal('');
  /** Nom saisi quand « Autre… » est choisi. */
  protected readonly groupName = signal('');
  /** Vrai dès que l'utilisateur a touché au groupe : le défaut (groupe du véhicule) ne l'écrase plus. */
  protected readonly groupTouched = signal(false);
  /** Groupes de la société, tirés des véhicules proposés (dédup par id, triés). */
  protected readonly groupOptions = computed(() => {
    const map = new Map<string, { id: string; name: string }>();
    for (const v of this.vehicles()) if (v.group?.id && !map.has(v.group.id)) map.set(v.group.id, { id: v.group.id, name: v.group.name });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  });
  /** Nom du groupe du véhicule choisi — la phrase d'aide le nomme. */
  protected readonly vehicleGroupName = computed(() => {
    const id = this.vehicleId();
    if (!id) return null;
    return this.vehicles().find((v) => v.id === id)?.group?.name ?? null;
  });
  /** Groupe choisi À LA VALIDATION, par carte de la file (clé de groupe → id de groupe, '' = aucun). */
  protected readonly groupesValidation = signal<Record<string, string>>({});
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
   *  - le véhicule DÉJÀ sélectionné (mode édition d'une réservation existante) reste
   *    sélectionnable, sans quoi la feuille deviendrait inenregistrable ;
   *  - en « réservation déjà effectuée », on consigne une sortie PASSÉE : l'état actuel du
   *    boîtier n'a aucune importance, et refuser l'écriture ferait perdre l'information.
   */
  protected readonly vehicleOptions = computed(() => {
    const now = Date.now();
    const selected = this.vehicleId();
    const retro = this.retroactive();
    return this.vehicles().map((v) => {
      const tracker = v.tracker ?? null;
      const dormant = isVehicleDormant(
        { trackerId: tracker?.id, lastSeenAt: tracker?.lastSeenAt },
        now,
        DORMANT_STOP_COUNTING_MS,
      );
      const brand = v.brand ? ` · ${v.brand} ${v.model ?? ''}`.trimEnd() : '';
      // Hors service DÉCLARÉ : grisé même en édition (le serveur refuserait la réaffectation),
      // sauf s'il est déjà le véhicule de la réservation — sinon la feuille devient inenregistrable.
      const horsService = horsServiceLabel(v.outOfServiceReason);
      return {
        id: v.id,
        label: `${v.plate || '—'}${brand}`,
        horsService,
        // Sièges auto déjà installés : celui qui choisit le véhicule voit ce qu'il n'aura pas à installer.
        aBord: siegesLabel({ baby: v.childSeatsBaby ?? 0, child: v.childSeatsChild ?? 0 }),
        // On DATE le silence au lieu de dire « indisponible » : l'exploitant sait quoi faire.
        silence: dormant ? formatSilenceLabel(tracker?.lastSeenAt, now) : null,
        disabled: (!!horsService && v.id !== selected && !retro) || (dormant && v.id !== selected && !retro),
      };
    });
  });

  /** Nombre de véhicules grisés pour DORMANCE — sert la phrase d'explication sous le champ. */
  protected readonly dormantCount = computed(
    () => this.vehicleOptions().filter((o) => o.disabled && !o.horsService).length,
  );
  /** Nombre de véhicules grisés parce que déclarés HORS SERVICE. */
  protected readonly horsServiceCount = computed(
    () => this.vehicleOptions().filter((o) => o.disabled && !!o.horsService).length,
  );

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
      if (edit) {
        const meta = (edit.metadata ?? {}) as { reason?: string; retroactive?: boolean; criteria?: ReservationCriteria };
        this.startAt.set(toLocalInput(new Date(edit.startAt)));
        this.endAt.set(edit.endAt ? toLocalInput(new Date(edit.endAt)) : '');
        this.vehicleId.set(edit.vehicleId);
        this.reason.set(meta.reason ?? '');
        this.retroactive.set(meta.retroactive === true);
        this.minSeats.set(meta.criteria?.minSeats ? String(meta.criteria.minSeats) : '');
        this.childSeatsBaby.set(meta.criteria?.childSeatsBaby ? String(meta.criteria.childSeatsBaby) : '');
        this.childSeatsChild.set(meta.criteria?.childSeatsChild ? String(meta.criteria.childSeatsChild) : '');
        // Le groupe posé sur la réservation, tel quel — on n'y substitue pas celui du véhicule.
        const g = (edit.metadata as { group?: ReservationGroupDto | null } | null)?.group ?? null;
        this.groupTouched.set(true);
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
      this.minSeats.set(''); this.childSeatsBaby.set(''); this.childSeatsChild.set(''); this.reason.set('');
      this.retroactive.set(false);
      this.groupChoice.set(''); this.groupName.set(''); this.groupTouched.set(false); this.groupesValidation.set({});
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
      const g = this.vehicles().find((v) => v.id === id)?.group ?? null;
      this.groupChoice.set(g?.id ?? '');
      this.groupName.set('');
    });
    // Disponibilité des sièges auto sur le créneau saisi — relue à chaque changement de créneau
    // (ou de société), en mode demande et en mode édition. Best-effort : une lecture qui échoue
    // laisse simplement la ligne vide ; le serveur revalide de toute façon à l'envoi.
    effect(() => {
      const ouvert = this.open();
      const mode = this.mode();
      const s = this.startAt();
      const e = this.endAt();
      const fleetId = this.fleetFilter.selectedFleetId() ?? undefined;
      const edit = this.editReservation();
      const vehicleId = this.vehicleId() || undefined; // ses sièges à bord entrent dans le compte
      if (!ouvert || mode === 'validate' || !s || !e) { this.seatsAvail.set(null); return; }
      const si = new Date(s); const ei = new Date(e);
      if (Number.isNaN(si.getTime()) || Number.isNaN(ei.getTime()) || ei.getTime() <= si.getTime()) { this.seatsAvail.set(null); return; }
      if (this.needsFleet()) { this.seatsAvail.set(null); return; }
      void this.chargerSieges({ startAt: si.toISOString(), endAt: ei.toISOString(), fleetId, excludeId: mode === 'edit' ? edit?.id : undefined, vehicleId });
    });
  }

  /** Numéro de la dernière lecture partie : une réponse en retard ne doit pas écraser la dernière. */
  private siegesLecture = 0;
  private async chargerSieges(q: { startAt: string; endAt: string; fleetId?: string; excludeId?: string; vehicleId?: string }): Promise<void> {
    const n = ++this.siegesLecture;
    try {
      const a = await firstValueFrom(this.api.childSeatAvailability(q));
      if (n === this.siegesLecture) this.seatsAvail.set(a);
    } catch (e) {
      swallow('reservation-sheet:childSeats', e);
      if (n === this.siegesLecture) this.seatsAvail.set(null);
    }
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
      // Le groupe choisi sur la carte part avec la validation ('' = aucun groupe, explicitement).
      const choix = this.groupeValidation(g);
      const groupe = choix ? this.groupOptions().find((x) => x.id === choix) ?? null : null;
      for (const r of g.items) {
        await firstValueFrom(this.api.confirmReservation(r.id, { group: groupe ? { id: groupe.id, name: groupe.name } : null }));
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
    this.groupChoice.set(valeur);
    if (valeur !== GROUPE_AUTRE) this.groupName.set('');
  }

  /** Ce qui part au serveur : un groupe de la société (id), un nom libre, ou null (aucun). */
  private groupePayload(): ReservationGroupDto | null {
    const c = this.groupChoice();
    if (!c) return null;
    if (c === GROUPE_AUTRE) {
      const name = this.groupName().trim();
      return name ? { id: null, name } : null;
    }
    const g = this.groupOptions().find((x) => x.id === c);
    return g ? { id: g.id, name: g.name } : null;
  }

  /** Groupe affiché sur une carte de la file : choisi par le valideur, sinon celui du véhicule pré-retenu. */
  protected groupeValidation(g: { cle: string; items: VehicleEventDto[] }): string {
    const choisi = this.groupesValidation()[g.cle];
    if (choisi !== undefined) return choisi;
    const chef = g.items[0];
    if (!chef) return '';
    const pose = (chef.metadata as { group?: ReservationGroupDto | null } | null)?.group ?? null;
    if (pose?.id) return pose.id;
    return this.vehicles().find((v) => v.id === chef.vehicleId)?.group?.id ?? '';
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
    // Dates passées bloquées, sauf consignation d'une réservation déjà effectuée (le backend revalide).
    if (!this.retroactive() && new Date(si).getTime() < Date.now()) {
      this.reqError.set('Impossible de réserver dans le passé. Coche « réservation déjà effectuée » pour enregistrer une sortie déjà réalisée.');
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
        fleetId: this.fleetFilter.selectedFleetId() ?? undefined,
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
    this.reqError.set(null);
    if (this.needsFleet()) { this.reqError.set('Choisis une société dans le sélecteur en haut de page avant de réserver.'); return; }
    const slot = this.slot();
    if (!slot) return;
    this.submitting.set(true);
    try {
      const res = await firstValueFrom(this.api.requestReservation({
        vehicleId: this.vehicleId() || undefined,
        fleetId: this.fleetFilter.selectedFleetId() ?? undefined,
        startAt: slot.startAt,
        endAt: slot.endAt,
        reason: this.reason() || undefined,
        criteria: this.criteria(),
        retroactive: this.retroactive() || undefined,
        // Un gestionnaire choisit le groupe ; un simple demandeur laisse le serveur poser celui du véhicule.
        ...(this.canManage() && this.groupTouched() ? { group: this.groupePayload() } : {}),
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

  /** #4 — Enregistrer l'édition d'une réservation (créneau / véhicule / motif / critères). */
  protected async saveEdit(): Promise<void> {
    this.reqError.set(null);
    const edit = this.editReservation();
    if (!edit) return;
    const slot = this.slot();
    if (!slot) return;
    this.submitting.set(true);
    try {
      await firstValueFrom(this.api.updateReservation(edit.id, {
        startAt: slot.startAt,
        endAt: slot.endAt,
        reason: this.reason() || undefined,
        criteria: this.criteria(),
        vehicleId: this.vehicleId() || undefined,
        retroactive: this.retroactive() || undefined,
        group: this.groupePayload(),
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
          this.api.listReservations({ status: 'REQUESTED', fleetId: this.fleetFilter.selectedFleetId() ?? undefined }),
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
