import { swallow } from '../../core/error/swallow';
import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { firstValueFrom } from 'rxjs';
import { FormsModule } from '@angular/forms';
import {
  LucideAngularModule, CalendarClock, Mail, Send, Save, ChevronDown, ChevronUp, Check, X, AlertTriangle, Clock, Loader, Plus,
} from 'lucide-angular';
import type { FleetReportDispatchDto, FleetReportScheduleDto, FleetReportSection } from '@vizyo/tracky-shared';
import type { VehicleDetailDto } from '../../core/services/vehicles.service';
import { ActivityTrackerService } from '../../core/services/activity-tracker.service';
import { ReportsApiService } from '../../core/services/reports.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { apiErrorMessage } from '../../core/error/api-error';

const WEEKDAYS = [
  { value: 1, label: 'Lundi' }, { value: 2, label: 'Mardi' }, { value: 3, label: 'Mercredi' }, { value: 4, label: 'Jeudi' },
  { value: 5, label: 'Vendredi' }, { value: 6, label: 'Samedi' }, { value: 7, label: 'Dimanche' },
];
const SECTIONS: { key: FleetReportSection; label: string; hint: string }[] = [
  { key: 'kpi', label: 'Indicateurs clés', hint: 'distance, durée, vitesses, conso estimée' },
  { key: 'alerts', label: 'Alertes', hint: 'total, par type et par gravité' },
  { key: 'topVehicles', label: 'Top véhicules', hint: 'classement par kilomètres' },
  { key: 'trips', label: 'Trajets détaillés', hint: 'date, plaque, durée, distance, conducteur' },
];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * Rapport hebdomadaire par e-mail — carte de réglage sur la page Rapports (admins).
 *
 * Ce que la société voit : quand part le prochain rapport (« dans 4 jours »), ce qu'il
 * contiendra, à qui il ira, et ce qui s'est passé pour les précédents. Ce qu'elle règle :
 * jour, heure (Paris), destinataires, sections, périmètre véhicules. Un bouton envoie le
 * rapport des 7 derniers jours tout de suite — pour vérifier sans attendre lundi.
 */
@Component({
  selector: 'app-report-schedule-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, FormsModule, DatePipe],
  template: `
    <section class="rsc" aria-labelledby="rsc-title">
      <header class="rsc-head">
        <div class="rsc-head-main">
          <span class="rsc-icon"><lucide-icon [img]="CalendarIcon" [size]="18"></lucide-icon></span>
          <div class="rsc-head-text">
            <h2 id="rsc-title">Rapport hebdomadaire par e-mail</h2>
            @if (needsFleetChoice()) {
              <p class="rsc-next rsc-next--off">Choisissez une société dans le sélecteur, en haut de l'écran, pour régler son rapport hebdomadaire — ou lisez la vue d'ensemble ci-dessous.</p>
            } @else if (schedule(); as s) {
              @if (s.enabled) {
                <p class="rsc-next">
                  <strong>Prochain rapport {{ nextIn() }}</strong>
                  <span> · {{ s.nextDueAt | date:'EEEE d MMM' }} à {{ s.nextDueAt | date:'HH:mm' }} · période du {{ periodFromLabel() }} au {{ periodToLabel() }}</span>
                  <span class="rsc-fleet"> · {{ s.fleetName }}</span>
                </p>
              } @else {
                <p class="rsc-next rsc-next--off">Envoi automatique désactivé pour {{ s.fleetName }} — personne ne reçoit ce rapport.</p>
              }
              @if (!editable()) {
                <p class="rsc-readonly">Lecture seule : le droit d'export des rapports est nécessaire pour modifier ce réglage.</p>
              }
            } @else if (loading()) {
              <p class="rsc-next">Chargement du réglage…</p>
            } @else if (loadError(); as e) {
              <p class="rsc-next rsc-next--off">{{ e }}</p>
            }
          </div>
        </div>
        @if (schedule() && editable()) {
          <label class="rsc-switch" [class.rsc-switch--on]="enabled()">
            <input type="checkbox" [checked]="enabled()" (change)="basculerActif()" [attr.aria-label]="enabled() ? 'Désactiver l’envoi automatique' : 'Activer l’envoi automatique'" />
            <span class="rsc-switch-track"><span class="rsc-switch-knob"></span></span>
            <span class="rsc-switch-label">{{ enabled() ? 'Actif' : 'Coupé' }}</span>
          </label>
        } @else if (schedule()) {
          <span class="rsc-etat" [class.rsc-etat--on]="enabled()">{{ enabled() ? 'Actif' : 'Coupé' }}</span>
        }
      </header>

      <!-- ══ VUE D'ENSEMBLE : TOUTES LES SOCIÉTÉS ═══════════════════════════════════
           Le réglage ne se lisait QUE société par société : pour savoir si le rapport d'un
           client était coupé, il fallait le sélectionner, attendre, lire, recommencer.
           Personne ne fait ça pour vingt sociétés — donc un rapport coupé, ou dont l'envoi
           échoue chaque semaine, se découvrait par hasard, souvent parce que le client
           finissait par le signaler. -->
      @if (needsFleetChoice()) {
        @if (vueLoading()) {
          <p class="rsc-next">Chargement de la vue d'ensemble…</p>
        } @else if (vueErreur(); as e) {
          <p class="rsc-next rsc-next--off">{{ e }}</p>
        } @else if (vue().length > 0) {
          <div class="rsc-vue">
            <div class="rsc-vue-tete">
              <span>Société</span><span>État</span><span>Envoi</span>
              <span>Destinataires</span><span>Dernier envoi</span>
            </div>
            @for (r of vue(); track r.fleetId) {
              <div class="rsc-vue-ligne" [class.rsc-vue-ligne--coupee]="!r.enabled">
                <span class="rsc-vue-societe">{{ r.fleetName }}</span>
                <span>
                  @if (r.enabled) { <b class="rsc-vue-on">Actif</b> }
                  @else { <b class="rsc-vue-off">Coupé</b> }
                  <!-- ⚠️ « Par défaut » distingue un réglage CHOISI d'un réglage jamais
                       touché : le second peut changer avec le produit, le premier non. -->
                  @if (r.isDefault) { <small> (par défaut)</small> }
                </span>
                <span>{{ jourCourt(r.weekday) }} {{ r.hour }}h</span>
                <span class="rsc-vue-dest">
                  @if (r.effectiveRecipients.length === 0) {
                    <b class="rsc-vue-off">personne</b>
                  } @else {
                    {{ r.effectiveRecipients.length }}
                    @if (r.recipients.length === 0) { <small> (admins)</small> }
                  }
                </span>
                <span>
                  @if (!r.lastRunAt) { <small>jamais</small> }
                  @else if (r.lastStatus === 'FAILED') { <b class="rsc-vue-off">échec {{ r.lastRunAt | date:'d MMM' }}</b> }
                  @else if (r.lastStatus === 'SKIPPED') { <small>{{ r.lastRunAt | date:'d MMM' }} — rien à envoyer</small> }
                  @else { {{ r.lastRunAt | date:'d MMM' }} }
                </span>
              </div>
            }
          </div>
        }
      }

      @if (schedule(); as s) {
        <!-- Dernier passage : la réponse à « je n'ai rien reçu » sans ouvrir les journaux. -->
        @if (s.lastRunAt) {
          <p class="rsc-last" [attr.data-status]="s.lastStatus ?? 'none'">
            @if (s.lastStatus === 'SENT') { <lucide-icon [img]="CheckIcon" [size]="13"></lucide-icon> Dernier envoi le {{ s.lastRunAt | date:'d MMM à HH:mm' }} }
            @else if (s.lastStatus === 'SKIPPED') { <lucide-icon [img]="ClockIcon" [size]="13"></lucide-icon> Dernier passage le {{ s.lastRunAt | date:'d MMM' }} — rien envoyé : {{ s.lastError }} }
            @else if (s.lastStatus === 'FAILED') { <lucide-icon [img]="AlertIcon" [size]="13"></lucide-icon> Échec le {{ s.lastRunAt | date:'d MMM à HH:mm' }} — {{ s.lastError }} }
            @else {
              <!-- Passage enregistré SANS issue : le tout premier, celui qui refuse de rattraper
                   une échéance antérieure au réglage. Ce n'est ni un envoi ni un échec, et
                   l'afficher comme « Échec — » (sans raison) faisait peur pour rien. -->
              <lucide-icon [img]="ClockIcon" [size]="13"></lucide-icon>
              Aucun envoi encore — le premier partira à la prochaine échéance
            }
          </p>
        } @else {
          <p class="rsc-last" data-status="none"><lucide-icon [img]="ClockIcon" [size]="13"></lucide-icon> Aucun envoi enregistré pour l'instant.</p>
        }

        <div class="rsc-grid">
          <!-- Quand -->
          <fieldset class="rsc-field">
            <legend>Quand</legend>
            <div class="rsc-when">
              <label class="rsc-sel">
                <span>Jour</span>
                <select [ngModel]="weekday()" (ngModelChange)="weekday.set(+$event); markDirty()" [disabled]="verrouille()">
                  @for (d of weekdays; track d.value) { <option [ngValue]="d.value">{{ d.label }}</option> }
                </select>
              </label>
              <label class="rsc-sel">
                <span>Heure (Paris)</span>
                <select [ngModel]="hour()" (ngModelChange)="hour.set(+$event); markDirty()" [disabled]="verrouille()">
                  @for (h of hours; track h) { <option [ngValue]="h">{{ heureLabel(h) }}</option> }
                </select>
              </label>
            </div>
            <p class="rsc-hint">Couvre les 7 jours qui précèdent le jour d'envoi.</p>
          </fieldset>

          <!-- À qui -->
          <fieldset class="rsc-field">
            <legend>À qui</legend>
            <div class="rsc-chips">
              @for (r of recipients(); track r) {
                <span class="rsc-chip">
                  {{ r }}
                  <button type="button" class="rsc-chip-x" (click)="removeRecipient(r)" [attr.aria-label]="'Retirer ' + r" [disabled]="verrouille()"><lucide-icon [img]="XIcon" [size]="12"></lucide-icon></button>
                </span>
              }
              @if (recipients().length === 0) {
                <span class="rsc-chip rsc-chip--auto" title="Les administrateurs actifs de la société reçoivent le rapport tant qu'aucune adresse n'est ajoutée.">
                  <lucide-icon [img]="MailIcon" [size]="12"></lucide-icon>
                  Administrateurs de la société ({{ s.effectiveRecipients.length }})
                </span>
              }
            </div>
            <div class="rsc-add">
              <input type="email" [(ngModel)]="newRecipient" (keydown.enter)="addRecipient(); $event.preventDefault()" placeholder="Ajouter une adresse" [disabled]="verrouille()" aria-label="Adresse e-mail à ajouter" />
              <button type="button" class="rsc-btn rsc-btn--ghost rsc-btn--sm" (click)="addRecipient()" [disabled]="verrouille() || !newRecipient.trim()">
                <lucide-icon [img]="PlusIcon" [size]="14"></lucide-icon> Ajouter
              </button>
            </div>
            @if (recipientError(); as e) { <p class="rsc-err">{{ e }}</p> }
            @if (recipients().length === 0 && s.effectiveRecipients.length === 0) {
              <p class="rsc-err">Aucun administrateur actif : ajoutez une adresse, sinon rien ne partira.</p>
            }
          </fieldset>

          <!-- Quoi -->
          <fieldset class="rsc-field">
            <legend>Contenu du PDF</legend>
            <div class="rsc-options">
              @for (sec of sectionDefs; track sec.key) {
                <label class="rsc-opt" [class.rsc-opt--on]="sections().has(sec.key)">
                  <input type="checkbox" [checked]="sections().has(sec.key)" (change)="toggleSection(sec.key)" [disabled]="verrouille()" />
                  <span class="rsc-opt-text"><b>{{ sec.label }}</b><small>{{ sec.hint }}</small></span>
                </label>
              }
            </div>
            @if (sections().size === 0) { <p class="rsc-err">Choisissez au moins une section.</p> }
          </fieldset>

          <!-- Quels véhicules -->
          <fieldset class="rsc-field">
            <legend>Véhicules</legend>
            <div class="rsc-scope">
              <button type="button" class="rsc-pill" [class.rsc-pill--on]="vehicleIds().size === 0" (click)="toutLesVehicules()" [disabled]="verrouille()">
                Tous <span class="rsc-pill-n">{{ vehicles().length }}</span>
              </button>
              <button type="button" class="rsc-pill" [class.rsc-pill--on]="vehicleIds().size > 0" (click)="startSelection()" [disabled]="verrouille() || vehicles().length === 0">
                Sélection <span class="rsc-pill-n">{{ vehicleIds().size }}</span>
              </button>
            </div>
            @if (vehicleIds().size > 0 || selecting()) {
              <div class="rsc-vlist" role="group" aria-label="Véhicules inclus dans le rapport">
                @for (v of vehicles(); track v.id) {
                  <label class="rsc-vrow">
                    <input type="checkbox" [checked]="vehicleIds().has(v.id)" (change)="toggleVehicle(v.id)" [disabled]="verrouille()" />
                    <span class="rsc-vplate">{{ v.plate }}</span>
                    <span class="rsc-vmodel">{{ v.brand }} {{ v.model }}</span>
                  </label>
                }
              </div>
            }
          </fieldset>
        </div>

        <footer class="rsc-foot">
          <div class="rsc-foot-actions">
            @if (editable()) {
              <button type="button" class="rsc-btn rsc-btn--primary" (click)="save()" [disabled]="saving() || !dirty() || !valid()">
                @if (saving()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="rsc-spin"></lucide-icon> Enregistrement… }
                @else { <lucide-icon [img]="SaveIcon" [size]="14"></lucide-icon> Enregistrer }
              </button>
              <!-- Grisé aussi quand l'envoi automatique est coupé : le serveur refuse (409,
                   design/C3 point 2) — le bouton ne contourne plus l'interrupteur. -->
              <button type="button" class="rsc-btn rsc-btn--ghost" (click)="sendNow()" [disabled]="sending() || dirty() || !enabled()" [title]="titreEnvoi()">
                @if (sending()) { <lucide-icon [img]="LoaderIcon" [size]="14" class="rsc-spin"></lucide-icon> Envoi… }
                @else { <lucide-icon [img]="SendIcon" [size]="14"></lucide-icon> Envoyer maintenant }
              </button>
            }
          </div>
          <button type="button" class="rsc-link" (click)="toggleHistory()" [attr.aria-expanded]="historyOpen()">
            Historique des envois
            <lucide-icon [img]="historyOpen() ? ChevronUpIcon : ChevronDownIcon" [size]="14"></lucide-icon>
          </button>
        </footer>

        @if (historyOpen()) {
          <div class="rsc-history">
            @if (historyLoading()) { <p class="rsc-hint">Chargement…</p> }
            @else if (dispatches().length === 0) { <p class="rsc-hint">Aucun envoi pour l'instant.</p> }
            @else {
              <ul class="rsc-hlist">
                @for (d of dispatches(); track d.id) {
                  <li class="rsc-hrow" [attr.data-status]="d.status">
                    <span class="rsc-hdate">{{ d.createdAt | date:'d MMM HH:mm' }}</span>
                    <span class="rsc-hstatus">
                      @if (d.status === 'SENT') { Envoyé } @else if (d.status === 'SKIPPED') { Sans objet } @else { Échec }
                      <small>{{ d.trigger === 'manual' ? 'manuel' : 'automatique' }}@if (d.requestedByName) { · {{ d.requestedByName }} }</small>
                    </span>
                    <span class="rsc-hdetail">
                      du {{ d.periodFrom | date:'d/MM' }} au {{ d.periodTo | date:'d/MM' }} · {{ d.tripsCount }} trajets
                      @if (d.recipients.length) { · {{ d.recipients.length }} destinataire{{ d.recipients.length > 1 ? 's' : '' }} }
                      @if (d.error) { <em>— {{ d.error }}</em> }
                    </span>
                  </li>
                }
              </ul>
            }
          </div>
        }
      }
    </section>
  `,
  styles: [`
    :host { display: block; }
    .rsc {
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: var(--radius-card, 16px);
      padding: 16px; display: flex; flex-direction: column; gap: 14px;
    }
    .rsc-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .rsc-head-main { display: flex; align-items: flex-start; gap: 12px; min-width: 0; flex: 1 1 260px; }
    .rsc-icon { width: 36px; height: 36px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
      background: color-mix(in srgb, var(--tracky-light, #10E0A0) 14%, transparent); color: var(--texte-succes); }
    .rsc-head-text { min-width: 0; }
    .rsc-head-text h2 { margin: 0; font-size: 15px; font-weight: 800; color: var(--fg-primary); }
    .rsc-next { margin: 3px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--fg-secondary); }
    .rsc-next strong { color: var(--texte-succes); font-weight: 800; }
    .rsc-next--off { color: var(--texte-attente); font-weight: 600; }
    .rsc-fleet { font-weight: 700; color: var(--fg-primary); }
    .rsc-vue { margin-top: 12px; border: 1px solid var(--border-subtle); border-radius: 12px; overflow: hidden; }
    .rsc-vue-tete, .rsc-vue-ligne {
      display: grid; grid-template-columns: minmax(120px, 1.6fr) .9fr .8fr .9fr 1fr;
      gap: 10px; padding: 8px 12px; align-items: center; font-size: 12.5px;
    }
    .rsc-vue-tete {
      background: var(--surface-rail); border-bottom: 1px solid var(--border-subtle);
      font-size: 10.5px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase; color: var(--fg-tertiary);
    }
    .rsc-vue-ligne { border-top: 1px solid var(--border-subtle); color: var(--fg-secondary); }
    .rsc-vue-ligne:first-of-type { border-top: none; }
    .rsc-vue-societe { font-weight: 700; color: var(--fg-primary); }
    /* ⚠️ La couleur ne porte pas l'information : « Actif » et « Coupé » sont écrits. */
    .rsc-vue-on { color: var(--texte-succes); }
    .rsc-vue-off { color: var(--texte-alerte); }
    .rsc-vue-ligne--coupee { background: color-mix(in srgb, var(--texte-alerte) 5%, transparent); }
    .rsc-vue small { color: var(--fg-tertiary); }
    @media (max-width: 720px) {
      .rsc-vue-tete { display: none; }
      .rsc-vue-ligne { grid-template-columns: 1fr 1fr; gap: 4px 10px; }
    }
    .rsc-readonly { margin: 4px 0 0; font-size: 11.5px; color: var(--fg-tertiary); }
    /* État en lecture seule : même information que l'interrupteur, sans laisser croire qu'on peut agir. */
    .rsc-etat { display: inline-flex; align-items: center; padding: 5px 11px; border-radius: 999px; font-size: 12.5px; font-weight: 700;
      background: var(--bg-tertiary); color: var(--fg-tertiary); border: 1px solid var(--border-subtle); }
    .rsc-etat--on { background: color-mix(in srgb, var(--tracky-light, #10E0A0) 14%, transparent); color: var(--texte-succes); border-color: transparent; }

    /* Interrupteur — 44 px de haut au doigt, libellé explicite. */
    .rsc-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; min-height: 44px; user-select: none; }
    .rsc-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .rsc-switch-track { width: 42px; height: 24px; border-radius: 999px; background: var(--bg-tertiary); border: 1px solid var(--border-strong, var(--border-subtle)); position: relative; transition: background .15s; }
    .rsc-switch-knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--fg-tertiary); transition: transform .15s, background .15s; }
    .rsc-switch--on .rsc-switch-track { background: var(--tracky, #10E0A0); border-color: transparent; }
    .rsc-switch--on .rsc-switch-knob { transform: translateX(18px); background: var(--accent-ink, #04130D); }
    .rsc-switch input:focus-visible + .rsc-switch-track { outline: 2px solid var(--tracky-light, #10E0A0); outline-offset: 2px; }
    .rsc-switch-label { font-size: 12.5px; font-weight: 700; color: var(--fg-secondary); }

    .rsc-last { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-tertiary); }
    .rsc-last[data-status="SENT"] { color: var(--texte-succes); }
    .rsc-last[data-status="FAILED"] { color: var(--texte-alerte); }
    .rsc-last[data-status="SKIPPED"] { color: var(--texte-attente); }

    .rsc-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 900px) { .rsc-grid { grid-template-columns: 1fr 1fr; } }
    .rsc-field { margin: 0; padding: 12px; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-tertiary); min-width: 0; }
    .rsc-field legend { padding: 0 6px; font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-tertiary); }
    .rsc-hint { margin: 8px 0 0; font-size: 11.5px; color: var(--fg-tertiary); }
    .rsc-err { margin: 8px 0 0; font-size: 11.5px; font-weight: 600; color: var(--texte-alerte); }

    .rsc-when { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .rsc-sel { display: flex; flex-direction: column; gap: 4px; font-size: 11.5px; color: var(--fg-tertiary); font-weight: 600; }
    .rsc-sel select { min-height: 44px; padding: 8px 10px; border-radius: 10px; background: var(--bg-secondary); color: var(--fg-primary); border: 1px solid var(--border-subtle); font-size: 13px; font-weight: 600; }
    .rsc-sel select:disabled { opacity: .55; }

    .rsc-chips { display: flex; flex-wrap: wrap; gap: 6px; }
    .rsc-chip { display: inline-flex; align-items: center; gap: 4px; padding: 5px 8px 5px 10px; border-radius: 999px; font-size: 12px; font-weight: 600;
      background: var(--bg-secondary); border: 1px solid var(--border-subtle); color: var(--fg-primary); max-width: 100%; }
    .rsc-chip--auto { color: var(--fg-secondary); border-style: dashed; padding-right: 10px; }
    .rsc-chip-x { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: 50%; border: none; background: transparent; color: var(--fg-tertiary); cursor: pointer; }
    .rsc-chip-x:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--texte-alerte); }
    .rsc-add { display: flex; gap: 8px; margin-top: 8px; }
    .rsc-add input { flex: 1 1 auto; min-width: 0; min-height: 44px; padding: 8px 12px; border-radius: 10px; background: var(--bg-secondary); color: var(--fg-primary); border: 1px solid var(--border-subtle); font-size: 13px; }
    .rsc-add input:focus { outline: none; border-color: var(--tracky-light, #10E0A0); }

    .rsc-options { display: grid; grid-template-columns: 1fr; gap: 6px; }
    @media (min-width: 560px) { .rsc-options { grid-template-columns: 1fr 1fr; } }
    .rsc-opt { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px 10px; border-radius: 10px; border: 1px solid var(--border-subtle); background: var(--bg-secondary); cursor: pointer; }
    .rsc-opt--on { border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 35%, transparent); background: color-mix(in srgb, var(--tracky-light, #10E0A0) 7%, var(--bg-secondary)); }
    .rsc-opt input, .rsc-vrow input { width: 18px; height: 18px; accent-color: var(--tracky, #10E0A0); flex-shrink: 0; }
    .rsc-opt-text { display: flex; flex-direction: column; min-width: 0; }
    .rsc-opt-text b { font-size: 12.5px; color: var(--fg-primary); }
    .rsc-opt-text small { font-size: 11px; color: var(--fg-tertiary); }

    .rsc-scope { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .rsc-pill { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; border-radius: 10px; border: 1px solid var(--border-subtle); background: var(--bg-secondary); color: var(--fg-secondary); font-size: 13px; font-weight: 700; cursor: pointer; }
    .rsc-pill--on { background: color-mix(in srgb, var(--tracky-light, #10E0A0) 12%, transparent); border-color: color-mix(in srgb, var(--tracky-light, #10E0A0) 35%, transparent); color: var(--texte-succes); }
    .rsc-pill:disabled { opacity: .55; cursor: default; }
    .rsc-pill-n { font-size: 11px; padding: 2px 7px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .rsc-pill--on .rsc-pill-n { background: color-mix(in srgb, var(--tracky-light, #10E0A0) 18%, transparent); color: var(--texte-succes); }
    .rsc-vlist { margin-top: 8px; max-height: 200px; overflow-y: auto; border: 1px solid var(--border-subtle); border-radius: 10px; background: var(--bg-secondary); }
    .rsc-vrow { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 6px 10px; border-top: 1px solid var(--border-subtle); cursor: pointer; }
    .rsc-vrow:first-child { border-top: none; }
    .rsc-vplate { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12.5px; font-weight: 700; color: var(--fg-primary); }
    .rsc-vmodel { font-size: 11.5px; color: var(--fg-tertiary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

    .rsc-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
    .rsc-foot-actions { display: flex; gap: 8px; flex-wrap: wrap; width: 100%; }
    @media (min-width: 560px) { .rsc-foot-actions { width: auto; } }
    .rsc-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 9px 14px; border-radius: 10px; font-size: 13px; font-weight: 800; cursor: pointer; border: 1px solid transparent; flex: 1 1 auto; }
    @media (min-width: 560px) { .rsc-btn { flex: 0 0 auto; } }
    .rsc-btn--sm { min-height: 44px; padding: 6px 12px; font-size: 12.5px; flex: 0 0 auto; }
    .rsc-btn--primary { background: var(--tracky, #10E0A0); color: var(--accent-ink, #04130D); }
    .rsc-btn--ghost { background: transparent; color: var(--fg-secondary); border-color: var(--border-strong, var(--border-subtle)); }
    .rsc-btn--ghost:hover:not(:disabled) { color: var(--fg-primary); border-color: var(--tracky-light, #10E0A0); }
    .rsc-btn:disabled { opacity: .55; cursor: default; }
    .rsc-link { display: inline-flex; align-items: center; gap: 4px; min-height: 44px; padding: 0 4px; background: none; border: none; font-size: 12.5px; font-weight: 700; color: var(--fg-secondary); cursor: pointer; }
    .rsc-link:hover { color: var(--fg-primary); }
    .rsc-spin { animation: rsc-rot .9s linear infinite; }
    @keyframes rsc-rot { to { transform: rotate(360deg); } }

    .rsc-history { border-top: 1px solid var(--border-subtle); padding-top: 10px; }
    .rsc-hlist { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .rsc-hrow { display: grid; grid-template-columns: 90px 1fr; gap: 2px 10px; padding: 8px 10px; border-radius: 10px; background: var(--bg-tertiary); font-size: 12px; }
    .rsc-hdate { color: var(--fg-tertiary); font-weight: 600; }
    .rsc-hstatus { font-weight: 800; color: var(--fg-primary); display: flex; gap: 6px; align-items: baseline; }
    .rsc-hstatus small { font-weight: 500; color: var(--fg-tertiary); }
    .rsc-hrow[data-status="SENT"] .rsc-hstatus { color: var(--texte-succes); }
    .rsc-hrow[data-status="FAILED"] .rsc-hstatus { color: var(--texte-alerte); }
    .rsc-hrow[data-status="SKIPPED"] .rsc-hstatus { color: var(--texte-attente); }
    .rsc-hdetail { grid-column: 2; color: var(--fg-secondary); }
    .rsc-hdetail em { font-style: normal; color: var(--fg-tertiary); }
  `],
})
export class ReportScheduleCardComponent {
  private readonly api = inject(ReportsApiService);
  private readonly toast = inject(ToastService);
  /**
   * Journal d'activité utilisateur : un réglage du rapport hebdomadaire touche de vraies
   * boîtes aux lettres. La capture automatique des clics n'enregistrerait que « Enregistrer »,
   * sans dire QUOI a changé ni pour quelle société — inutile le jour où quelqu'un demande
   * pourquoi le rapport ne part plus.
   */
  private readonly tracker = inject(ActivityTrackerService);

  /** Société affichée (super-admin) — null = celle de l'utilisateur. */
  readonly fleetId = input<string | null>(null);
  /** Véhicules de la société, pour le périmètre. */
  readonly vehicles = input<VehicleDetailDto[]>([]);
  /**
   * Droit de MODIFIER (`reports_export`, celui qu'exige l'API). À faux, la carte reste
   * lisible — prochaine échéance, contenu, destinataires — mais aucune commande n'apparaît.
   * Montrer un bouton qui répondra 403 apprend à se méfier de l'écran.
   */
  readonly editable = input(true);
  /**
   * Super-admin sur « toutes les sociétés » : il n'y a pas de rapport à régler tant qu'aucune
   * société n'est choisie. On invite à en choisir une plutôt que d'appeler l'API pour rien.
   */
  readonly needsFleetChoice = input(false);

  protected readonly weekdays = WEEKDAYS;
  protected readonly hours = Array.from({ length: 24 }, (_, i) => i);
  protected readonly sectionDefs = SECTIONS;

  protected readonly schedule = signal<FleetReportScheduleDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly sending = signal(false);
  protected readonly dirty = signal(false);

  protected readonly enabled = signal(true);
  protected readonly weekday = signal(1);
  protected readonly hour = signal(8);
  protected readonly recipients = signal<string[]>([]);
  protected readonly sections = signal<Set<FleetReportSection>>(new Set(['kpi', 'alerts', 'topVehicles', 'trips']));
  protected readonly vehicleIds = signal<Set<string>>(new Set());
  protected readonly selecting = signal(false);
  protected newRecipient = '';
  protected readonly recipientError = signal<string | null>(null);

  protected readonly historyOpen = signal(false);
  protected readonly historyLoading = signal(false);
  protected readonly dispatches = signal<FleetReportDispatchDto[]>([]);

  protected readonly valid = computed(() => this.sections().size > 0);

  /**
   * Un champ est verrouillé soit parce que l'envoi est coupé (rien à régler), soit parce que
   * la personne n'a pas le droit de modifier. Un seul calcul : deux conditions écrites à neuf
   * endroits finissent par diverger, et un champ resterait actif là où l'API refusera.
   */
  protected readonly verrouille = computed(() => !this.editable() || !this.enabled());

  /**
   * Le motif du bouton « Envoyer maintenant », dans l'ordre où l'API refuserait : d'abord des
   * modifications non enregistrées (le serveur jugerait l'ancien réglage), puis l'envoi coupé
   * (409, design/C3 point 2 — le bouton partait vers de vraies boîtes aux lettres malgré
   * l'interrupteur). Sinon, ce que fait le bouton.
   */
  protected readonly titreEnvoi = computed(() => {
    if (this.dirty()) return 'Enregistrez d’abord vos modifications';
    if (!this.enabled()) return 'Réactivez l’envoi automatique pour envoyer';
    return 'Envoie le rapport des 7 derniers jours aux destinataires réglés';
  });

  /** « dans 4 jours » / « demain » / « dans 3 heures » — le chiffre que le client attend. */
  protected readonly nextIn = computed(() => {
    const s = this.schedule();
    if (!s) return '';
    const ms = new Date(s.nextDueAt).getTime() - Date.now();
    const hours = Math.round(ms / 3_600_000);
    if (hours < 1) return 'dans moins d’une heure';
    if (hours < 24) return `dans ${hours} heure${hours > 1 ? 's' : ''}`;
    const days = Math.round(ms / 86_400_000);
    return days <= 1 ? 'demain' : `dans ${days} jours`;
  });
  protected readonly periodFromLabel = computed(() => this.dayLabel(this.schedule()?.nextPeriodFrom));
  protected readonly periodToLabel = computed(() => this.dayLabel(this.schedule()?.nextPeriodTo));

  protected readonly CalendarIcon = CalendarClock;
  protected readonly MailIcon = Mail;
  protected readonly SendIcon = Send;
  protected readonly SaveIcon = Save;
  protected readonly ChevronDownIcon = ChevronDown;
  protected readonly ChevronUpIcon = ChevronUp;
  protected readonly CheckIcon = Check;
  protected readonly XIcon = X;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly ClockIcon = Clock;
  protected readonly LoaderIcon = Loader;
  protected readonly PlusIcon = Plus;

  constructor() {
    // Recharge à chaque changement de société dans le sélecteur du haut — y compris le
    // passage à « toutes les sociétés », qui doit vider la carte au lieu de garder à l'écran
    // le réglage de la société précédente.
    effect(() => {
      const fleetId = this.fleetId();
      this.needsFleetChoice();
      untracked(() => void this.load(fleetId));
    });
  }

  /** « 08:00 » — écrit en TypeScript : un `<` dans une interpolation piège l'analyseur HTML. */
  protected heureLabel(h: number): string {
    return `${String(h).padStart(2, '0')}:00`;
  }

  private dayLabel(iso: string | undefined): string {
    if (!iso) return '';
    const d = new Date(`${iso}T12:00:00`);
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
  }

  /** Réglage de toutes les sociétés — chargé seulement quand aucune n'est choisie. */
  protected readonly vue = signal<FleetReportScheduleDto[]>([]);
  protected readonly vueLoading = signal(false);
  protected readonly vueErreur = signal<string | null>(null);

  /** « lun. », « mar. »… — l'abréviation suffit dans un tableau de vingt lignes. */
  protected jourCourt(weekday: number): string {
    return ['', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'][weekday] ?? '?';
  }

  /**
   * ⚠️ Chargée UNIQUEMENT quand aucune société n'est choisie : c'est le seul moment où elle
   * apprend quelque chose. La charger systématiquement ferait payer une requête de plus à
   * chaque ouverture de la page Rapports, pour un tableau que personne ne regarderait.
   */
  private async chargerVue(): Promise<void> {
    if (this.vueLoading()) return;
    this.vueLoading.set(true);
    this.vueErreur.set(null);
    try {
      this.vue.set(await firstValueFrom(this.api.scheduleOverview()));
    } catch (e) {
      swallow('report-schedule-card:vue', e);
      this.vueErreur.set("Vue d'ensemble indisponible.");
      this.vue.set([]);
    } finally {
      this.vueLoading.set(false);
    }
  }

  private async load(fleetId: string | null): Promise<void> {
    // Super-admin sur « toutes les sociétés » : il n'y a rien à charger, et l'API répondrait
    // par un refus. La carte invite à choisir une société, sans appel inutile.
    if (this.needsFleetChoice()) {
      this.schedule.set(null);
      this.loadError.set(null);
      this.loading.set(false);
      void this.chargerVue();
      return;
    }
    this.loading.set(true);
    this.loadError.set(null);
    this.historyOpen.set(false);
    try {
      const s = await this.api.getReportSchedule(fleetId);
      this.apply(s);
    } catch (e) {
      swallow('report-schedule-card:load', e);
      this.schedule.set(null);
      this.loadError.set(apiErrorMessage(e, 'Réglage du rapport hebdomadaire indisponible.'));
    } finally {
      this.loading.set(false);
    }
  }

  private apply(s: FleetReportScheduleDto): void {
    this.schedule.set(s);
    this.enabled.set(s.enabled);
    this.weekday.set(s.weekday);
    this.hour.set(s.hour);
    this.recipients.set([...s.recipients]);
    this.sections.set(new Set(s.sections));
    this.vehicleIds.set(new Set(s.vehicleIds));
    this.selecting.set(false);
    this.dirty.set(false);
  }

  protected markDirty(): void { this.dirty.set(true); }

  /** Le réglage en une ligne, pour le journal d'activité : « coupé » ou le détail utile. */
  private resumeReglage(s: FleetReportScheduleDto): string {
    if (!s.enabled) return 'envoi automatique COUPÉ';
    const jour = WEEKDAYS.find((d) => d.value === s.weekday)?.label ?? `jour ${s.weekday}`;
    const qui = s.recipients.length ? `${s.recipients.length} adresse(s)` : 'administrateurs de la société';
    const quoi = s.vehicleIds.length ? `${s.vehicleIds.length} véhicule(s)` : 'tous les véhicules';
    return `${jour} ${this.heureLabel(s.hour)} · ${qui} · ${s.sections.length} section(s) · ${quoi}`;
  }

  /** Interrupteur principal. En méthode pour rester lisible dans le gabarit. */
  protected basculerActif(): void {
    this.enabled.set(!this.enabled());
    this.markDirty();
  }

  protected toggleSection(key: FleetReportSection): void {
    const next = new Set(this.sections());
    if (next.has(key)) next.delete(key); else next.add(key);
    this.sections.set(next);
    this.markDirty();
  }

  /** Périmètre = toute la société. En méthode : le langage des gabarits Angular ignore `new`. */
  protected toutLesVehicules(): void {
    this.vehicleIds.set(new Set());
    this.selecting.set(false);
    this.markDirty();
  }

  protected startSelection(): void { this.selecting.set(true); }

  protected toggleVehicle(id: string): void {
    const next = new Set(this.vehicleIds());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.vehicleIds.set(next);
    this.markDirty();
  }

  protected addRecipient(): void {
    const v = this.newRecipient.trim().toLowerCase();
    if (!v) return;
    if (!EMAIL_RE.test(v)) { this.recipientError.set('Adresse e-mail invalide.'); return; }
    if (this.recipients().length >= 10) { this.recipientError.set('10 destinataires au maximum.'); return; }
    if (this.recipients().includes(v)) { this.newRecipient = ''; return; }
    this.recipientError.set(null);
    this.recipients.set([...this.recipients(), v]);
    this.newRecipient = '';
    this.markDirty();
  }

  protected removeRecipient(r: string): void {
    this.recipients.set(this.recipients().filter((x) => x !== r));
    this.markDirty();
  }

  protected async save(): Promise<void> {
    if (this.saving() || !this.valid()) return;
    this.saving.set(true);
    try {
      const s = await this.api.setReportSchedule(this.fleetId(), {
        enabled: this.enabled(),
        weekday: this.weekday(),
        hour: this.hour(),
        recipients: this.recipients(),
        sections: SECTIONS.map((x) => x.key).filter((k) => this.sections().has(k)),
        vehicleIds: Array.from(this.vehicleIds()),
        maxTrips: this.schedule()?.maxTrips ?? 30,
        topN: this.schedule()?.topN ?? 10,
      });
      this.apply(s);
      // Trace lisible dans l'activité utilisateur : QUI, pour QUELLE société, et QUOI.
      this.tracker.trackClick(`Rapport hebdo · ${s.fleetName} · ${this.resumeReglage(s)}`);
      this.toast.success(s.enabled ? 'Rapport hebdomadaire réglé' : 'Envoi automatique désactivé', s.enabled ? `Prochain envoi ${this.nextIn()}.` : undefined);
    } catch (e) {
      swallow('report-schedule-card:save', e);
      this.toast.error('Réglage non enregistré', apiErrorMessage(e, ''));
    } finally {
      this.saving.set(false);
    }
  }

  protected async sendNow(): Promise<void> {
    // Bouton grisé quand l'envoi est coupé ; la garde couvre le clavier (409 côté serveur sinon).
    if (this.sending() || !this.enabled()) return;
    this.sending.set(true);
    try {
      const { dispatch } = await this.api.sendReportNow(this.fleetId());
      this.tracker.trackClick(`Rapport hebdo · ${dispatch.fleetName} · envoi immédiat (${dispatch.status === 'SENT' ? `${dispatch.recipients.length} destinataire(s)` : dispatch.status.toLowerCase()})`);
      if (dispatch.status === 'SENT') {
        this.toast.success('Rapport envoyé', `${dispatch.recipients.length} destinataire${dispatch.recipients.length > 1 ? 's' : ''} · ${dispatch.tripsCount} trajets · PDF joint.`);
      } else if (dispatch.status === 'SKIPPED') {
        this.toast.error('Rien envoyé', dispatch.error ?? '');
      } else {
        this.toast.error('Échec de l’envoi', dispatch.error ?? '');
      }
      await this.load(this.fleetId());
      if (this.historyOpen()) await this.loadHistory();
    } catch (e) {
      swallow('report-schedule-card:sendNow', e);
      this.toast.error('Échec de l’envoi', apiErrorMessage(e, ''));
    } finally {
      this.sending.set(false);
    }
  }

  protected async toggleHistory(): Promise<void> {
    const open = !this.historyOpen();
    this.historyOpen.set(open);
    if (open) await this.loadHistory();
  }

  private async loadHistory(): Promise<void> {
    this.historyLoading.set(true);
    try {
      this.dispatches.set(await this.api.listReportDispatches(this.fleetId(), 20));
    } catch (e) {
      swallow('report-schedule-card:history', e);
      this.dispatches.set([]);
    } finally {
      this.historyLoading.set(false);
    }
  }
}
