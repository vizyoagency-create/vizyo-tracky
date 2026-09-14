import { swallow } from '../../core/error/swallow';
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  ArrowLeft, Bot, CalendarClock, Check, ChevronDown, ChevronUp, Copy, Eye, Link2, LucideAngularModule,
  Monitor, Pencil, Plus, Smartphone, Tablet, Trash2, UserCheck, X,
} from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type {
  BookingVisitEventDto, InstallationBookingDto, InstallationBookingLinkDto, InstallationBookingLinkVisitDto,
  InstallationBookingLinkVisitsDto, InstallationBookingStatus,
} from '@vizyo/tracky-shared';
import { FleetsApiService, type FleetSummary } from '../../core/services/fleets.service';
import { InstallationBookingApiService } from '../../core/services/installation-booking.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

const TZ = 'Europe/Paris';
const DAY_FMT = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });
const TIME_FMT = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const DATE_FMT = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' });

/** Jours ISO, dans l'ordre d'affichage. */
const JOURS: { iso: number; court: string; long: string }[] = [
  { iso: 1, court: 'L', long: 'lundi' }, { iso: 2, court: 'M', long: 'mardi' }, { iso: 3, court: 'M', long: 'mercredi' },
  { iso: 4, court: 'J', long: 'jeudi' }, { iso: 5, court: 'V', long: 'vendredi' }, { iso: 6, court: 'S', long: 'samedi' },
  { iso: 7, court: 'D', long: 'dimanche' },
];
const DUREES = [
  { minutes: 60, label: '1 h' }, { minutes: 90, label: '1 h 30' }, { minutes: 120, label: '2 h' },
  { minutes: 180, label: '3 h' }, { minutes: 240, label: '4 h' },
];

/** « 08:00 » ⇄ 480 (minutes depuis minuit). */
function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]); const mi = Number(m[2]);
  if (h > 24 || mi > 59) return null;
  return h * 60 + mi;
}
function toHHMM(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

/**
 * Prise de RDV en ligne — console admin (SUPER_ADMIN). 3 onglets : Demandes (valider /
 * refuser), Liens (créer / modifier / copier / désactiver, et LIRE LES VISITES), Agenda
 * (poses réservées par jour).
 */
@Component({
  selector: 'app-admin-installation-bookings',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, NgTemplateOutlet, RouterLink],
  template: `
    <div class="ib">
      <a routerLink="/admin" class="ib-back"><lucide-icon [img]="ArrowLeft" [size]="12"></lucide-icon> Administration</a>
      <div class="ib-head">
        <div>
          <h1>Réservations d'installation</h1>
          <p>Liens publics de prise de RDV, demandes de créneau et agenda des poses.</p>
        </div>
      </div>

      <div class="ib-tabs">
        <button [class.on]="tab() === 'requests'" (click)="tab.set('requests')">Demandes @if (pendingCount() > 0) { <span class="ib-badge">{{ pendingCount() }}</span> }</button>
        <button [class.on]="tab() === 'links'" (click)="tab.set('links')">Liens</button>
        <button [class.on]="tab() === 'agenda'" (click)="tab.set('agenda')">Agenda</button>
      </div>

      @if (loading()) { <div class="ib-loading">Chargement…</div> }

      <!-- ════════ DEMANDES ════════ -->
      @if (tab() === 'requests') {
        <div class="ib-filters">
          @for (f of statusFilters; track f.value) {
            <button class="ib-chip" [class.on]="statusFilter() === f.value" (click)="statusFilter.set(f.value)">{{ f.label }}</button>
          }
        </div>
        @if (filteredBookings().length === 0) {
          <div class="ib-empty">Aucune demande {{ statusLabel(statusFilter()) }}.</div>
        }
        @for (b of filteredBookings(); track b.id) {
          <div class="ib-card">
            <div class="ib-card-top">
              <div>
                <div class="ib-slot"><lucide-icon [img]="CalendarClock" [size]="14"></lucide-icon> {{ formatSlot(b.startAt, b.endAt) }}</div>
                <div class="ib-client">{{ b.clientName }} · <a href="mailto:{{ b.clientEmail }}">{{ b.clientEmail }}</a>@if (b.clientPhone) { · {{ b.clientPhone }} }</div>
                @if (b.vehiclePlate || b.vehicleBrand) { <div class="ib-meta">🚗 {{ b.vehiclePlate }}@if (b.vehicleBrand) { · {{ b.vehicleBrand }} {{ b.vehicleModel }} }</div> }
                @if (b.clientAddress) { <div class="ib-meta">📍 {{ b.clientAddress }}</div> }
                @if (b.notes) { <div class="ib-meta">💬 {{ b.notes }}</div> }
                <div class="ib-meta">Lien : {{ b.linkLabel }}</div>
              </div>
              <span class="ib-status ib-status--{{ b.status.toLowerCase() }}">{{ statusLabel(b.status) }}</span>
            </div>

            @if (b.status === 'PENDING') {
              @if (expandedId() === b.id && expandMode() === 'confirm') {
                <div class="ib-action">
                  <label class="ib-in-lbl">Plaque du véhicule (obligatoire)</label>
                  <input class="ib-in" [value]="plate()" (input)="plate.set($any($event.target).value)" placeholder="AB-123-CD">
                  <div class="ib-action-btns">
                    <button class="ib-btn ib-btn--ok" [disabled]="busy()" (click)="doConfirm(b)"><lucide-icon [img]="Check" [size]="14"></lucide-icon> Valider & créer la pose</button>
                    <button class="ib-btn ib-btn--ghost" (click)="collapse()">Annuler</button>
                  </div>
                </div>
              } @else if (expandedId() === b.id && expandMode() === 'reject') {
                <div class="ib-action">
                  <input class="ib-in" [value]="reason()" (input)="reason.set($any($event.target).value)" placeholder="Motif du refus (optionnel)">
                  <label class="ib-check"><input type="checkbox" [checked]="notify()" (change)="notify.set($any($event.target).checked)"> Prévenir le client par e-mail</label>
                  <div class="ib-action-btns">
                    <button class="ib-btn ib-btn--danger" [disabled]="busy()" (click)="doReject(b)">Confirmer le refus</button>
                    <button class="ib-btn ib-btn--ghost" (click)="collapse()">Annuler</button>
                  </div>
                </div>
              } @else {
                <div class="ib-action-btns">
                  <button class="ib-btn ib-btn--ok" (click)="openConfirm(b)"><lucide-icon [img]="Check" [size]="14"></lucide-icon> Valider</button>
                  <button class="ib-btn ib-btn--danger" (click)="openReject(b)"><lucide-icon [img]="X" [size]="14"></lucide-icon> Refuser</button>
                </div>
              }
            } @else if (b.status === 'REJECTED' && b.rejectionReason) {
              <div class="ib-meta">Motif : {{ b.rejectionReason }}</div>
            }
          </div>
        }
      }

      <!-- ════════ LIENS ════════ -->
      @if (tab() === 'links') {
        @if (createdUrl()) {
          <div class="ib-created">
            <div><strong>Lien créé !</strong> Copiez-le et envoyez-le au client.</div>
            <div class="ib-url"><code>{{ createdUrl() }}</code><button class="ib-copy" (click)="copy(createdUrl()!)"><lucide-icon [img]="Copy" [size]="13"></lucide-icon> Copier</button></div>
          </div>
        }

        @if (!editingId()) {
          <details class="ib-new" [open]="links().length === 0 || formOuvert()" (toggle)="formOuvert.set($any($event.target).open)">
            <summary><lucide-icon [img]="Plus" [size]="15"></lucide-icon> Nouveau lien de réservation</summary>
            <ng-container *ngTemplateOutlet="formulaire; context: { mode: 'create' }"></ng-container>
          </details>
        }

        @for (l of links(); track l.id) {
          <div class="ib-card" [class.off]="!l.active">
            @if (editingId() === l.id) {
              <div class="ib-slot"><lucide-icon [img]="Pencil" [size]="14"></lucide-icon> Modifier « {{ l.label }} »</div>
              <ng-container *ngTemplateOutlet="formulaire; context: { mode: 'edit' }"></ng-container>
            } @else {
              <div class="ib-card-top">
                <div class="ib-grow">
                  <div class="ib-slot"><lucide-icon [img]="Link2" [size]="14"></lucide-icon> {{ l.label }} @if (!l.active) { <span class="ib-off-tag">désactivé</span> } @if (l.singleUse) { <span class="ib-tag">usage unique</span> }</div>
                  <div class="ib-meta">{{ l.fleetName }} · {{ l.pendingCount }} en attente · {{ l.confirmedCount }} confirmé{{ l.confirmedCount > 1 ? 's' : '' }}@if (l.clientEmail) { · lien direct ({{ l.clientName || l.clientEmail }}) }</div>
                  <div class="ib-meta">{{ horairesLisibles(l) }}</div>
                  <div class="ib-meta ib-opens" [class.ib-opens--none]="l.visitCount === 0">
                    <lucide-icon [img]="Eye" [size]="13"></lucide-icon>
                    @if (l.visitCount === 0) {
                      Jamais ouvert par le client@if (l.robotVisitCount > 0) { · {{ l.robotVisitCount }} aperçu{{ l.robotVisitCount > 1 ? 's' : '' }} automatique{{ l.robotVisitCount > 1 ? 's' : '' }} }
                    } @else {
                      {{ l.visitCount }} visite{{ l.visitCount > 1 ? 's' : '' }} · dernière : {{ formatSlotShort(l.lastOpenedAt) }}@if (l.robotVisitCount > 0) { · {{ l.robotVisitCount }} robot{{ l.robotVisitCount > 1 ? 's' : '' }} }
                    }
                    <button type="button" class="ib-lien" (click)="toggleVisites(l)">
                      {{ visitesOuvertes() === l.id ? 'Masquer' : 'Voir le détail' }}
                      <lucide-icon [img]="visitesOuvertes() === l.id ? ChevronUp : ChevronDown" [size]="12"></lucide-icon>
                    </button>
                  </div>
                  @if (l.publicUrl) { <div class="ib-url"><code>{{ l.publicUrl }}</code><button class="ib-copy" (click)="copy(l.publicUrl!)"><lucide-icon [img]="Copy" [size]="13"></lucide-icon></button></div> }
                </div>
              </div>

              <!-- ─── Les visites : qui a ouvert le lien, quand, depuis quoi, et la suite ─── -->
              @if (visitesOuvertes() === l.id) {
                <div class="ib-visites">
                  @if (visitesChargement()) {
                    <div class="ib-loading ib-loading--inline">Chargement des visites…</div>
                  } @else if (visites(); as v) {
                    <div class="ib-visites-resume">
                      <span><strong>{{ v.humaines }}</strong> visite{{ v.humaines > 1 ? 's' : '' }}</span>
                      <span><strong>{{ v.avecReservation }}</strong> avec réservation</span>
                      @if (v.robots > 0) { <span class="ib-muted"><lucide-icon [img]="Bot" [size]="12"></lucide-icon> {{ v.robots }} aperçu{{ v.robots > 1 ? 's' : '' }} automatique{{ v.robots > 1 ? 's' : '' }} (WhatsApp, messagerie…)</span> }
                    </div>
                    @if (v.visites.length === 0) {
                      <div class="ib-empty ib-empty--inline">Personne n'a encore ouvert ce lien.</div>
                    }
                    @for (vis of v.visites; track vis.id) {
                      <div class="ib-visite" [class.ib-visite--robot]="vis.robot">
                        <div class="ib-visite-top">
                          <span class="ib-visite-ico"><lucide-icon [img]="iconeAppareil(vis)" [size]="15"></lucide-icon></span>
                          <div class="ib-grow">
                            <div class="ib-visite-l1">
                              <strong>{{ formatDateTime(vis.openedAt) }}</strong>
                              <span class="ib-dot">·</span> {{ appareilLisible(vis) }}
                              <span class="ib-dot">·</span> {{ vis.provenance }}
                              @if (vis.ipTruncated) { <span class="ib-dot">·</span> <span class="ib-mono">{{ vis.ipTruncated }}</span> }
                            </div>
                            <div class="ib-visite-l2">
                              @if (vis.robot) {
                                <span class="ib-tag ib-tag--muted"><lucide-icon [img]="Bot" [size]="11"></lucide-icon> aperçu automatique — pas le client</span>
                              } @else if (vis.contactEmail || vis.contactName) {
                                <span class="ib-tag" [class.ib-tag--sur]="vis.identitySource !== 'LIEN_DIRECT'">
                                  <lucide-icon [img]="UserCheck" [size]="11"></lucide-icon>
                                  {{ vis.contactName || vis.contactEmail }}@if (vis.contactName && vis.contactEmail) { · {{ vis.contactEmail }} }
                                  <em>{{ identiteLisible(vis) }}</em>
                                </span>
                              } @else {
                                <span class="ib-tag ib-tag--muted">visiteur non identifié</span>
                              }
                              @if (dureeVisite(vis); as d) { <span class="ib-muted">{{ d }}</span> }
                            </div>
                          </div>
                        </div>
                        @if (!vis.robot && vis.events.length > 1) {
                          <ol class="ib-chrono">
                            @for (ev of vis.events; track $index) {
                              @if (ev.type !== 'ouverture' || ev.target === 'rechargement') {
                                <li [class.ib-chrono--fort]="ev.type === 'reservation'" [class.ib-chrono--echec]="ev.type === 'reservation_echec'">
                                  <span class="ib-chrono-h">{{ timeOnly(ev.t) }}</span> {{ evenementLisible(ev) }}
                                </li>
                              }
                            }
                          </ol>
                        }
                      </div>
                    }
                  }
                </div>
              }

              <div class="ib-action-btns">
                <button class="ib-btn ib-btn--ghost" (click)="startEdit(l)"><lucide-icon [img]="Pencil" [size]="14"></lucide-icon> Modifier</button>
                <button class="ib-btn ib-btn--ghost" (click)="toggleLink(l)">{{ l.active ? 'Désactiver' : 'Réactiver' }}</button>
                <button class="ib-btn ib-btn--danger" (click)="deleteLink(l)"><lucide-icon [img]="Trash2" [size]="14"></lucide-icon> Supprimer</button>
              </div>
            }
          </div>
        }
      }

      <!-- ════════ AGENDA ════════ -->
      @if (tab() === 'agenda') {
        @if (agendaDays().length === 0) { <div class="ib-empty">Aucune pose réservée à venir.</div> }
        @for (day of agendaDays(); track day.date) {
          <div class="ib-agenda-day">
            <div class="ib-agenda-date">{{ day.label }}</div>
            @for (b of day.items; track b.id) {
              <div class="ib-agenda-row ib-agenda-row--{{ b.status.toLowerCase() }}">
                <span class="ib-agenda-time">{{ timeOnly(b.startAt) }}–{{ timeOnly(b.endAt) }}</span>
                <span class="ib-agenda-client">{{ b.clientName }}@if (b.vehiclePlate) { · {{ b.vehiclePlate }} }</span>
                <span class="ib-status ib-status--{{ b.status.toLowerCase() }}">{{ statusLabel(b.status) }}</span>
              </div>
            }
          </div>
        }
      }
    </div>

    <!-- ═══ Le formulaire d'un lien (création ET modification : mêmes réglages, même lecture) ═══ -->
    <ng-template #formulaire let-mode="mode">
      <div class="ib-form">
        @if (mode === 'create') {
          <label class="ib-f"><span>Société / flotte *</span>
            <select class="ib-in" (change)="fFleet.set($any($event.target).value)">
              <option value="" [selected]="!fFleet()">— choisir —</option>
              @for (fl of fleets(); track fl.id) { <option [value]="fl.id" [selected]="fl.id === fFleet()">{{ fl.name }}</option> }
            </select>
          </label>
        }
        <label class="ib-f" [class.ib-f--full]="mode !== 'create'"><span>Libellé (interne) *</span><input class="ib-in" [value]="fLabel()" (input)="fLabel.set($any($event.target).value)" placeholder="Ex. Pose flotte Dupont"></label>

        @if (mode === 'create') {
          <label class="ib-f ib-f--full"><span>E-mail du client (optionnel — « lien direct »)</span><input class="ib-in" [value]="fEmail()" (input)="fEmail.set($any($event.target).value)" placeholder="Si renseigné, la page ne redemandera pas l'e-mail"></label>
          @if (fEmail().trim()) {
            <label class="ib-f"><span>Nom du client</span><input class="ib-in" [value]="fName()" (input)="fName.set($any($event.target).value)"></label>
            <label class="ib-f"><span>Téléphone</span><input class="ib-in" [value]="fPhone()" (input)="fPhone.set($any($event.target).value)"></label>
            <label class="ib-f ib-f--full"><span>Adresse (lieu de pose)</span><input class="ib-in" [value]="fAddress()" (input)="fAddress.set($any($event.target).value)" placeholder="12 rue…, 31000 Toulouse"></label>
          }
        }

        <!-- ─── Créneaux ─── -->
        <div class="ib-f--full ib-section">Créneaux proposés</div>
        <label class="ib-f"><span>Durée d'un créneau</span>
          <!-- [selected] et non [value] sur le <select> : les options arrivent APRES le binding (@for). -->
          <select class="ib-in" (change)="fSlot.set(+$any($event.target).value)">
            @for (d of durees; track d.minutes) { <option [value]="d.minutes" [selected]="d.minutes === fSlot()">{{ d.label }}</option> }
          </select>
        </label>
        <div class="ib-f"><span>Jours ouverts</span>
          <div class="ib-jours">
            @for (j of jours; track j.iso) {
              <button type="button" class="ib-jour" [class.on]="fDays().has(j.iso)" [class.we]="j.iso >= 6" [attr.aria-label]="j.long" [attr.title]="j.long" (click)="toggleDay(j.iso)">{{ j.court }}</button>
            }
          </div>
        </div>
        <label class="ib-f"><span>Semaine — de</span><input class="ib-in" type="time" [value]="fStart()" (input)="fStart.set($any($event.target).value)"></label>
        <label class="ib-f"><span>Semaine — à</span><input class="ib-in" type="time" [value]="fEnd()" (input)="fEnd.set($any($event.target).value)"></label>

        @if (weekendCoche()) {
          <!--
            LE WEEK-END A SES HEURES. Un samedi d'installateur est une matinée : sans réglage
            propre, cocher le samedi promettait 08:00–21:00 comme un mardi.
          -->
          <label class="ib-check ib-f--full"><input type="checkbox" [checked]="fWeekendCustom()" (change)="fWeekendCustom.set($any($event.target).checked)"> Horaires différents le week-end</label>
          @if (fWeekendCustom()) {
            <label class="ib-f"><span>Week-end — de</span><input class="ib-in" type="time" [value]="fWeStart()" (input)="fWeStart.set($any($event.target).value)"></label>
            <label class="ib-f"><span>Week-end — à</span><input class="ib-in" type="time" [value]="fWeEnd()" (input)="fWeEnd.set($any($event.target).value)"></label>
          } @else {
            <div class="ib-f--full ib-hint">Le week-end suit les horaires de la semaine ({{ fStart() }} – {{ fEnd() }}).</div>
          }
        }

        <div class="ib-f--full ib-section">Fenêtre de réservation</div>
        <label class="ib-f"><span>Horizon (jours)</span><input class="ib-in" type="number" min="1" max="180" [value]="fHorizon()" (input)="fHorizon.set(+$any($event.target).value)"></label>
        <label class="ib-f"><span>Délai minimum (heures)</span><input class="ib-in" type="number" min="0" max="720" [value]="fLead()" (input)="fLead.set(+$any($event.target).value)"></label>
        <label class="ib-f"><span>Le lien expire le (optionnel)</span><input class="ib-in" type="date" [value]="fExpires()" (input)="fExpires.set($any($event.target).value)"></label>
        <label class="ib-check ib-f--align"><input type="checkbox" [checked]="fSingle()" (change)="fSingle.set($any($event.target).checked)"> Usage unique (se ferme après la 1ʳᵉ réservation)</label>

        <div class="ib-f--full ib-apercu">{{ apercuHoraires() }}</div>
        @if (createErr()) { <div class="ib-err ib-f--full">{{ createErr() }}</div> }
        @if (mode === 'create') {
          <button class="ib-btn ib-btn--ok ib-f--full" [disabled]="busy()" (click)="createLink()">Générer le lien</button>
        } @else {
          <div class="ib-action-btns ib-f--full">
            <button class="ib-btn ib-btn--ok" [disabled]="busy()" (click)="saveEdit()"><lucide-icon [img]="Check" [size]="14"></lucide-icon> Enregistrer</button>
            <button class="ib-btn ib-btn--ghost" (click)="cancelEdit()">Annuler</button>
          </div>
        }
      </div>
    </ng-template>
  `,
  styles: [`
    .ib { max-width:860px; }
    .ib-back { font-size:12px; color:var(--fg-tertiary,#69736E); display:inline-flex; align-items:center; gap:4px; text-decoration:none; margin-bottom:6px; }
    .ib-head h1 { margin:0; font-size:24px; font-weight:800; color:var(--fg-primary,#EAEFED); }
    .ib-head p { margin:2px 0 0; font-size:13px; color:var(--fg-tertiary,#9BA5A1); }
    .ib-tabs { display:flex; gap:6px; margin:20px 0 16px; border-bottom:1px solid var(--border-subtle,rgba(255,255,255,.08)); }
    .ib-tabs button { background:none; border:none; padding:10px 14px; font-size:14px; font-weight:600; color:var(--fg-tertiary,#69736E); cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-1px; display:inline-flex; align-items:center; gap:6px; }
    .ib-tabs button.on { color:var(--tracky,#10E0A0); border-bottom-color:var(--tracky,#10E0A0); }
    .ib-badge { background:#F5B33D; color:#3a2a06; border-radius:9px; font-size:11px; font-weight:800; padding:1px 7px; }
    .ib-filters { display:flex; gap:8px; margin-bottom:14px; flex-wrap:wrap; }
    .ib-chip { padding:6px 12px; border-radius:999px; border:1px solid var(--border-subtle,rgba(255,255,255,.1)); background:transparent; color:var(--fg-secondary,#9BA5A1); font-size:13px; cursor:pointer; }
    .ib-chip.on { background:var(--tracky,#10E0A0); color:#04130D; border-color:var(--tracky,#10E0A0); font-weight:700; }
    .ib-card { border:1px solid var(--border-subtle,rgba(255,255,255,.09)); border-radius:14px; padding:16px; margin-bottom:12px; background:var(--bg-secondary,#101514); }
    .ib-card.off { opacity:.6; }
    .ib-card-top { display:flex; justify-content:space-between; gap:12px; align-items:flex-start; }
    .ib-grow { flex:1; min-width:0; }
    .ib-slot { font-weight:700; font-size:15px; color:var(--fg-primary,#EAEFED); display:flex; align-items:center; gap:6px; text-transform:capitalize; flex-wrap:wrap; }
    .ib-client { font-size:13px; color:var(--fg-secondary,#9BA5A1); margin-top:5px; }
    .ib-client a { color:var(--tracky,#10E0A0); text-decoration:none; }
    .ib-meta { font-size:12.5px; color:var(--fg-tertiary,#69736E); margin-top:4px; }
    .ib-opens { display:inline-flex; align-items:center; gap:5px; color:var(--texte-succes); flex-wrap:wrap; }
    .ib-opens--none { color:var(--fg-tertiary,#69736E); }
    .ib-lien { background:none; border:none; padding:0 0 0 6px; color:var(--tracky,#10E0A0); font-size:12.5px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:3px; font-family:inherit; }
    .ib-status { font-size:11px; font-weight:700; padding:3px 9px; border-radius:999px; white-space:nowrap; }
    .ib-status--pending { background:rgba(245,179,61,.15); color:#F5B33D; }
    .ib-status--confirmed { background:color-mix(in srgb, var(--tracky-light) 15%, transparent); color:var(--texte-succes); }
    .ib-status--rejected { background:color-mix(in srgb, var(--danger) 15%, transparent); color:var(--texte-alerte); }
    .ib-status--cancelled { background:rgba(255,255,255,.08); color:#9BA5A1; }
    .ib-action { margin-top:12px; padding-top:12px; border-top:1px solid var(--border-subtle,rgba(255,255,255,.07)); }
    .ib-action-btns { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }
    .ib-btn { padding:9px 14px; border-radius:10px; border:1px solid transparent; font-size:13px; font-weight:600; cursor:pointer; display:inline-flex; align-items:center; gap:6px; font-family:inherit; }
    .ib-btn--ok { background:var(--tracky,#10E0A0); color:#04130D; }
    .ib-btn--danger { background:color-mix(in srgb, var(--danger) 12%, transparent); color:var(--texte-alerte); border-color:color-mix(in srgb, var(--danger) 30%, transparent); }
    .ib-btn--ghost { background:transparent; color:var(--fg-secondary,#9BA5A1); border-color:var(--border-subtle,rgba(255,255,255,.12)); }
    .ib-btn:disabled { opacity:.5; cursor:default; }
    .ib-in { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:10px; border:1px solid var(--border-subtle,rgba(255,255,255,.12)); background:var(--bg-primary,#0C1210); color:var(--fg-primary,#EAEFED); font-size:14px; font-family:inherit; color-scheme:dark; }
    .ib-in:focus { outline:none; border-color:var(--tracky,#10E0A0); }
    .ib-in-lbl { display:block; font-size:12px; color:var(--fg-secondary,#9BA5A1); margin-bottom:6px; }
    .ib-check { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--fg-secondary,#9BA5A1); margin-top:10px; cursor:pointer; }
    .ib-f--align { margin-top:0; align-self:end; padding-bottom:10px; }
    .ib-new { border:1px solid var(--border-subtle,rgba(255,255,255,.09)); border-radius:14px; padding:14px 16px; margin-bottom:16px; background:var(--bg-secondary,#101514); }
    .ib-new summary { font-weight:700; font-size:14px; color:var(--fg-primary,#EAEFED); cursor:pointer; display:flex; align-items:center; gap:8px; }
    .ib-form { display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-top:16px; }
    .ib-f { display:flex; flex-direction:column; gap:6px; }
    .ib-f--full { grid-column:1 / -1; }
    .ib-f span { font-size:12px; color:var(--fg-secondary,#9BA5A1); }
    .ib-section { font-size:11px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--fg-tertiary,#69736E); margin-top:8px; padding-top:12px; border-top:1px solid var(--border-subtle,rgba(255,255,255,.07)); }
    .ib-hint { font-size:12.5px; color:var(--fg-tertiary,#69736E); }
    .ib-apercu { font-size:13px; color:var(--fg-secondary,#9BA5A1); padding:10px 12px; border-radius:10px; background:var(--bg-primary,#0C1210); border:1px dashed var(--border-subtle,rgba(255,255,255,.12)); }
    .ib-jours { display:flex; gap:6px; }
    .ib-jour { width:38px; height:38px; border-radius:10px; border:1px solid var(--border-subtle,rgba(255,255,255,.12)); background:transparent; color:var(--fg-secondary,#9BA5A1); font-size:13px; font-weight:700; cursor:pointer; font-family:inherit; }
    .ib-jour.we { border-style:dashed; }
    .ib-jour.on { background:var(--tracky,#10E0A0); color:#04130D; border-color:var(--tracky,#10E0A0); border-style:solid; }
    .ib-created { border:1px solid rgba(16,224,160,.3); background:rgba(16,224,160,.08); border-radius:12px; padding:14px 16px; margin-bottom:16px; font-size:13px; color:var(--fg-secondary,#9BA5A1); }
    .ib-url { display:flex; align-items:center; gap:8px; margin-top:8px; flex-wrap:wrap; }
    .ib-url code { flex:1; min-width:180px; font-size:12px; background:var(--bg-primary,#0C1210); padding:8px 10px; border-radius:8px; color:var(--tracky,#10E0A0); word-break:break-all; }
    .ib-copy { padding:7px 11px; border-radius:8px; border:1px solid var(--border-subtle,rgba(255,255,255,.12)); background:transparent; color:var(--fg-secondary,#9BA5A1); font-size:12px; cursor:pointer; display:inline-flex; align-items:center; gap:5px; }
    .ib-off-tag { font-size:11px; color:var(--texte-alerte); font-weight:600; }
    .ib-tag { display:inline-flex; align-items:center; gap:5px; font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; background:rgba(255,255,255,.07); color:var(--fg-secondary,#9BA5A1); text-transform:none; }
    .ib-tag em { font-style:normal; opacity:.75; }
    .ib-tag--sur { background:color-mix(in srgb, var(--tracky-light) 15%, transparent); color:var(--texte-succes); }
    .ib-tag--muted { opacity:.8; }
    .ib-err { color:var(--texte-alerte); font-size:13px; }
    .ib-empty, .ib-loading { padding:28px; text-align:center; color:var(--fg-tertiary,#69736E); font-size:14px; }
    .ib-empty--inline, .ib-loading--inline { padding:14px; font-size:13px; }
    .ib-muted { color:var(--fg-tertiary,#69736E); display:inline-flex; align-items:center; gap:4px; }
    .ib-mono { font-family:ui-monospace, SFMono-Regular, Menlo, monospace; font-size:11.5px; }
    .ib-dot { opacity:.5; margin:0 2px; }

    /* Les visites */
    .ib-visites { margin-top:12px; padding-top:12px; border-top:1px solid var(--border-subtle,rgba(255,255,255,.07)); }
    .ib-visites-resume { display:flex; flex-wrap:wrap; gap:6px 16px; font-size:12.5px; color:var(--fg-secondary,#9BA5A1); margin-bottom:10px; }
    .ib-visites-resume strong { color:var(--fg-primary,#EAEFED); }
    .ib-visite { padding:10px 12px; border-radius:10px; background:var(--bg-primary,#0C1210); border:1px solid var(--border-subtle,rgba(255,255,255,.07)); margin-bottom:6px; }
    .ib-visite--robot { opacity:.55; }
    .ib-visite-top { display:flex; gap:10px; align-items:flex-start; }
    .ib-visite-ico { flex:0 0 auto; display:inline-flex; align-items:center; justify-content:center; width:30px; height:30px; border-radius:9px; background:rgba(255,255,255,.05); color:var(--fg-secondary,#9BA5A1); }
    .ib-visite-l1 { font-size:13px; color:var(--fg-secondary,#9BA5A1); }
    .ib-visite-l1 strong { color:var(--fg-primary,#EAEFED); }
    .ib-visite-l2 { display:flex; flex-wrap:wrap; gap:6px 10px; align-items:center; margin-top:5px; font-size:12px; }
    .ib-chrono { list-style:none; margin:8px 0 0 40px; padding:0; display:flex; flex-direction:column; gap:3px; font-size:12.5px; color:var(--fg-secondary,#9BA5A1); }
    .ib-chrono li { display:flex; gap:8px; align-items:baseline; }
    .ib-chrono-h { font-variant-numeric:tabular-nums; color:var(--fg-tertiary,#69736E); font-size:11.5px; min-width:38px; }
    .ib-chrono--fort { color:var(--texte-succes); font-weight:700; }
    .ib-chrono--echec { color:var(--texte-alerte); }

    .ib-agenda-day { margin-bottom:16px; }
    .ib-agenda-date { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:.06em; color:var(--fg-tertiary,#69736E); margin-bottom:8px; text-transform:capitalize; }
    .ib-agenda-row { display:flex; align-items:center; gap:12px; padding:10px 14px; border-radius:10px; background:var(--bg-secondary,#101514); border:1px solid var(--border-subtle,rgba(255,255,255,.07)); margin-bottom:6px; }
    .ib-agenda-row--pending { border-left:3px solid #F5B33D; }
    .ib-agenda-row--confirmed { border-left:3px solid #10E0A0; }
    .ib-agenda-time { font-variant-numeric:tabular-nums; font-weight:700; font-size:13px; color:var(--fg-primary,#EAEFED); }
    .ib-agenda-client { flex:1; font-size:13px; color:var(--fg-secondary,#9BA5A1); }
    @media (max-width:560px) { .ib-form { grid-template-columns:1fr; } .ib-chrono { margin-left:0; } }
  `],
})
export class AdminInstallationBookingsComponent implements OnInit {
  private readonly api = inject(InstallationBookingApiService);
  private readonly fleetsApi = inject(FleetsApiService);
  private readonly toast = inject(ToastService);

  protected readonly ArrowLeft = ArrowLeft; protected readonly CalendarClock = CalendarClock;
  protected readonly Check = Check; protected readonly X = X; protected readonly Copy = Copy;
  protected readonly Trash2 = Trash2; protected readonly Plus = Plus; protected readonly Link2 = Link2;
  protected readonly Eye = Eye; protected readonly Pencil = Pencil; protected readonly Bot = Bot;
  protected readonly ChevronDown = ChevronDown; protected readonly ChevronUp = ChevronUp; protected readonly UserCheck = UserCheck;

  protected readonly jours = JOURS;
  protected readonly durees = DUREES;

  protected readonly tab = signal<'requests' | 'links' | 'agenda'>('requests');
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly bookings = signal<InstallationBookingDto[]>([]);
  protected readonly links = signal<InstallationBookingLinkDto[]>([]);
  protected readonly fleets = signal<FleetSummary[]>([]);

  protected readonly statusFilter = signal<InstallationBookingStatus>('PENDING');
  protected readonly statusFilters = [
    { value: 'PENDING' as const, label: 'En attente' },
    { value: 'CONFIRMED' as const, label: 'Confirmées' },
    { value: 'REJECTED' as const, label: 'Refusées' },
  ];

  // Expansion valider/refuser
  protected readonly expandedId = signal<string | null>(null);
  protected readonly expandMode = signal<'confirm' | 'reject' | null>(null);
  protected readonly plate = signal('');
  protected readonly reason = signal('');
  protected readonly notify = signal(false);

  // Formulaire (création ET modification)
  protected readonly formOuvert = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly fFleet = signal(''); protected readonly fLabel = signal('');
  protected readonly fEmail = signal(''); protected readonly fName = signal(''); protected readonly fPhone = signal('');
  protected readonly fAddress = signal('');
  protected readonly fSlot = signal(120);
  protected readonly fDays = signal<Set<number>>(new Set([1, 2, 3, 4, 5]));
  protected readonly fStart = signal('08:00'); protected readonly fEnd = signal('21:00');
  protected readonly fWeekendCustom = signal(false);
  protected readonly fWeStart = signal('09:00'); protected readonly fWeEnd = signal('13:00');
  protected readonly fHorizon = signal(42); protected readonly fLead = signal(24);
  protected readonly fExpires = signal('');
  protected readonly fSingle = signal(false);
  protected readonly createErr = signal<string | null>(null);
  protected readonly createdUrl = signal<string | null>(null);

  // Visites
  protected readonly visitesOuvertes = signal<string | null>(null);
  protected readonly visites = signal<InstallationBookingLinkVisitsDto | null>(null);
  protected readonly visitesChargement = signal(false);

  protected readonly weekendCoche = computed(() => this.fDays().has(6) || this.fDays().has(7));
  protected readonly pendingCount = computed(() => this.bookings().filter((b) => b.status === 'PENDING').length);
  protected readonly filteredBookings = computed(() => this.bookings().filter((b) => b.status === this.statusFilter()));

  /** Ce que le client verra, dit en une phrase — avant de générer le lien. */
  protected readonly apercuHoraires = computed(() => {
    const jours = [...this.fDays()].sort((a, b) => a - b);
    if (jours.length === 0) return 'Aucun jour coché : le lien ne proposera aucun créneau.';
    const semaine = jours.filter((d) => d <= 5).map((d) => JOURS[d - 1].long);
    const we = jours.filter((d) => d >= 6).map((d) => JOURS[d - 1].long);
    const duree = DUREES.find((d) => d.minutes === this.fSlot())?.label ?? `${this.fSlot()} min`;
    const parts: string[] = [];
    if (semaine.length) parts.push(`${semaine.join(', ')} de ${this.fStart()} à ${this.fEnd()}`);
    if (we.length) {
      const h = this.fWeekendCustom() ? `${this.fWeStart()} à ${this.fWeEnd()}` : `${this.fStart()} à ${this.fEnd()}`;
      parts.push(`${we.join(' et ')} de ${h}`);
    }
    return `Créneaux de ${duree} — ${parts.join(' · ')} — sur ${this.fHorizon()} jours, au plus tôt ${this.fLead()} h après la demande.`;
  });

  protected readonly agendaDays = computed(() => {
    const items = this.bookings()
      .filter((b) => b.status === 'PENDING' || b.status === 'CONFIRMED')
      .filter((b) => new Date(b.endAt).getTime() > Date.now())
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
    const byDay = new Map<string, { date: string; label: string; items: InstallationBookingDto[] }>();
    for (const b of items) {
      const key = b.startAt.slice(0, 10);
      if (!byDay.has(key)) byDay.set(key, { date: key, label: DAY_FMT.format(new Date(b.startAt)), items: [] });
      byDay.get(key)!.items.push(b);
    }
    return [...byDay.values()];
  });

  async ngOnInit(): Promise<void> {
    await this.reload();
  }

  private async reload(): Promise<void> {
    this.loading.set(true);
    try {
      const [bookings, links, fleets] = await Promise.all([
        firstValueFrom(this.api.listBookings()),
        firstValueFrom(this.api.listLinks()),
        firstValueFrom(this.fleetsApi.list()),
      ]);
      this.bookings.set(bookings);
      this.links.set(links);
      this.fleets.set(fleets);
    } catch (err) {
      swallow('admin-installation-bookings:reload', err);
      this.toast.error('Chargement impossible', 'Réessayez.');
    } finally {
      this.loading.set(false);
    }
  }

  // ── Lecture ──
  protected statusLabel(s: InstallationBookingStatus): string {
    return { PENDING: 'en attente', CONFIRMED: 'confirmée', REJECTED: 'refusée', CANCELLED: 'annulée' }[s];
  }
  protected formatSlot(startAt: string, endAt: string): string {
    return `${DAY_FMT.format(new Date(startAt))}, ${TIME_FMT.format(new Date(startAt))} – ${TIME_FMT.format(new Date(endAt))}`;
  }
  protected timeOnly(iso: string): string { return TIME_FMT.format(new Date(iso)); }
  protected formatSlotShort(iso: string | null): string {
    return iso ? `${DAY_FMT.format(new Date(iso))} ${TIME_FMT.format(new Date(iso))}` : '—';
  }
  protected formatDateTime(iso: string): string {
    return `${DATE_FMT.format(new Date(iso))} ${TIME_FMT.format(new Date(iso))}`;
  }

  /** « lun.–ven. 08:00–21:00 · sam. 09:00–13:00 · créneaux 2 h · 42 j · délai 24 h ». */
  protected horairesLisibles(l: InstallationBookingLinkDto): string {
    const jours = [...l.workingDays].sort((a, b) => a - b);
    const semaine = jours.filter((d) => d <= 5);
    const we = jours.filter((d) => d >= 6);
    const nom = (d: number) => JOURS[d - 1].long.slice(0, 3) + '.';
    const plage = (a: number, b: number) => `${toHHMM(a)}–${toHHMM(b)}`;
    const parts: string[] = [];
    if (semaine.length) {
      const consecutifs = semaine.length === semaine[semaine.length - 1] - semaine[0] + 1;
      const lib = semaine.length > 1 && consecutifs ? `${nom(semaine[0])}–${nom(semaine[semaine.length - 1])}` : semaine.map(nom).join(', ');
      parts.push(`${lib} ${plage(l.dayStartMinutes, l.dayEndMinutes)}`);
    }
    if (we.length) {
      const custom = l.weekendStartMinutes != null && l.weekendEndMinutes != null;
      parts.push(`${we.map(nom).join(' + ')} ${custom ? plage(l.weekendStartMinutes!, l.weekendEndMinutes!) : plage(l.dayStartMinutes, l.dayEndMinutes)}`);
    }
    const duree = DUREES.find((d) => d.minutes === l.slotMinutes)?.label ?? `${l.slotMinutes} min`;
    parts.push(`créneaux ${duree}`, `${l.horizonDays} j`, `délai ${l.leadHours} h`);
    if (l.expiresAt) parts.push(`expire le ${DATE_FMT.format(new Date(l.expiresAt))}`);
    return parts.join(' · ');
  }

  protected iconeAppareil(v: InstallationBookingLinkVisitDto) {
    if (v.robot) return Bot;
    if (v.device === 'mobile') return Smartphone;
    if (v.device === 'tablet') return Tablet;
    return Monitor;
  }
  protected appareilLisible(v: InstallationBookingLinkVisitDto): string {
    const kind = { mobile: 'Téléphone', tablet: 'Tablette', desktop: 'Ordinateur' }[v.device ?? 'desktop'] ?? 'Appareil';
    const details = [v.os, v.browser].filter(Boolean).join(' · ');
    return details ? `${kind} (${details})` : v.device ? kind : 'Appareil inconnu';
  }
  protected identiteLisible(v: InstallationBookingLinkVisitDto): string {
    switch (v.identitySource) {
      case 'RESERVATION': return '— a réservé';
      case 'ABONNEMENT': return '— a demandé à être prévenu';
      case 'LIEN_DIRECT': return '— destinataire du lien (présumé)';
      default: return '';
    }
  }
  protected dureeVisite(v: InstallationBookingLinkVisitDto): string | null {
    const ms = new Date(v.lastSeenAt).getTime() - new Date(v.openedAt).getTime();
    if (ms < 15_000) return null;
    const min = Math.round(ms / 60_000);
    if (min < 1) return `${Math.round(ms / 1000)} s sur la page`;
    if (min < 90) return `${min} min sur la page`;
    return `revenu après ${Math.round(min / 60)} h`;
  }
  protected evenementLisible(ev: BookingVisitEventDto): string {
    const t = ev.target ?? '';
    switch (ev.type) {
      case 'ouverture': return t === 'rechargement' ? 'a rechargé les disponibilités' : 'a ouvert le lien';
      case 'jour': return `a regardé le ${this.jourLisible(t)}`;
      case 'creneau': return `a choisi ${t}`;
      case 'formulaire': return 'a commencé à remplir le formulaire';
      case 'decouverte':
        if (t === 'presentation') return 'a ouvert la présentation de Tracky';
        if (t === 'depot') return 'a ouvert la page « espace dépôt »';
        return `a ouvert la vidéo « ${this.videoLisible(t.replace(/^video:/, ''))} »`;
      case 'appel': return 'a appelé l\'atelier';
      case 'courriel':
        return { 'nouveau-lien': 'a demandé un nouveau lien par e-mail', creneau: 'a demandé un autre créneau par e-mail', question: 'a posé une question par e-mail' }[t] ?? 'a écrit un e-mail';
      case 'reservation': return `a réservé : ${t}`;
      case 'reservation_echec': return `réservation refusée (${t})`;
      case 'abonnement': return 'a demandé à être prévenu quand un créneau se libère';
      default: return ev.type;
    }
  }
  private jourLisible(date: string): string {
    const d = new Date(`${date}T12:00:00Z`);
    return Number.isNaN(d.getTime()) ? date : DATE_FMT.format(d);
  }
  private videoLisible(id: string): string {
    return { supervision: 'Supervision', analyse: 'Analyse', administration: 'Administration', depot: 'Espace dépôt' }[id] ?? id;
  }

  protected copy(url: string): void {
    navigator.clipboard?.writeText(url).then(
      () => this.toast.success('Lien copié'),
      () => this.toast.error('Copie impossible'),
    );
  }

  // ── Demandes ──
  protected openConfirm(b: InstallationBookingDto): void {
    this.expandedId.set(b.id); this.expandMode.set('confirm');
    this.plate.set(b.vehiclePlate ?? '');
  }
  protected openReject(b: InstallationBookingDto): void {
    this.expandedId.set(b.id); this.expandMode.set('reject'); this.reason.set(''); this.notify.set(false);
  }
  protected collapse(): void { this.expandedId.set(null); this.expandMode.set(null); }

  protected async doConfirm(b: InstallationBookingDto): Promise<void> {
    if (!this.plate().trim()) { this.toast.error('Plaque requise', 'Renseignez la plaque du véhicule.'); return; }
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.confirmBooking(b.id, { vehiclePlate: this.plate().trim() }));
      this.toast.success('Créneau validé', 'La pose a été ajoutée au planning et le client prévenu.');
      this.collapse();
      await this.reload();
    } catch (e) {
      swallow('admin-installation-bookings:doConfirm', e); this.toast.error('Validation impossible', this.errMsg(e)); }
    finally { this.busy.set(false); }
  }

  protected async doReject(b: InstallationBookingDto): Promise<void> {
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.rejectBooking(b.id, { reason: this.reason().trim() || undefined, notifyClient: this.notify() }));
      this.toast.success('Demande refusée', 'Le créneau est de nouveau disponible.');
      this.collapse();
      await this.reload();
    } catch (e) {
      swallow('admin-installation-bookings:doReject', e); this.toast.error('Refus impossible', this.errMsg(e)); }
    finally { this.busy.set(false); }
  }

  // ── Liens : formulaire ──
  protected toggleDay(iso: number): void {
    const next = new Set(this.fDays());
    if (next.has(iso)) next.delete(iso); else next.add(iso);
    this.fDays.set(next);
  }

  /** Les réglages d'horaires du formulaire, validés et convertis en minutes — ou une erreur lisible. */
  private lireHoraires(): { ok: true; valeurs: {
    slotMinutes: number; workingDays: number[]; dayStartMinutes: number; dayEndMinutes: number;
    weekendStartMinutes: number | null; weekendEndMinutes: number | null; horizonDays: number; leadHours: number;
    expiresAt: string | null;
  } } | { ok: false; erreur: string } {
    const jours = [...this.fDays()].sort((a, b) => a - b);
    if (jours.length === 0) return { ok: false, erreur: 'Cochez au moins un jour.' };
    const start = toMinutes(this.fStart()); const end = toMinutes(this.fEnd());
    if (start == null || end == null) return { ok: false, erreur: 'Horaires de semaine invalides.' };
    if (jours.some((d) => d <= 5) && end - start < this.fSlot()) return { ok: false, erreur: 'La plage de la semaine est plus courte qu\'un créneau.' };
    let weStart: number | null = null; let weEnd: number | null = null;
    if (this.weekendCoche() && this.fWeekendCustom()) {
      weStart = toMinutes(this.fWeStart()); weEnd = toMinutes(this.fWeEnd());
      if (weStart == null || weEnd == null) return { ok: false, erreur: 'Horaires de week-end invalides.' };
      if (weEnd - weStart < this.fSlot()) return { ok: false, erreur: 'La plage du week-end est plus courte qu\'un créneau.' };
    }
    const horizon = Math.min(180, Math.max(1, Math.round(this.fHorizon() || 42)));
    const lead = Math.min(720, Math.max(0, Math.round(this.fLead() || 0)));
    const expiresAt = this.fExpires() ? new Date(`${this.fExpires()}T23:59:59`).toISOString() : null;
    return { ok: true, valeurs: {
      slotMinutes: this.fSlot(), workingDays: jours, dayStartMinutes: start, dayEndMinutes: end,
      weekendStartMinutes: weStart, weekendEndMinutes: weEnd, horizonDays: horizon, leadHours: lead, expiresAt,
    } };
  }

  private resetForm(): void {
    this.fLabel.set(''); this.fEmail.set(''); this.fName.set(''); this.fPhone.set(''); this.fAddress.set('');
    this.fSlot.set(120); this.fDays.set(new Set([1, 2, 3, 4, 5])); this.fStart.set('08:00'); this.fEnd.set('21:00');
    this.fWeekendCustom.set(false); this.fWeStart.set('09:00'); this.fWeEnd.set('13:00');
    this.fHorizon.set(42); this.fLead.set(24); this.fExpires.set(''); this.fSingle.set(false);
    this.createErr.set(null);
  }

  protected async createLink(): Promise<void> {
    this.createErr.set(null);
    if (!this.fFleet()) { this.createErr.set('Choisissez une société.'); return; }
    if (!this.fLabel().trim()) { this.createErr.set('Donnez un libellé.'); return; }
    const horaires = this.lireHoraires();
    if (!horaires.ok) { this.createErr.set(horaires.erreur); return; }
    this.busy.set(true);
    try {
      const direct = !!this.fEmail().trim();
      const link = await firstValueFrom(this.api.createLink({
        fleetId: this.fFleet(),
        label: this.fLabel().trim(),
        clientEmail: this.fEmail().trim() || undefined,
        clientName: direct ? (this.fName().trim() || undefined) : undefined,
        clientPhone: direct ? (this.fPhone().trim() || undefined) : undefined,
        clientAddress: direct ? (this.fAddress().trim() || undefined) : undefined,
        singleUse: this.fSingle(),
        ...horaires.valeurs,
      }));
      this.createdUrl.set(link.publicUrl ?? null);
      this.resetForm();
      this.formOuvert.set(false);
      await this.reload();
      this.toast.success('Lien créé', 'Copiez-le et envoyez-le au client.');
    } catch (e) {
      swallow('admin-installation-bookings:createLink', e); this.createErr.set(this.errMsg(e)); }
    finally { this.busy.set(false); }
  }

  protected startEdit(l: InstallationBookingLinkDto): void {
    this.visitesOuvertes.set(null);
    this.editingId.set(l.id);
    this.createErr.set(null);
    this.fLabel.set(l.label);
    this.fSlot.set(DUREES.some((d) => d.minutes === l.slotMinutes) ? l.slotMinutes : 120);
    this.fDays.set(new Set(l.workingDays));
    this.fStart.set(toHHMM(l.dayStartMinutes)); this.fEnd.set(toHHMM(l.dayEndMinutes));
    const custom = l.weekendStartMinutes != null && l.weekendEndMinutes != null;
    this.fWeekendCustom.set(custom);
    this.fWeStart.set(custom ? toHHMM(l.weekendStartMinutes!) : '09:00');
    this.fWeEnd.set(custom ? toHHMM(l.weekendEndMinutes!) : '13:00');
    this.fHorizon.set(l.horizonDays); this.fLead.set(l.leadHours);
    this.fExpires.set(l.expiresAt ? l.expiresAt.slice(0, 10) : '');
    this.fSingle.set(l.singleUse);
  }
  protected cancelEdit(): void {
    this.editingId.set(null);
    this.resetForm();
  }
  protected async saveEdit(): Promise<void> {
    const id = this.editingId();
    if (!id) return;
    this.createErr.set(null);
    if (!this.fLabel().trim()) { this.createErr.set('Donnez un libellé.'); return; }
    const horaires = this.lireHoraires();
    if (!horaires.ok) { this.createErr.set(horaires.erreur); return; }
    this.busy.set(true);
    try {
      await firstValueFrom(this.api.updateLink(id, { label: this.fLabel().trim(), singleUse: this.fSingle(), ...horaires.valeurs }));
      this.editingId.set(null);
      this.resetForm();
      await this.reload();
      this.toast.success('Lien modifié', 'Les nouveaux horaires s\'appliquent dès maintenant sur la page publique.');
    } catch (e) {
      swallow('admin-installation-bookings:saveEdit', e); this.createErr.set(this.errMsg(e)); }
    finally { this.busy.set(false); }
  }

  protected async toggleLink(l: InstallationBookingLinkDto): Promise<void> {
    try {
      await firstValueFrom(this.api.updateLink(l.id, { active: !l.active }));
      await this.reload();
    } catch (e) {
      swallow('admin-installation-bookings:toggleLink', e); this.toast.error('Action impossible', this.errMsg(e)); }
  }

  protected async deleteLink(l: InstallationBookingLinkDto): Promise<void> {
    if (!confirm(`Supprimer le lien « ${l.label} » ? Les demandes déjà reçues sont conservées ; l'historique des visites est effacé.`)) return;
    try {
      await firstValueFrom(this.api.deleteLink(l.id));
      if (this.createdUrl() === l.publicUrl) this.createdUrl.set(null);
      if (this.visitesOuvertes() === l.id) this.visitesOuvertes.set(null);
      await this.reload();
      this.toast.success('Lien supprimé');
    } catch (e) {
      swallow('admin-installation-bookings:deleteLink', e); this.toast.error('Suppression impossible', this.errMsg(e)); }
  }

  // ── Visites ──
  protected async toggleVisites(l: InstallationBookingLinkDto): Promise<void> {
    if (this.visitesOuvertes() === l.id) { this.visitesOuvertes.set(null); return; }
    this.visitesOuvertes.set(l.id);
    this.visites.set(null);
    this.visitesChargement.set(true);
    try {
      this.visites.set(await firstValueFrom(this.api.listVisites(l.id)));
    } catch (e) {
      swallow('admin-installation-bookings:visites', e);
      this.toast.error('Visites indisponibles', this.errMsg(e));
      this.visitesOuvertes.set(null);
    } finally {
      this.visitesChargement.set(false);
    }
  }

  private errMsg(e: unknown): string {
    const m = (e as { error?: { message?: string } })?.error?.message;
    return typeof m === 'string' ? m : 'Une erreur est survenue.';
  }
}
