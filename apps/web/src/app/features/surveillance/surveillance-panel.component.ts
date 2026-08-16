import { swallow } from '../../core/error/swallow';
import { Component, computed, inject, input, OnInit, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import {
  LucideAngularModule,
  ShieldCheck,
  ShieldAlert,
  Shield,
  ShieldOff,
  Activity,
  Clock,
  Power,
  AlertTriangle,
  Check,
  X,
  MapPin,
  Bell,
  Loader,
  Info,
} from 'lucide-angular';
import {
  DORMANT_STOP_ACTING_MS,
  formatSilenceLabel,
  trackerSilenceMs,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import {
  SurveillanceApiService,
  type SurveillanceEventDto,
  type SurveillanceProfileDto,
} from '../../core/services/surveillance.service';
import { AuthService } from '../../core/services/auth.service';
import { UsersApiService } from '../../core/services/users.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { relativeTime } from '../../shared/utils/relative-time';

/**
 * Profil + VÉRACITÉ DE LA PROTECTION (champs dérivés ajoutés par SurveillanceService côté
 * API : `withLiveness`). Rien n'est stocké en base, tout se recalcule à chaque lecture.
 *
 * Le type est déclaré ICI, en intersection, plutôt que dans le DTO partagé : ce panneau est
 * le seul consommateur de ces champs, et les marquer optionnels garantit qu'un backend qui
 * ne les renverrait pas (déploiement partiel) laisse l'écran dans son comportement actuel
 * au lieu de crier au boîtier muet sur la foi d'un `undefined`.
 */
type SurveillanceProfileWithLiveness = SurveillanceProfileDto & {
  /** null = aucun boîtier affecté ; undefined = API antérieure (fait inconnu). */
  trackerId?: string | null;
  /** Dernier signal du boîtier (ISO). null = n'a jamais émis. */
  trackerLastSeenAt?: string | null;
  trackerSilenceLabel?: string | null;
  /** Muet au-delà du seuil d'ACTION (72 h) → l'armement est refusé côté serveur. */
  trackerDormant?: boolean;
  /** false = impossible d'affirmer que le véhicule est protégé (pas de vert rassurant). */
  protectionVerifiable?: boolean;
};

const DAY_LABELS: Record<string, string> = {
  mon: 'Lun', tue: 'Mar', wed: 'Mer', thu: 'Jeu',
  fri: 'Ven', sat: 'Sam', sun: 'Dim',
};
const DAY_ORDER = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const TRIGGER_LABELS: Record<string, string> = {
  VIBRATION: 'Vibration',
  MOVEMENT: 'Mouvement',
  DOOR: 'Porte',
};

/** Libelles FR des roles — jamais l'identifiant brut a l'ecran. */
const ROLE_LABELS: Record<string, string> = {
  SUPER_ADMIN: 'Super-admin',
  FLEET_ADMIN: 'Admin de flotte',
  FLEET_MANAGER: 'Gestionnaire',
  NIGHT_WATCHMAN: 'Veilleur de nuit',
  DRIVER: 'Conducteur',
  VIEWER: 'Lecteur',
};

@Component({
  selector: 'app-surveillance-panel',
  standalone: true,
  imports: [LucideAngularModule, FormsModule, DatePipe, DecimalPipe],
  template: `
    <div class="flex flex-col gap-4">
      <!-- ─── Statut courant + Arm/Disarm ─────────────────────────── -->
      @if (loading()) {
        <div class="sm-card flex items-center justify-center py-8 text-fg-tertiary">
          <span class="w-5 h-5 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
        </div>
      } @else if (profile(); as p) {
        <!-- Le vert « armé » n'est mis QUE si la protection est vérifiable : un boîtier
             injoignable affiché en vert est un mensonge de sécurité (l'exploitant croit
             son véhicule protégé alors que l'antivol ne répond plus depuis 89 jours). -->
        <div class="sm-card"
             [class.sm-card--armed]="p.currentlyArmed && !protectionDoubt()"
             [class.sm-card--doubt]="!!protectionDoubt()">
          <div class="flex items-start justify-between gap-3 flex-wrap">
            <div class="flex items-start gap-3">
              <div class="sm-status-icon"
                   [class.sm-status-icon--armed]="p.currentlyArmed && !protectionDoubt()"
                   [class.sm-status-icon--doubt]="!!protectionDoubt()">
                @if (protectionDoubt()) {
                  <lucide-icon [img]="ShieldAlert" [size]="20"></lucide-icon>
                } @else if (p.currentlyArmed) {
                  <lucide-icon [img]="ShieldCheck" [size]="20"></lucide-icon>
                } @else {
                  <lucide-icon [img]="ShieldOff" [size]="20"></lucide-icon>
                }
              </div>
              <div class="min-w-0">
                <h3 class="text-base font-semibold text-fg-primary">
                  @if (p.currentlyArmed && protectionDoubt()) { Protection non vérifiable }
                  @else if (p.currentlyArmed) { Véhicule sous surveillance }
                  @else { Surveillance désactivée }
                </h3>
                <p class="text-xs text-fg-tertiary mt-0.5">
                  @if (p.currentlyArmed && p.lastArmedAt) {
                    Armé {{ relativeTime(p.lastArmedAt) }}
                  } @else if (!p.currentlyArmed && p.lastDisarmedAt) {
                    Désarmé {{ relativeTime(p.lastDisarmedAt) }}
                  } @else {
                    Aucun armement récent
                  }
                </p>
                <!-- On DATE la valeur, on ne la supprime pas : l'état affiché reste le
                     dernier réellement connu, et on dit depuis quand il n'est plus vérifié. -->
                @if (protectionDoubt(); as doubt) {
                  <p class="sm-doubt mt-1.5">{{ doubt }}</p>
                }
                @if (p.mode === 'SCHEDULED' && p.scheduleStartTime && p.scheduleEndTime) {
                  <p class="text-xs text-fg-secondary mt-1">
                    <lucide-icon [img]="Clock" [size]="12" class="inline align-middle"></lucide-icon>
                    Plage automatique : <span class="font-mono">{{ p.scheduleStartTime }}</span>
                    → <span class="font-mono">{{ p.scheduleEndTime }}</span>
                    @if (p.scheduleDays && p.scheduleDays.length > 0 && p.scheduleDays.length < 7) {
                      ({{ formatDays(p.scheduleDays) }})
                    }
                  </p>
                }
              </div>
            </div>

            <div class="flex gap-2">
              @if (p.currentlyArmed) {
                <button
                  type="button"
                  class="sm-btn sm-btn--danger"
                  [disabled]="acting()"
                  (click)="disarm()">
                  @if (acting()) {
                    <lucide-icon [img]="Loader" [size]="14" class="animate-spin"></lucide-icon>
                  } @else {
                    <lucide-icon [img]="ShieldOff" [size]="14"></lucide-icon>
                  }
                  Désarmer
                </button>
              } @else {
                <!-- ARMER aggrave (ajoute une contrainte) : gardé. DÉSARMER restaure :
                     jamais gardé, cf. le bouton ci-dessus. Le motif est AFFICHÉ sous le
                     bouton — un grisage muet laisse croire à un bug de l'application. -->
                <div class="flex flex-col items-end gap-1">
                  <button
                    type="button"
                    class="sm-btn sm-btn--primary"
                    [disabled]="acting() || !!armBlock()"
                    [title]="armBlock() ?? ''"
                    (click)="arm()">
                    @if (acting()) {
                      <lucide-icon [img]="Loader" [size]="14" class="animate-spin"></lucide-icon>
                    } @else {
                      <lucide-icon [img]="ShieldCheck" [size]="14"></lucide-icon>
                    }
                    Armer maintenant
                  </button>
                  @if (armBlock(); as reason) {
                    <span class="sm-doubt text-right">{{ reason }}</span>
                  }
                </div>
              }
            </div>
          </div>
        </div>

        <!-- ─── Configuration ────────────────────────────────────── -->
        <div class="sm-card">
          <div class="flex items-center gap-2 mb-3">
            <lucide-icon [img]="Activity" [size]="16" class="text-tracky-light"></lucide-icon>
            <h3 class="text-sm font-semibold text-fg-primary">Configuration</h3>
            @if (saving()) {
              <span class="text-xs text-fg-tertiary">Enregistrement…</span>
            } @else if (savedAt()) {
              <span class="text-xs text-tracky-light">✓ Enregistré</span>
            }
          </div>

          <div class="sm-grid">
            <!-- Mode -->
            <div class="sm-field">
              <label class="sm-label">Automatisation</label>
              <select
                class="sm-select"
                [value]="form().mode"
                (change)="updateField('mode', $any($event.target).value)">
                <option value="OFF">Manuel uniquement</option>
                <option value="FULL_TIME">Permanente (24/7)</option>
                <option value="SCHEDULED">Plage horaire</option>
              </select>
              @if (form().mode === 'OFF') {
                <p class="text-xs text-fg-tertiary mt-0.5">
                  Utilisez le bouton "Armer maintenant" pour activer ponctuellement.
                </p>
              }
            </div>

            <!-- Sensibilité -->
            <div class="sm-field">
              <label class="sm-label">Sensibilité au choc</label>
              <select
                class="sm-select"
                [value]="form().sensitivity"
                (change)="updateField('sensitivity', $any($event.target).value)">
                <option value="LOW">Faible — vibrations fortes uniquement</option>
                <option value="MEDIUM">Moyenne — recommandé</option>
                <option value="HIGH">Élevée — réagit à tout</option>
              </select>
            </div>
          </div>

          <!-- Plage horaire (uniquement si SCHEDULED) -->
          @if (form().mode === 'SCHEDULED') {
            <div class="sm-grid mt-3">
              <div class="sm-field">
                <label class="sm-label">Début</label>
                <input
                  type="time"
                  class="sm-input"
                  [value]="form().scheduleStartTime ?? ''"
                  (change)="updateField('scheduleStartTime', $any($event.target).value || null)" />
              </div>
              <div class="sm-field">
                <label class="sm-label">Fin</label>
                <input
                  type="time"
                  class="sm-input"
                  [value]="form().scheduleEndTime ?? ''"
                  (change)="updateField('scheduleEndTime', $any($event.target).value || null)" />
              </div>
            </div>

            <!-- L'heure saisie est celle de l'horloge murale. L'équivalent UTC reste
                 affiché, en note : il sert à recouper avec les journaux du serveur, et
                 à rassurer quiconque se souvient de l'ancien comportement. -->
            <p class="sm-note mt-2">
              Heure de la flotte ({{ FUSEAU_FLOTTE }}).
              @if (equivalentUtc(); as utc) {
                {{ utc }}
              }
              Le changement d'heure est suivi automatiquement : la plage ne bouge pas
              sur l'horloge.
            </p>

            <div class="mt-3">
              <label class="sm-label">Jours actifs</label>
              <div class="flex gap-1.5 flex-wrap mt-1.5">
                @for (day of DAY_ORDER; track day) {
                  <button
                    type="button"
                    class="sm-day-btn"
                    [class.sm-day-btn--active]="isDayActive(day)"
                    (click)="toggleDay(day)">
                    {{ DAY_LABELS[day] }}
                  </button>
                }
              </div>
              <p class="text-xs text-fg-tertiary mt-1">
                Aucun jour sélectionné = tous les jours.
              </p>
            </div>
          }

          <!-- Triggers -->
          <div class="mt-4 pt-3 border-t border-border-subtle">
            <label class="sm-label mb-2">Déclencheurs actifs lors de l'armement</label>
            <div class="flex flex-col gap-1.5">
              <label class="sm-check">
                <input
                  type="checkbox"
                  [checked]="form().triggerVibration"
                  (change)="updateField('triggerVibration', $any($event.target).checked)" />
                <span>Vibration / choc</span>
                <span class="text-xs text-fg-tertiary">(capteur accélération)</span>
              </label>
              <label class="sm-check">
                <input
                  type="checkbox"
                  [checked]="form().triggerMovement"
                  (change)="updateField('triggerMovement', $any($event.target).checked)" />
                <span>Mouvement du véhicule</span>
                <span class="text-xs text-fg-tertiary">(déplacement &gt; 200 m)</span>
              </label>
              <label class="sm-check">
                <input
                  type="checkbox"
                  [checked]="form().triggerDoor"
                  (change)="updateField('triggerDoor', $any($event.target).checked)" />
                <span>Ouverture portière</span>
                <span class="text-xs text-fg-tertiary">(fil porte connecté)</span>
              </label>
            </div>
          </div>

          <!-- Destinataires des notifications de déclenchement -->
          <div class="mt-4 pt-3 border-t border-border-subtle">
            <label class="sm-label mb-1">Destinataires des alertes</label>
            <p class="text-xs text-fg-tertiary">
              Les destinataires d'alertes de la flotte sont prévenus par défaut. Ajoutez ici
              les personnes à prévenir <strong class="text-fg-secondary">en plus</strong>, pour
              ce véhicule uniquement.
            </p>

            <!--
              L'ecran affichait « sera disponible dans une prochaine version » depuis des
              mois, et n'exposait qu'un COMPTEUR. Pourtant toute la plomberie existait :
              la colonne, le DTO, et une validation serveur qui verifie deja l'appartenance
              a la flotte. Constat prod 2026-07-28 : 0 profil sur 11 renseigne — la
              fonctionnalite etait inatteignable, pas inutilisee.
            -->
            @if (notifyCandidates().length === 0) {
              <p class="text-xs text-fg-tertiary italic mt-2">
                Aucun autre utilisateur dans cette flotte.
              </p>
            } @else {
              <ul class="mt-2 space-y-1">
                @for (c of notifyCandidates(); track c.id) {
                  <li>
                    <label class="sm-notify-row">
                      <input
                        type="checkbox"
                        [checked]="isNotified(c.id)"
                        [disabled]="saving()"
                        (change)="toggleNotifyUser(c.id, $any($event.target).checked)" />
                      <span class="sm-notify-txt">
                        <span class="sm-notify-name">{{ c.label }}</span>
                        <span class="sm-notify-role">{{ c.roleLabel }}</span>
                      </span>
                    </label>
                  </li>
                }
              </ul>
              @if (notifiedCount() > 0) {
                <p class="text-xs text-fg-tertiary mt-1">
                  {{ notifiedCount() }} contact(s) additionnel(s) — prévenus uniquement pour
                  les déclenchements de CE véhicule.
                </p>
              }
            }
          </div>
        </div>

        <!-- ─── Timeline événements ──────────────────────────────── -->
        <div class="sm-card">
          <div class="flex items-center gap-2 mb-3">
            <lucide-icon [img]="Bell" [size]="16" class="text-tracky-light"></lucide-icon>
            <h3 class="text-sm font-semibold text-fg-primary">Historique des déclenchements</h3>
            @if (events().length > 0) {
              <span class="text-xs text-fg-tertiary">({{ events().length }})</span>
            }
          </div>

          @if (eventsLoading()) {
            <div class="flex items-center justify-center py-6 text-fg-tertiary">
              <span class="w-4 h-4 border-2 border-fg-tertiary border-t-tracky-light rounded-full animate-spin"></span>
            </div>
          } @else if (events().length === 0) {
            <div class="text-center py-8 text-fg-tertiary text-sm">
              Aucun déclenchement enregistré pour ce véhicule.
            </div>
          } @else {
            <div class="flex flex-col gap-2">
              @for (ev of events(); track ev.id) {
                <div class="sm-event" [class]="'sm-event--' + ev.status.toLowerCase()">
                  <div class="flex items-start justify-between gap-2 flex-wrap">
                    <div class="flex-1 min-w-0">
                      <div class="flex items-center gap-1.5 text-sm font-medium text-fg-primary">
                        <lucide-icon [img]="AlertTriangle" [size]="14" class="text-amber-400"></lucide-icon>
                        Déclenchement {{ triggerLabel(ev.trigger) }}
                      </div>
                      <p class="text-xs text-fg-tertiary mt-0.5">
                        {{ ev.triggeredAt | date:'dd/MM/yyyy HH:mm:ss' }}
                        · {{ relativeTime(ev.triggeredAt) }}
                      </p>
                      @if (ev.latitude !== null && ev.longitude !== null) {
                        <p class="text-xs text-fg-secondary mt-1 font-mono">
                          <lucide-icon [img]="MapPin" [size]="11" class="inline align-middle"></lucide-icon>
                          {{ ev.latitude | number:'1.5-5' }}, {{ ev.longitude | number:'1.5-5' }}
                          @if (ev.speedKmh !== null) {
                            · {{ ev.speedKmh | number:'1.0-1' }} km/h
                          }
                        </p>
                      }
                      @if (ev.notes) {
                        <p class="text-xs text-fg-secondary mt-1 italic">{{ ev.notes }}</p>
                      }
                    </div>

                    <div class="flex items-center gap-1.5">
                      <span class="sm-badge sm-badge--{{ ev.status.toLowerCase() }}">
                        {{ statusLabel(ev.status) }}
                      </span>
                    </div>
                  </div>

                  @if (ev.status === 'PENDING') {
                    <div class="flex gap-1.5 mt-2 pt-2 border-t border-border-subtle">
                      <button
                        type="button"
                        class="sm-event-btn sm-event-btn--danger"
                        [disabled]="actingEventId() === ev.id"
                        (click)="acknowledgeEvent(ev.id, 'CONFIRMED_THEFT')">
                        <lucide-icon [img]="AlertTriangle" [size]="12"></lucide-icon>
                        Confirmer vol
                      </button>
                      <button
                        type="button"
                        class="sm-event-btn sm-event-btn--neutral"
                        [disabled]="actingEventId() === ev.id"
                        (click)="acknowledgeEvent(ev.id, 'FALSE_ALARM')">
                        <lucide-icon [img]="X" [size]="12"></lucide-icon>
                        Fausse alarme
                      </button>
                      <button
                        type="button"
                        class="sm-event-btn sm-event-btn--neutral"
                        [disabled]="actingEventId() === ev.id"
                        (click)="acknowledgeEvent(ev.id, 'ACKNOWLEDGED')">
                        <lucide-icon [img]="Check" [size]="12"></lucide-icon>
                        Marquer vu
                      </button>
                    </div>
                  }
                </div>
              }
            </div>
          }
        </div>
      } @else if (loadError()) {
        <div class="sm-card text-center py-6">
          <p class="text-sm text-red-400">{{ loadError() }}</p>
          <button type="button" class="sm-btn sm-btn--ghost mt-2" (click)="load()">Réessayer</button>
        </div>
      }
    </div>
  `,
  styles: [`
    /* 44 px : cible tactile minimale — le panneau est utilise au telephone. */
    .sm-notify-row { display: flex; gap: .55rem; align-items: center; min-height: 44px; cursor: pointer; }
    .sm-notify-row input { width: 20px; height: 20px; flex: none; }
    .sm-notify-txt { display: flex; gap: .4rem; align-items: baseline; flex-wrap: wrap; }
    .sm-notify-name { font-size: .85rem; }
    .sm-notify-role { font-size: .72rem; opacity: .65; }
    .sm-card {
      background: var(--color-bg-secondary, #0e1417);
      border: 1px solid var(--color-border-subtle, #1f2a30);
      border-radius: var(--radius-card, 14px);
      padding: 1rem;
    }
    .sm-card--armed {
      border-color: rgba(16, 224, 160, 0.4);
      background: linear-gradient(180deg, rgba(16, 224, 160, 0.06), transparent 60%), var(--color-bg-secondary, #0e1417);
    }
    .sm-status-icon {
      width: 36px; height: 36px;
      border-radius: 10px;
      background: rgba(148, 163, 184, 0.12);
      color: rgb(148, 163, 184);
      display: inline-flex; align-items: center; justify-content: center;
      flex-shrink: 0;
    }
    .sm-status-icon--armed {
      background: rgba(16, 224, 160, 0.15);
      color: rgb(16, 224, 160);
    }
    /* Protection non vérifiable : ambre (doute), jamais vert (fausse assurance),
       jamais rouge non plus — on ne sait pas, on ne prétend pas savoir. */
    .sm-card--doubt {
      border-color: rgba(251, 191, 36, 0.45);
      background: linear-gradient(180deg, rgba(251, 191, 36, 0.06), transparent 60%), var(--color-bg-secondary, #0e1417);
    }
    .sm-status-icon--doubt {
      background: rgba(251, 191, 36, 0.15);
      color: rgb(251, 191, 36);
    }
    .sm-doubt {
      font-size: 0.75rem;
      line-height: 1.35;
      color: rgb(251, 191, 36);
    }
    /* Note de pied du réglage horaire. Le reste des couleurs de ce panneau est en dur ;
       leur reprise appartient au lot B-pages § F « Panneau surveillance », qui attend
       les maquettes. On n'en ajoute pas une de plus au passage. */
    .sm-note {
      font-size: 0.72rem;
      line-height: 1.4;
      color: var(--fg-tertiary);
    }
    .sm-btn {
      display: inline-flex; align-items: center; gap: 0.375rem;
      padding: 0.5rem 0.875rem;
      border-radius: 10px;
      font-size: 0.8125rem;
      font-weight: 600;
      cursor: pointer;
      transition: filter 0.15s, opacity 0.15s;
      border: 1px solid transparent;
    }
    .sm-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sm-btn:hover:not(:disabled) { filter: brightness(1.1); }
    .sm-btn--primary { background: rgb(16, 224, 160); color: #0b0f12; }
    .sm-btn--danger {
      background: rgba(239, 68, 68, 0.15);
      color: rgb(248, 113, 113);
      border-color: rgba(239, 68, 68, 0.4);
    }
    .sm-btn--ghost {
      background: transparent;
      color: var(--color-fg-secondary);
      border-color: var(--color-border-subtle);
    }
    .sm-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 0.75rem;
    }
    .sm-field { display: flex; flex-direction: column; gap: 0.25rem; }
    .sm-label {
      font-size: 0.75rem;
      color: var(--color-fg-tertiary, #94a3b8);
      font-weight: 500;
    }
    .sm-select, .sm-input {
      background: var(--color-bg-tertiary, #0a0f12);
      border: 1px solid var(--color-border-subtle, #1f2a30);
      border-radius: 8px;
      padding: 0.5rem 0.75rem;
      color: var(--color-fg-primary, #e5e7eb);
      font-size: 0.875rem;
    }
    .sm-day-btn {
      padding: 0.375rem 0.625rem;
      border-radius: 8px;
      font-size: 0.75rem;
      font-weight: 500;
      background: var(--color-bg-tertiary, #0a0f12);
      border: 1px solid var(--color-border-subtle, #1f2a30);
      color: var(--color-fg-tertiary, #94a3b8);
      cursor: pointer;
      transition: all 0.15s;
    }
    .sm-day-btn--active {
      background: rgba(16, 224, 160, 0.15);
      border-color: rgba(16, 224, 160, 0.4);
      color: rgb(16, 224, 160);
    }
    .sm-check {
      display: inline-flex; align-items: center; gap: 0.5rem;
      font-size: 0.875rem;
      color: var(--color-fg-primary, #e5e7eb);
      cursor: pointer;
    }
    .sm-check input { width: 16px; height: 16px; accent-color: rgb(16, 224, 160); }
    .sm-event {
      padding: 0.75rem;
      background: var(--color-bg-tertiary, #0a0f12);
      border: 1px solid var(--color-border-subtle, #1f2a30);
      border-radius: 10px;
    }
    .sm-event--pending { border-left: 3px solid rgb(251, 191, 36); }
    .sm-event--confirmed_theft { border-left: 3px solid rgb(239, 68, 68); }
    .sm-event--false_alarm { border-left: 3px solid rgb(148, 163, 184); opacity: 0.7; }
    .sm-event--acknowledged { border-left: 3px solid rgb(96, 165, 250); }
    .sm-badge {
      padding: 0.125rem 0.5rem;
      border-radius: 999px;
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.025em;
    }
    .sm-badge--pending { background: rgba(251, 191, 36, 0.15); color: rgb(251, 191, 36); }
    .sm-badge--confirmed_theft { background: rgba(239, 68, 68, 0.15); color: rgb(248, 113, 113); }
    .sm-badge--false_alarm { background: rgba(148, 163, 184, 0.15); color: rgb(148, 163, 184); }
    .sm-badge--acknowledged { background: rgba(96, 165, 250, 0.15); color: rgb(96, 165, 250); }
    .sm-event-btn {
      display: inline-flex; align-items: center; gap: 0.25rem;
      padding: 0.3125rem 0.625rem;
      border-radius: 6px;
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
      border: 1px solid transparent;
      transition: filter 0.15s;
    }
    .sm-event-btn:hover:not(:disabled) { filter: brightness(1.1); }
    .sm-event-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .sm-event-btn--danger {
      background: rgba(239, 68, 68, 0.15);
      color: rgb(248, 113, 113);
      border-color: rgba(239, 68, 68, 0.3);
    }
    .sm-event-btn--neutral {
      background: var(--color-bg-secondary, #0e1417);
      color: var(--color-fg-secondary, #cbd5e1);
      border-color: var(--color-border-subtle, #1f2a30);
    }
  `],
})
export class SurveillancePanelComponent implements OnInit {
  readonly vehicleId = input.required<string>();

  private readonly api = inject(SurveillanceApiService);
  private readonly usersApi = inject(UsersApiService);
  private readonly auth = inject(AuthService);
  private readonly toast = inject(ToastService);

  protected readonly loading = signal(true);
  protected readonly loadError = signal<string | null>(null);
  protected readonly profile = signal<SurveillanceProfileWithLiveness | null>(null);

  /**
   * Collegues proposables comme destinataire ADDITIONNEL pour ce vehicule.
   * Soi-meme est exclu : on est deja destinataire ou on ne l'est pas, se cocher
   * soi-meme dans une liste « en plus » n'a pas de sens.
   */
  protected readonly notifyCandidates = signal<{ id: string; label: string; roleLabel: string }[]>([]);
  protected readonly notifiedCount = computed(() => this.profile()?.additionalNotifyUserIds?.length ?? 0);
  protected readonly events = signal<SurveillanceEventDto[]>([]);
  protected readonly eventsLoading = signal(false);
  protected readonly acting = signal(false);
  protected readonly actingEventId = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly savedAt = signal<number | null>(null);

  /**
   * Le fuseau dans lequel la plage est lue par le planificateur — celui de la flotte,
   * pas celui du navigateur. La nuance compte : un gestionnaire en déplacement hors de
   * France verrait « heure locale » et croirait à SON horloge, alors que l'antivol suit
   * celle des véhicules. Côté serveur : `FLEET_TIME_ZONE`.
   */
  protected readonly FUSEAU_FLOTTE = 'Europe/Paris';

  /**
   * « 18:00 → 23:00 correspond aujourd'hui à 16:00 → 21:00 UTC. »
   *
   * Le décalage est MESURÉ pour la date du jour, jamais codé en dur : il vaut +2 h
   * l'été et +1 h l'hiver, et un décalage figé redeviendrait faux au changement
   * d'heure — exactement le défaut que ce lot corrige. Même méthode que
   * `fleet-tz.util.ts` côté API.
   */
  protected readonly equivalentUtc = computed(() => {
    const debut = this.form().scheduleStartTime;
    const fin = this.form().scheduleEndTime;
    if (!debut || !fin) return null;
    const u1 = this.versUtc(debut);
    const u2 = this.versUtc(fin);
    if (!u1 || !u2) return null;
    return `${debut} → ${fin} correspond aujourd'hui à ${u1} → ${u2} UTC.`;
  });

  /** Convertit une heure de pendule de la flotte en heure UTC, pour la date du jour. */
  private versUtc(hhmm: string): string | null {
    const [h, m] = hhmm.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    const sonde = new Date();
    const enFlotte = new Date(sonde.toLocaleString('en-US', { timeZone: this.FUSEAU_FLOTTE }));
    const enUtc = new Date(sonde.toLocaleString('en-US', { timeZone: 'UTC' }));
    const decalageMin = Math.round((enFlotte.getTime() - enUtc.getTime()) / 60000);
    const total = (((h as number) * 60 + (m as number) - decalageMin) % 1440 + 1440) % 1440;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }

  // Form mirror du profile (édition locale). Patched chaque fois qu'on update,
  // pour permettre l'optimistic UI sans attendre le PUT.
  protected readonly form = computed(() => {
    const p = this.profile();
    if (!p) {
      return {
        mode: 'OFF' as const,
        sensitivity: 'MEDIUM' as const,
        scheduleStartTime: null as string | null,
        scheduleEndTime: null as string | null,
        scheduleDays: null as string[] | null,
        triggerVibration: true,
        triggerMovement: true,
        triggerDoor: false,
      };
    }
    return {
      mode: p.mode,
      sensitivity: p.sensitivity,
      scheduleStartTime: p.scheduleStartTime,
      scheduleEndTime: p.scheduleEndTime,
      scheduleDays: p.scheduleDays,
      triggerVibration: p.triggerVibration,
      triggerMovement: p.triggerMovement,
      triggerDoor: p.triggerDoor,
    };
  });

  /**
   * BOÎTIER MUET (seuil AGIR = 72 h) — libellé de silence, ou null si le boîtier parle.
   *
   * Recalculé ICI à partir du fait brut (`trackerLastSeenAt`) avec la constante partagée,
   * plutôt que de faire confiance au seul booléen renvoyé : API et UI DOIVENT lire la même
   * valeur — le serveur refuse l'armement à 72 h, l'UI ne peut pas griser à 7 j sans
   * laisser le bouton actif quatre jours de plus pour une commande déjà condamnée. Repli
   * sur le booléen serveur si le champ brut manque (déploiement partiel).
   *
   * ⚠️ Pas de minuteur : ce `computed` ne dépend QUE de `profile()`, donc il se réévalue
   * aux allers-retours serveur (chargement, sauvegarde d'un réglage, armement, désarmement)
   * et pas à l'usure du temps. C'est volontaire — le fait brut vient du serveur, un tick
   * local ne ferait que franchir le seuil dans un seul sens (griser), jamais le rendre au
   * boîtier qui reparle. Ne pas y ajouter de `setInterval` sans recharger aussi le profil.
   */
  protected readonly dormantSilence = computed<string | null>(() => {
    const p = this.profile();
    if (!p) return null;
    const lastSeen = p.trackerLastSeenAt;
    if (lastSeen === undefined || lastSeen === null) {
      // Fait brut absent : on ne devine pas, on suit le verdict du serveur s'il existe.
      return p.trackerDormant === true ? (p.trackerSilenceLabel ?? '—') : null;
    }
    const now = Date.now();
    const silent = trackerSilenceMs(lastSeen, now);
    if (silent == null || silent <= DORMANT_STOP_ACTING_MS) return null;
    return formatSilenceLabel(lastSeen, now) ?? '—';
  });

  /**
   * Pourquoi la protection n'est PAS vérifiable, ou null quand elle l'est.
   *
   * Trois faits distincts, jamais confondus : pas de boîtier (véhicule non équipé — les
   * TEST-00x de la flotte), boîtier qui n'a jamais émis (provisioning SIM/APN), boîtier
   * devenu muet (le cas FV-941-LZ). Aucun des trois ne permet d'affirmer « protégé ».
   */
  protected readonly protectionDoubt = computed<string | null>(() => {
    const p = this.profile();
    if (!p) return null;
    const silence = this.dormantSilence();
    if (silence) {
      return `Boîtier muet depuis ${silence} — l'antivol ne répond plus. L'état ci-dessus est ` +
        `le dernier réellement connu ; il redeviendra fiable dès la première trame reçue.`;
    }
    if (p.trackerId === null) {
      return 'Aucun boîtier n\'est affecté à ce véhicule — la protection ne peut pas être vérifiée.';
    }
    if (p.trackerLastSeenAt === null) {
      return 'Le boîtier n\'a jamais émis — la protection ne peut pas être vérifiée.';
    }
    // Repli : le serveur dit « non vérifiable » sans qu'on sache lequel des cas ci-dessus.
    if (p.protectionVerifiable === false) {
      return 'Protection non vérifiable — le boîtier n\'est pas joignable.';
    }
    return null;
  });

  /**
   * Motif de blocage de l'ARMEMENT, ou null s'il est possible. Reproduit EXACTEMENT les
   * deux refus du serveur (aucun boîtier / boîtier muet > 72 h) : un bouton actif pour une
   * commande déjà refusée fait croire à l'exploitant qu'il a agi. Ne bloque JAMAIS le
   * désarmement — « boîtier jamais joint » n'est pas non plus un blocage : le serveur, lui,
   * tente encore (repli SMS possible), on ne durcit pas au-delà de lui.
   */
  protected readonly armBlock = computed<string | null>(() => {
    const p = this.profile();
    if (!p) return null;
    const silence = this.dormantSilence();
    if (silence) return `Boîtier muet depuis ${silence} — armement impossible`;
    if (p.trackerId === null) return 'Aucun boîtier sur ce véhicule — armement impossible';
    return null;
  });

  protected readonly ShieldCheck = ShieldCheck;
  protected readonly ShieldAlert = ShieldAlert;
  protected readonly Shield = Shield;
  protected readonly ShieldOff = ShieldOff;
  protected readonly Activity = Activity;
  protected readonly Clock = Clock;
  protected readonly Power = Power;
  protected readonly AlertTriangle = AlertTriangle;
  protected readonly Check = Check;
  protected readonly X = X;
  protected readonly MapPin = MapPin;
  protected readonly Bell = Bell;
  protected readonly Loader = Loader;
  protected readonly Info = Info;

  protected readonly DAY_LABELS = DAY_LABELS;
  protected readonly DAY_ORDER = DAY_ORDER;
  protected readonly relativeTime = relativeTime;

  // Debounce pour le save : on accumule les changements rapides pendant 400ms.
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  // Buffer des champs en attente d'être PUT-és. Permet la fusion sans reset à l'arrivée d'une nouvelle modification.
  private pendingPatch: Record<string, unknown> = {};

  async ngOnInit(): Promise<void> {
    await this.load();
    await this.loadEvents();
    // Apres le profil : la liste des collegues n'est utile qu'une fois le bloc affiche,
    // et son echec ne doit pas retarder l'essentiel du panneau.
    await this.loadNotifyCandidates();
  }

  async load(): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const p = await firstValueFrom(this.api.getProfile(this.vehicleId()));
      this.profile.set(p);
    } catch (err: unknown) {
      swallow('surveillance-panel:load', err);
      const msg = err instanceof Error ? err.message : 'Erreur de chargement';
      this.loadError.set(msg);
    } finally {
      this.loading.set(false);
    }
  }

  async loadEvents(): Promise<void> {
    this.eventsLoading.set(true);
    try {
      const res = await firstValueFrom(
        this.api.listEvents({ vehicleId: this.vehicleId(), limit: '50' }),
      );
      this.events.set(res.items);
    } catch (err) {
      swallow('surveillance-panel:loadEvents', err);
      // Silencieux — l'absence d'événements n'est pas une erreur visible.
    } finally {
      this.eventsLoading.set(false);
    }
  }

  async arm(): Promise<void> {
    // Filet : le boîtier peut devenir muet entre le chargement du panneau et le clic.
    // Uniquement sur ARMER — `disarm()` reste sans garde, en toutes circonstances.
    const blocked = this.armBlock();
    if (blocked) {
      this.toast.error('Armement impossible', blocked);
      return;
    }
    this.acting.set(true);
    try {
      const updated = await firstValueFrom(this.api.arm(this.vehicleId()));
      this.profile.set(updated);
      this.toast.success('Surveillance activée', 'Le véhicule est désormais sous surveillance.');
    } catch (err: unknown) {
      swallow('surveillance-panel:arm', err);
      const msg = this.extractErrorMessage(err);
      this.toast.error('Armement impossible', msg);
    } finally {
      this.acting.set(false);
    }
  }

  async disarm(): Promise<void> {
    this.acting.set(true);
    try {
      const updated = await firstValueFrom(this.api.disarm(this.vehicleId()));
      this.profile.set(updated);
      // Le désarmement N'EST JAMAIS bloqué (il restaure), mais sur un boîtier muet le
      // serveur saute volontairement l'envoi du `shock_off` : il désarme dans l'application
      // et l'écrit au journal. Annoncer un simple « Surveillance désactivée » laisserait
      // croire que l'antivol physique est retombé — il ne l'est pas, et une alerte au réveil
      // du boîtier paraîtrait alors inexplicable. On dit ce qui s'est réellement passé.
      const silence = this.dormantSilence();
      this.toast.success(
        'Surveillance désactivée',
        silence
          ? `Boîtier muet depuis ${silence} : désarmé dans l'application, la commande ne lui est ` +
            'pas parvenue — il conserve son dernier état physique connu.'
          : undefined,
      );
    } catch (err: unknown) {
      swallow('surveillance-panel:disarm', err);
      const msg = this.extractErrorMessage(err);
      this.toast.error('Désarmement impossible', msg);
    } finally {
      this.acting.set(false);
    }
  }

  /** Cet utilisateur est-il deja destinataire additionnel de CE vehicule ? */
  protected isNotified(userId: string): boolean {
    return (this.profile()?.additionalNotifyUserIds ?? []).includes(userId);
  }

  /**
   * Ajoute ou retire un destinataire additionnel.
   *
   * Passe par `updateField`, donc on herite du meme comportement que les autres
   * reglages du panneau : mise à jour optimiste, regroupement des changements et
   * envoi differe de 400 ms (cocher trois personnes = UN appel, pas trois), avec
   * rechargement depuis le serveur si l'enregistrement echoue.
   */
  protected toggleNotifyUser(userId: string, checked: boolean): void {
    const current = this.profile()?.additionalNotifyUserIds ?? [];
    const next = checked
      ? Array.from(new Set([...current, userId]))
      : current.filter((id) => id !== userId);
    this.updateField('additionalNotifyUserIds', next);
  }

  /**
   * Charge les collegues proposables. Best-effort : sans la liste, le bloc affiche
   * « aucun autre utilisateur » plutot que de casser le panneau — un anti-vol doit
   * rester utilisable meme si une liste secondaire ne se charge pas.
   */
  private async loadNotifyCandidates(): Promise<void> {
    const meId = this.auth.user()?.sub;
    try {
      const { users } = await this.usersApi.findAll();
      this.notifyCandidates.set(
        users
          .filter((u) => u.isActive && u.id !== meId)
          .map((u) => ({
            id: u.id,
            label: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.email,
            roleLabel: ROLE_LABELS[u.role] ?? u.role,
          }))
          .sort((a, b) => a.label.localeCompare(b.label, 'fr')),
      );
    } catch {
      this.notifyCandidates.set([]);
    }
  }

  /**
   * Update d'un champ unique avec optimistic UI + debounce 400ms.
   * Les modifications sont fusionnées dans `pendingPatch` puis envoyées.
   */
  updateField<K extends string>(field: K, value: unknown): void {
    // Optimistic UI : on patche le signal local immédiatement.
    const current = this.profile();
    if (current) {
      this.profile.set({ ...current, [field]: value } as SurveillanceProfileWithLiveness);
    }
    this.pendingPatch[field] = value;

    // Si on passe à SCHEDULED sans avoir d'horaires définis, on auto-fill
    // des défauts raisonnables (20:00 → 06:00) — sinon le backend refuse en 400.
    // C'est aussi cohérent avec l'usage anti-vol nocturne typique du module.
    if (field === 'mode' && value === 'SCHEDULED') {
      const c = this.profile();
      if (c) {
        const patch: Record<string, unknown> = {};
        if (!c.scheduleStartTime) {
          patch['scheduleStartTime'] = '20:00';
          this.pendingPatch['scheduleStartTime'] = '20:00';
        }
        if (!c.scheduleEndTime) {
          patch['scheduleEndTime'] = '06:00';
          this.pendingPatch['scheduleEndTime'] = '06:00';
        }
        if (Object.keys(patch).length > 0) {
          this.profile.set({ ...c, ...patch } as SurveillanceProfileWithLiveness);
        }
      }
    }

    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      void this.flushSave();
    }, 400);
  }

  private async flushSave(): Promise<void> {
    if (Object.keys(this.pendingPatch).length === 0) return;
    const patch = this.pendingPatch;
    this.pendingPatch = {};
    this.saving.set(true);
    try {
      const updated = await firstValueFrom(
        this.api.updateProfile(this.vehicleId(), patch),
      );
      this.profile.set(updated);
      this.savedAt.set(Date.now());
      setTimeout(() => {
        // Efface l'indicateur "✓ Enregistré" après 2s
        if (this.savedAt() !== null && Date.now() - this.savedAt()! >= 1900) {
          this.savedAt.set(null);
        }
      }, 2000);
    } catch (err) {
      swallow('surveillance-panel:flushSave', err);
      const msg = this.extractErrorMessage(err);
      this.toast.error('Enregistrement échoué', msg);
      // Recharge depuis le serveur pour resynchroniser l'UI avec l'état réel
      await this.load();
    } finally {
      this.saving.set(false);
    }
  }

  isDayActive(day: string): boolean {
    const days = this.form().scheduleDays;
    if (!days || days.length === 0) return false;
    return days.includes(day);
  }

  toggleDay(day: string): void {
    const current = this.form().scheduleDays ?? [];
    const next = current.includes(day)
      ? current.filter((d) => d !== day)
      : [...current, day];
    // Conserve l'ordre logique mon→sun pour stabilité visuelle.
    const ordered = DAY_ORDER.filter((d) => next.includes(d));
    this.updateField('scheduleDays', ordered.length === 0 ? null : ordered);
  }

  formatDays(days: string[]): string {
    return days.map((d) => DAY_LABELS[d] ?? d).join(', ');
  }

  triggerLabel(t: string): string {
    return TRIGGER_LABELS[t] ?? t;
  }

  statusLabel(s: string): string {
    switch (s) {
      case 'PENDING': return 'En attente';
      case 'CONFIRMED_THEFT': return 'Vol confirmé';
      case 'FALSE_ALARM': return 'Fausse alarme';
      case 'ACKNOWLEDGED': return 'Vu';
      default: return s;
    }
  }

  async acknowledgeEvent(
    eventId: string,
    status: 'CONFIRMED_THEFT' | 'FALSE_ALARM' | 'ACKNOWLEDGED',
  ): Promise<void> {
    this.actingEventId.set(eventId);
    try {
      const updated = await firstValueFrom(
        this.api.acknowledgeEvent(eventId, { status }),
      );
      this.events.update((list) =>
        list.map((e) => (e.id === eventId ? { ...e, ...updated } : e)),
      );
      const messages: Record<string, string> = {
        CONFIRMED_THEFT: 'Vol confirmé enregistré',
        FALSE_ALARM: 'Marqué comme fausse alarme',
        ACKNOWLEDGED: 'Événement acquitté',
      };
      this.toast.success(messages[status] ?? 'Événement mis à jour');
    } catch (err) {
      swallow('surveillance-panel:acknowledgeEvent', err);
      const msg = this.extractErrorMessage(err);
      this.toast.error('Acquittement impossible', msg);
    } finally {
      this.actingEventId.set(null);
    }
  }

  private extractErrorMessage(err: unknown): string {
    if (typeof err === 'object' && err !== null) {
      const e = err as { error?: { message?: string }; message?: string };
      return e.error?.message ?? e.message ?? 'Erreur inconnue';
    }
    return String(err);
  }
}
