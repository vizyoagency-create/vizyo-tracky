import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Gauge, LucideAngularModule, Plus, Trash2, UserRound } from 'lucide-angular';
import type { FleetSpeedAlertSettingsDto, VehicleSpeedAlertOverrideDto } from '@vizyo/tracky-shared';
import {
  EXCES_CRITIQUE_KMH,
  SPEED_ALERT_ABSOLUTE_MAX_KMH,
  SPEED_ALERT_ABSOLUTE_MIN_KMH,
  SPEED_ALERT_DEFAULTS,
  SPEED_ALERT_OVER_MAX_KMH,
  SPEED_ALERT_OVER_MIN_KMH,
} from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { ActivityTrackerService } from '../../core/services/activity-tracker.service';
import { AlertsApiService } from '../../core/services/alerts.service';
import { VehiclesApiService, type VehicleDetailDto } from '../../core/services/vehicles.service';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { apiErrorMessage } from '../../core/error/api-error';

/**
 * Lot V5 — réglage des ALERTES DE VITESSE nées de l'analyse de trajet.
 *
 * Jusqu'ici, la seule alerte d'excès venait d'un bit d'alarme du boîtier, sans limite légale :
 * 1 627 alertes en un mois pour une société, acquittées en bloc, et pas une pour un trajet à
 * 168 km/h dont l'analyse connaissait pourtant la limite. Cette carte règle la nouvelle alerte,
 * celle qui compare la vitesse mesurée à la limite de la voie.
 *
 * Même contrat que la carte du rapport hebdomadaire : suit le sélecteur de société pour un
 * super-admin, lecture seule sans le droit `alerts_configure`, et chaque modification est
 * tracée dans l'activité utilisateur.
 */
@Component({
  selector: 'app-speed-alert-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, FormsModule, DatePipe],
  template: `
    <section class="sac" aria-labelledby="sac-title">
      <header class="sac-head">
        <div class="sac-head-main">
          <span class="sac-icon"><lucide-icon [img]="GaugeIcon" [size]="18"></lucide-icon></span>
          <div class="sac-head-text">
            <h2 id="sac-title">Alertes de vitesse sur les trajets</h2>
            @if (needsFleetChoice()) {
              <p class="sac-etat sac-etat--off">Choisissez une société dans le sélecteur, en haut de l'écran, pour régler ses alertes de vitesse.</p>
            } @else if (settings(); as s) {
              @if (s.enabled) {
                <p class="sac-etat">
                  <strong>Actives</strong>
                  <span> · dépassement de {{ s.overKmh }} km/h et plus</span>
                  @if (s.absoluteKmh !== null) { <span> · plafond {{ s.absoluteKmh }} km/h</span> }
                  <span class="sac-fleet"> · {{ s.fleetName }}</span>
                </p>
              } @else {
                <p class="sac-etat sac-etat--off">Coupées pour {{ s.fleetName }} — les excès mesurés restent dans les rapports, personne n'est prévenu.</p>
              }
              @if (!editable()) {
                <p class="sac-readonly">Lecture seule : le droit de configurer les alertes est nécessaire pour modifier ce réglage.</p>
              }
            } @else if (loading()) {
              <p class="sac-etat">Chargement du réglage…</p>
            } @else if (loadError(); as e) {
              <p class="sac-etat sac-etat--off">{{ e }}</p>
            }
          </div>
        </div>
        @if (settings() && editable()) {
          <label class="sac-switch" [class.sac-switch--on]="enabled()">
            <input type="checkbox" [checked]="enabled()" (change)="basculer()" [attr.aria-label]="enabled() ? 'Couper les alertes de vitesse' : 'Activer les alertes de vitesse'" />
            <span class="sac-switch-track"><span class="sac-switch-knob"></span></span>
            <span class="sac-switch-label">{{ enabled() ? 'Actives' : 'Coupées' }}</span>
          </label>
        } @else if (settings()) {
          <span class="sac-badge" [class.sac-badge--on]="enabled()">{{ enabled() ? 'Actives' : 'Coupées' }}</span>
        }
      </header>

      @if (settings(); as s) {
        <p class="sac-explication">
          Chaque trajet analysé dont un excès dépasse le seuil crée une alerte « Excès de vitesse »,
          rattachée au trajet, et prévient les personnes qui reçoivent les alertes de la société —
          selon leurs propres réglages de notifications. La notification ouvre le trajet.
          S'applique aux trajets analysés après l'activation ; un trajet de plus de 48 h n'est pas notifié.
        </p>

        <div class="sac-grid">
          <fieldset class="sac-field">
            <legend>Seuil</legend>
            <label class="sac-num">
              <span>Dépassement de la limite d'au moins</span>
              <span class="sac-num-input">
                <input type="number" inputmode="numeric" [min]="OVER_MIN" [max]="OVER_MAX" step="5"
                       [ngModel]="overKmh()" (ngModelChange)="overKmh.set(+$event); markDirty()" [disabled]="verrouille()" />
                <em>km/h</em>
              </span>
            </label>
            <p class="sac-hint">
              En dessous, l'excès reste dans le rapport sans notification.
              À partir de {{ CRITIQUE }} km/h au-dessus de la limite, l'alerte est critique.
            </p>
          </fieldset>

          <fieldset class="sac-field">
            <legend>Plafond absolu</legend>
            <label class="sac-check">
              <input type="checkbox" [checked]="absoluteOn()" (change)="basculerPlafond()" [disabled]="verrouille()" />
              <span>Alerter au-delà de</span>
              <span class="sac-num-input">
                <input type="number" inputmode="numeric" [min]="ABS_MIN" [max]="ABS_MAX" step="10"
                       [ngModel]="absoluteKmh()" (ngModelChange)="absoluteKmh.set(+$event); markDirty()" [disabled]="verrouille() || !absoluteOn()" />
                <em>km/h</em>
              </span>
            </label>
            <p class="sac-hint">
              Même quand la limite de la voie est inconnue. Aucune route française n'autorise plus de 130 km/h.
            </p>
          </fieldset>
        </div>

        @if (editable()) {
          <div class="sac-actions">
            @if (erreurSaisie(); as e) { <p class="sac-erreur">{{ e }}</p> }
            <button type="button" class="sac-btn sac-btn--ghost" (click)="annuler()" [disabled]="!dirty() || saving()">Annuler</button>
            <button type="button" class="sac-btn sac-btn--primary" (click)="enregistrer()" [disabled]="!dirty() || saving() || !!erreurSaisie()">
              {{ saving() ? 'Enregistrement…' : 'Enregistrer' }}
            </button>
          </div>
        }

        <!-- Dérogations par véhicule -->
        <div class="sac-derog">
          <h3>Véhicules qui dérogent</h3>
          @if (s.vehicles.length === 0) {
            <p class="sac-hint">Aucun — tous les véhicules suivent le réglage de la société.</p>
          } @else {
            <ul class="sac-list">
              @for (v of s.vehicles; track v.vehicleId) {
                <li>
                  <span class="sac-plate">{{ v.plate }}</span>
                  <span class="sac-derog-desc">{{ descriptionDerogation(v) }}</span>
                  @if (editable()) {
                    <button type="button" class="sac-btn sac-btn--icon" (click)="retirer(v)" [disabled]="saving()" [attr.aria-label]="'Retirer la dérogation de ' + v.plate" title="Retirer la dérogation">
                      <lucide-icon [img]="TrashIcon" [size]="14"></lucide-icon>
                    </button>
                  }
                </li>
              }
            </ul>
          }
          @if (editable()) {
            <div class="sac-add">
              <select [ngModel]="ajoutVehicleId()" (ngModelChange)="ajoutVehicleId.set($event)" [disabled]="saving()" aria-label="Véhicule">
                <option [ngValue]="null">Véhicule…</option>
                @for (v of vehiculesDisponibles(); track v.id) { <option [ngValue]="v.id">{{ v.plate }}</option> }
              </select>
              <select [ngModel]="ajoutEnabled()" (ngModelChange)="ajoutEnabled.set($event)" [disabled]="saving()" aria-label="Activation">
                <option [ngValue]="null">Activation : comme la société</option>
                <option [ngValue]="true">Activées pour ce véhicule</option>
                <option [ngValue]="false">Coupées pour ce véhicule</option>
              </select>
              <span class="sac-num-input">
                <input type="number" inputmode="numeric" [min]="OVER_MIN" [max]="OVER_MAX" step="5" placeholder="seuil société"
                       [ngModel]="ajoutOverKmh()" (ngModelChange)="ajoutOverKmh.set($event === '' || $event === null ? null : +$event)" [disabled]="saving()" aria-label="Seuil propre au véhicule" />
                <em>km/h</em>
              </span>
              <button type="button" class="sac-btn sac-btn--ghost sac-btn--sm" (click)="ajouter()" [disabled]="saving() || !ajoutVehicleId() || (ajoutEnabled() === null && ajoutOverKmh() === null)">
                <lucide-icon [img]="PlusIcon" [size]="14"></lucide-icon> Ajouter
              </button>
            </div>
          }
        </div>

        @if (s.updatedAt) {
          <p class="sac-auteur">
            <lucide-icon [img]="UserIcon" [size]="12"></lucide-icon>
            Modifié {{ s.updatedBy ? 'par ' + s.updatedBy : '' }} le {{ s.updatedAt | date:'d MMM yyyy à HH:mm' }}
          </p>
        }
      }
    </section>
  `,
  styles: [`
    .sac { display: flex; flex-direction: column; gap: 14px; padding: 16px; border: 1px solid var(--border-subtle); border-radius: 14px; background: var(--bg-secondary); }
    .sac-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .sac-head-main { display: flex; align-items: flex-start; gap: 12px; min-width: 0; flex: 1 1 260px; }
    .sac-icon { width: 36px; height: 36px; border-radius: 12px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0;
      background: color-mix(in srgb, var(--tracky-light, #10E0A0) 16%, transparent); color: var(--texte-succes); }
    .sac-head-text { min-width: 0; }
    .sac-head-text h2 { margin: 0; font-size: 15px; font-weight: 800; color: var(--fg-primary); }
    .sac-etat { margin: 3px 0 0; font-size: 12.5px; line-height: 1.45; color: var(--fg-secondary); }
    .sac-etat strong { color: var(--texte-succes); font-weight: 800; }
    .sac-etat--off { color: var(--texte-attente); font-weight: 600; }
    .sac-fleet { color: var(--fg-tertiary); }
    .sac-readonly { margin: 4px 0 0; font-size: 11.5px; color: var(--fg-tertiary); }
    .sac-badge { font-size: 12px; font-weight: 800; padding: 4px 10px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-secondary); }
    .sac-badge--on { background: color-mix(in srgb, var(--tracky-light, #10E0A0) 18%, transparent); color: var(--texte-succes); }

    .sac-switch { display: inline-flex; align-items: center; gap: 8px; cursor: pointer; min-height: 44px; user-select: none; }
    .sac-switch input { position: absolute; opacity: 0; width: 1px; height: 1px; }
    .sac-switch-track { width: 42px; height: 24px; border-radius: 999px; background: var(--bg-tertiary); border: 1px solid var(--border-strong, var(--border-subtle)); position: relative; transition: background .15s; }
    .sac-switch-knob { position: absolute; top: 2px; left: 2px; width: 18px; height: 18px; border-radius: 50%; background: var(--fg-tertiary); transition: transform .15s, background .15s; }
    .sac-switch--on .sac-switch-track { background: var(--tracky, #10E0A0); border-color: transparent; }
    .sac-switch--on .sac-switch-knob { transform: translateX(18px); background: var(--accent-ink, #04130D); }
    .sac-switch input:focus-visible + .sac-switch-track { outline: 2px solid var(--tracky-light, #10E0A0); outline-offset: 2px; }
    .sac-switch-label { font-size: 12.5px; font-weight: 700; color: var(--fg-secondary); }

    .sac-explication { margin: 0; font-size: 12.5px; line-height: 1.5; color: var(--fg-secondary); }
    .sac-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 640px) { .sac-grid { grid-template-columns: 1fr 1fr; } }
    .sac-field { margin: 0; padding: 12px; border: 1px solid var(--border-subtle); border-radius: 12px; background: var(--bg-tertiary); min-width: 0; }
    .sac-field legend { padding: 0 6px; font-size: 11px; font-weight: 800; letter-spacing: .06em; text-transform: uppercase; color: var(--fg-tertiary); }
    .sac-num, .sac-check { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; color: var(--fg-primary); }
    .sac-num-input { display: inline-flex; align-items: center; gap: 6px; }
    .sac-num-input input { width: 84px; min-height: 40px; padding: 6px 10px; border-radius: 10px; border: 1px solid var(--border-strong, var(--border-subtle)); background: var(--bg-secondary); color: var(--fg-primary); font-size: 14px; font-weight: 700; font-variant-numeric: tabular-nums; }
    .sac-num-input input:disabled { opacity: .55; }
    .sac-num-input em { font-style: normal; font-size: 12px; color: var(--fg-tertiary); }
    .sac-check input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--tracky, #10E0A0); }
    .sac-hint { margin: 8px 0 0; font-size: 11.5px; line-height: 1.45; color: var(--fg-tertiary); }

    .sac-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
    .sac-erreur { margin: 0 auto 0 0; font-size: 12px; font-weight: 600; color: var(--texte-alerte); }
    .sac-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; padding: 9px 14px; border-radius: 10px; font-size: 13px; font-weight: 800; cursor: pointer; border: 1px solid transparent; }
    .sac-btn--sm { min-height: 40px; padding: 6px 12px; font-size: 12.5px; }
    .sac-btn--primary { background: var(--tracky, #10E0A0); color: var(--accent-ink, #04130D); }
    .sac-btn--ghost { background: transparent; color: var(--fg-secondary); border-color: var(--border-strong, var(--border-subtle)); }
    .sac-btn--ghost:hover:not(:disabled) { color: var(--fg-primary); border-color: var(--tracky-light, #10E0A0); }
    .sac-btn--icon { min-height: 36px; padding: 6px 8px; background: transparent; color: var(--fg-tertiary); }
    .sac-btn--icon:hover:not(:disabled) { color: var(--texte-alerte); }
    .sac-btn:disabled { opacity: .55; cursor: default; }

    .sac-derog h3 { margin: 0 0 6px; font-size: 12px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--fg-tertiary); }
    .sac-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
    .sac-list li { display: flex; align-items: center; gap: 10px; padding: 6px 10px; border-radius: 10px; background: var(--bg-tertiary); font-size: 13px; }
    .sac-plate { font-family: ui-monospace, monospace; font-weight: 800; color: var(--fg-primary); }
    .sac-derog-desc { flex: 1; color: var(--fg-secondary); }
    .sac-add { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 8px; }
    .sac-add select { min-height: 40px; padding: 6px 10px; border-radius: 10px; border: 1px solid var(--border-strong, var(--border-subtle)); background: var(--bg-secondary); color: var(--fg-primary); font-size: 13px; }
    .sac-auteur { margin: 0; display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg-tertiary); }
  `],
})
export class SpeedAlertCardComponent {
  /** Société réglée — `null` chez un super-admin qui n'en a pas choisi. */
  readonly fleetId = input<string | null>(null);
  readonly editable = input(false);
  readonly needsFleetChoice = input(false);

  private readonly api = inject(AlertsApiService);
  private readonly vehiclesApi = inject(VehiclesApiService);
  private readonly toast = inject(ToastService);
  private readonly tracker = inject(ActivityTrackerService);

  protected readonly GaugeIcon = Gauge;
  protected readonly PlusIcon = Plus;
  protected readonly TrashIcon = Trash2;
  protected readonly UserIcon = UserRound;
  protected readonly OVER_MIN = SPEED_ALERT_OVER_MIN_KMH;
  protected readonly OVER_MAX = SPEED_ALERT_OVER_MAX_KMH;
  protected readonly ABS_MIN = SPEED_ALERT_ABSOLUTE_MIN_KMH;
  protected readonly ABS_MAX = SPEED_ALERT_ABSOLUTE_MAX_KMH;
  protected readonly CRITIQUE = EXCES_CRITIQUE_KMH;

  protected readonly settings = signal<FleetSpeedAlertSettingsDto | null>(null);
  protected readonly loading = signal(false);
  protected readonly loadError = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly dirty = signal(false);

  protected readonly enabled = signal(false);
  protected readonly overKmh = signal<number>(SPEED_ALERT_DEFAULTS.overKmh);
  protected readonly absoluteOn = signal(true);
  protected readonly absoluteKmh = signal<number>(SPEED_ALERT_DEFAULTS.absoluteKmh);

  protected readonly vehicules = signal<VehicleDetailDto[]>([]);
  protected readonly ajoutVehicleId = signal<string | null>(null);
  protected readonly ajoutEnabled = signal<boolean | null>(null);
  protected readonly ajoutOverKmh = signal<number | null>(null);

  protected readonly verrouille = computed(() => !this.editable() || this.saving());

  /** Véhicules sans dérogation — les seuls qu'on puisse encore ajouter. */
  protected readonly vehiculesDisponibles = computed(() => {
    const deja = new Set((this.settings()?.vehicles ?? []).map((v) => v.vehicleId));
    return this.vehicules().filter((v) => !deja.has(v.id));
  });

  protected readonly erreurSaisie = computed<string | null>(() => {
    const o = this.overKmh();
    if (!Number.isInteger(o) || o < this.OVER_MIN || o > this.OVER_MAX) return `Le seuil doit être entre ${this.OVER_MIN} et ${this.OVER_MAX} km/h.`;
    if (this.absoluteOn()) {
      const a = this.absoluteKmh();
      if (!Number.isInteger(a) || a < this.ABS_MIN || a > this.ABS_MAX) return `Le plafond doit être entre ${this.ABS_MIN} et ${this.ABS_MAX} km/h.`;
    }
    return null;
  });

  constructor() {
    // Recharge quand la société change (sélecteur du haut chez un super-admin).
    effect(() => {
      const fleetId = this.fleetId();
      const needs = this.needsFleetChoice();
      untracked(() => {
        if (needs) { this.settings.set(null); return; }
        void this.charger(fleetId);
      });
    });
  }

  private async charger(fleetId: string | null): Promise<void> {
    this.loading.set(true);
    this.loadError.set(null);
    try {
      const s = await this.api.speedSettings(fleetId);
      this.appliquer(s);
      if (this.editable()) {
        // Liste des véhicules pour les dérogations : chargée en même temps, sans bloquer le réglage.
        this.vehiclesApi.list(fleetId ? { fleetId } : {}).subscribe({
          // Un super-admin reçoit tout le parc : on ne garde que la société réglée, sinon la
          // liste propose des véhicules que l'API refusera (404, véhicule hors société).
          next: (list) => this.vehicules.set(
            list.filter((v) => !fleetId || v.fleetId === fleetId).sort((a, b) => a.plate.localeCompare(b.plate)),
          ),
          error: () => this.vehicules.set([]),
        });
      }
    } catch (e) {
      this.settings.set(null);
      this.loadError.set(apiErrorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }

  private appliquer(s: FleetSpeedAlertSettingsDto): void {
    this.settings.set(s);
    this.enabled.set(s.enabled);
    this.overKmh.set(s.overKmh);
    this.absoluteOn.set(s.absoluteKmh !== null);
    this.absoluteKmh.set(s.absoluteKmh ?? SPEED_ALERT_DEFAULTS.absoluteKmh);
    this.dirty.set(false);
  }

  protected markDirty(): void { this.dirty.set(true); }

  protected basculer(): void {
    if (this.verrouille()) return;
    this.enabled.set(!this.enabled());
    // L'interrupteur agit tout de suite : c'est le geste attendu d'un interrupteur.
    void this.enregistrer();
  }

  protected basculerPlafond(): void {
    if (this.verrouille()) return;
    this.absoluteOn.set(!this.absoluteOn());
    this.markDirty();
  }

  protected annuler(): void {
    const s = this.settings();
    if (s) this.appliquer(s);
  }

  protected async enregistrer(): Promise<void> {
    const s = this.settings();
    if (!s || this.saving() || this.erreurSaisie()) return;
    this.saving.set(true);
    try {
      const next = await this.api.setSpeedSettings(this.fleetId(), {
        enabled: this.enabled(),
        overKmh: this.overKmh(),
        absoluteKmh: this.absoluteOn() ? this.absoluteKmh() : null,
      });
      this.appliquer(next);
      this.toast.success(next.enabled ? 'Alertes de vitesse activées' : 'Alertes de vitesse coupées');
      this.tracker.trackClick(`Alertes vitesse · ${next.fleetName} · ${next.enabled ? 'actives' : 'coupées'} · seuil +${next.overKmh} · plafond ${next.absoluteKmh ?? 'aucun'}`);
    } catch (e) {
      this.toast.error(apiErrorMessage(e));
      // Revenir à l'état connu : un interrupteur qui reste « actif » après un refus mentirait.
      this.appliquer(s);
    } finally {
      this.saving.set(false);
    }
  }

  protected descriptionDerogation(v: VehicleSpeedAlertOverrideDto): string {
    const parts: string[] = [];
    if (v.enabled === true) parts.push('alertes activées');
    else if (v.enabled === false) parts.push('alertes coupées');
    if (v.overKmh !== null) parts.push(`seuil +${v.overKmh} km/h`);
    return parts.join(' · ') || 'comme la société';
  }

  protected async retirer(v: VehicleSpeedAlertOverrideDto): Promise<void> {
    await this.ecrireDerogation(v.vehicleId, v.plate, { enabled: null, overKmh: null }, `dérogation retirée`);
  }

  protected async ajouter(): Promise<void> {
    const id = this.ajoutVehicleId();
    if (!id) return;
    const over = this.ajoutOverKmh();
    if (over !== null && (!Number.isInteger(over) || over < this.OVER_MIN || over > this.OVER_MAX)) {
      this.toast.error(`Le seuil doit être entre ${this.OVER_MIN} et ${this.OVER_MAX} km/h.`);
      return;
    }
    const plate = this.vehicules().find((x) => x.id === id)?.plate ?? id;
    const enabled = this.ajoutEnabled();
    const ok = await this.ecrireDerogation(id, plate, { enabled, overKmh: over },
      `${enabled === null ? 'activation héritée' : enabled ? 'activées' : 'coupées'} · seuil ${over ?? 'hérité'}`);
    if (ok) {
      this.ajoutVehicleId.set(null);
      this.ajoutEnabled.set(null);
      this.ajoutOverKmh.set(null);
    }
  }

  private async ecrireDerogation(vehicleId: string, plate: string, body: { enabled: boolean | null; overKmh: number | null }, resume: string): Promise<boolean> {
    if (this.saving()) return false;
    this.saving.set(true);
    try {
      const next = await this.api.setVehicleSpeedOverride(this.fleetId(), vehicleId, body);
      this.appliquer(next);
      this.toast.success(`Dérogation de ${plate} enregistrée`);
      this.tracker.trackClick(`Alertes vitesse · ${next.fleetName} · ${plate} · ${resume}`);
      return true;
    } catch (e) {
      this.toast.error(apiErrorMessage(e));
      return false;
    } finally {
      this.saving.set(false);
    }
  }
}
