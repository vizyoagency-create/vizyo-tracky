import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Gauge, Plus, Trash2, X, Check, Fuel, TrendingUp, TrendingDown, ShieldCheck } from 'lucide-angular';
import { firstValueFrom } from 'rxjs';
import type { FuelConfidence, UpsertFuelFillUpDto, VehicleFuelModelDto } from '@vizyo/tracky-shared';
import { TripAnalysisApiService } from '../../core/services/trip-analysis.service';
import { apiErrorMessage } from '../../core/error/api-error';

/**
 * Carburant (P4) — CARTE « Calibration » : compare la consommation ESTIMÉE (paramètre/défaut) à la
 * consommation RÉELLE mesurée par la MÉTHODE DU PLEIN (litres renseignés ÷ distance entre 2 pleins).
 * Plus le client renseigne de pleins, plus la conso/coût sont FIABLES (« au fur et à mesure »). But :
 * que le client fasse confiance aux chiffres carburant. Explique tout en clair.
 */
@Component({
  selector: 'app-fuel-calibration-card',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [DatePipe, DecimalPipe, FormsModule, LucideAngularModule],
  template: `
    <section class="fcal">
      <header class="fcal-head">
        <span class="fcal-title"><lucide-icon [img]="GaugeIcon" [size]="14"></lucide-icon> Consommation réelle & coûts</span>
        @if (data(); as d) {
          <span class="fcal-conf" [attr.data-conf]="d.confidence"><lucide-icon [img]="ShieldIcon" [size]="12"></lucide-icon> {{ confLabel(d.confidence) }}</span>
        }
      </header>

      @if (loading()) {
        <div class="fcal-loading"><span class="fcal-spin"></span></div>
      } @else if (data(); as d) {
        <!-- Comparaison conso estimée vs calibrée -->
        <div class="fcal-cons">
          <div class="fcal-cons-col">
            <span class="fcal-cons-n">{{ d.estimatedConsumptionL100km | number:'1.1-1' }}</span>
            <span class="fcal-cons-l">estimée <small>L/100km</small></span>
          </div>
          <div class="fcal-cons-arrow">
            @if (d.calibratedConsumptionL100km != null) {
              <lucide-icon [img]="(d.deltaPercent ?? 0) >= 0 ? UpIcon : DownIcon" [size]="16"></lucide-icon>
            } @else { → }
          </div>
          <div class="fcal-cons-col fcal-cons-col--real" [class.fcal-cons-col--pending]="d.calibratedConsumptionL100km == null">
            @if (d.calibratedConsumptionL100km != null) {
              <span class="fcal-cons-n">{{ d.calibratedConsumptionL100km | number:'1.1-1' }}</span>
              <span class="fcal-cons-l">réelle mesurée <small>L/100km</small></span>
            } @else {
              <span class="fcal-cons-n fcal-cons-n--dash">—</span>
              <span class="fcal-cons-l">réelle <small>à mesurer</small></span>
            }
          </div>
        </div>

        @if (d.calibratedConsumptionL100km != null && d.deltaPercent != null) {
          <p class="fcal-delta" [attr.data-sign]="d.deltaPercent >= 0 ? 'up' : 'down'">
            La consommation réelle est <strong>{{ d.deltaPercent >= 0 ? '+' : '' }}{{ d.deltaPercent | number:'1.0-1' }}%</strong>
            {{ d.deltaPercent >= 0 ? 'plus élevée' : 'plus basse' }} que l'estimation par défaut — les coûts sont désormais ajustés sur du <strong>réel</strong>.
          </p>
        } @else {
          <p class="fcal-hint">Renseignez au moins <strong>2 pleins complets</strong> (avec les litres) pour que l'app mesure la consommation RÉELLE de ce véhicule et fiabilise tous les coûts.</p>
        }

        <!-- Coût sur la période avec la conso effective + prix réel -->
        @if (d.costAtObservedEur != null) {
          <div class="fcal-cost">
            <span><lucide-icon [img]="FuelIcon" [size]="12"></lucide-icon> Coût estimé ({{ d.effectiveLiters | number:'1.0-0' }} L · {{ d.distanceKm | number:'1.0-0' }} km)</span>
            <strong>{{ d.costAtObservedEur | number:'1.2-2' }} €</strong>
          </div>
        }
        @if (d.realSpentEur != null) {
          <div class="fcal-cost fcal-cost--real">
            <span><lucide-icon [img]="CheckIcon" [size]="12"></lucide-icon> Réellement dépensé ({{ d.realLiters | number:'1.0-0' }} L renseignés)</span>
            <strong>{{ d.realSpentEur | number:'1.2-2' }} €</strong>
          </div>
        }

        <!-- Formulaire d'ajout de plein -->
        @if (showForm()) {
          <form class="fcal-form" (ngSubmit)="submit()">
            <div class="fcal-form-grid">
              <label>Date<input type="date" [(ngModel)]="fDate" name="d" required></label>
              <label>Litres<input type="number" step="0.01" min="0" [(ngModel)]="fLiters" name="l" placeholder="45" required></label>
              <label>Montant €<input type="number" step="0.01" min="0" [(ngModel)]="fAmount" name="a" placeholder="85,50"></label>
              <label>Compteur km<input type="number" step="1" min="0" [(ngModel)]="fOdo" name="o" placeholder="10300"></label>
            </div>
            <label class="fcal-form-check"><input type="checkbox" [(ngModel)]="fFull" name="f"> Plein complet (requis pour la mesure)</label>
            @if (formError(); as e) { <p class="fcal-err">{{ e }}</p> }
            <div class="fcal-form-actions">
              <button type="button" class="fcal-btn fcal-btn--ghost" (click)="closeForm()">Annuler</button>
              <button type="submit" class="fcal-btn" [disabled]="saving()">
                @if (saving()) { <span class="fcal-spin fcal-spin--sm"></span> } @else { <lucide-icon [img]="CheckIcon" [size]="14"></lucide-icon> } Enregistrer
              </button>
            </div>
          </form>
        } @else {
          <button type="button" class="fcal-add" (click)="openForm()"><lucide-icon [img]="PlusIcon" [size]="14"></lucide-icon> Renseigner un plein</button>
        }

        <!-- Liste des pleins -->
        @if (d.fillUps.length) {
          <ul class="fcal-list">
            @for (f of d.fillUps; track f.id) {
              <li class="fcal-fill">
                <div class="fcal-fill-main">
                  <span class="fcal-fill-date">{{ f.filledAt | date:'dd/MM/yy' }}</span>
                  <span class="fcal-fill-liters">{{ f.litersFilled | number:'1.0-1' }} L</span>
                  @if (f.amountPaidEur != null) { <span class="fcal-fill-amount">{{ f.amountPaidEur | number:'1.2-2' }} €</span> }
                  @if (!f.fullTank) { <span class="fcal-fill-partial">partiel</span> }
                </div>
                <div class="fcal-fill-sub">
                  @if (f.realConsumptionL100km != null) { <span class="fcal-fill-cons">{{ f.realConsumptionL100km | number:'1.1-1' }} L/100 · {{ f.distanceSinceKm | number:'1.0-0' }} km</span> }
                  @else if (f.distanceSinceKm != null) { <span>{{ f.distanceSinceKm | number:'1.0-0' }} km depuis le dernier</span> }
                  <button type="button" class="fcal-del" (click)="remove(f.id)" title="Supprimer" aria-label="Supprimer"><lucide-icon [img]="TrashIcon" [size]="12"></lucide-icon></button>
                </div>
              </li>
            }
          </ul>
        }
        <p class="fcal-note">Méthode du plein : la consommation réelle = litres ÷ distance entre 2 pleins complets. C'est la façon la plus fiable de mesurer la conso sans capteur. Les coûts et rapports utilisent automatiquement cette valeur dès qu'elle est mesurée.</p>
      } @else {
        <p class="fcal-note">Suivi indisponible.</p>
      }
    </section>
  `,
  styles: [`
    .fcal { display: flex; flex-direction: column; gap: 11px; padding: 14px 16px; border-radius: 14px; background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .fcal-head { display: flex; align-items: center; justify-content: space-between; }
    .fcal-title { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; color: var(--fg-tertiary); }
    .fcal-title lucide-icon { color: #F59E0B; }
    .fcal-conf { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 800; padding: 2px 8px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-tertiary); }
    .fcal-conf[data-conf="low"] { background: color-mix(in srgb,#F59E0B 15%,transparent); color: #F59E0B; }
    .fcal-conf[data-conf="medium"] { background: color-mix(in srgb,#84CC16 15%,transparent); color: #84CC16; }
    .fcal-conf[data-conf="high"] { background: color-mix(in srgb,#10E0A0 16%,transparent); color: #10E0A0; }
    .fcal-loading { display: flex; justify-content: center; padding: 16px; }
    .fcal-spin { width: 22px; height: 22px; border: 3px solid var(--border-subtle); border-top-color: #F59E0B; border-radius: 50%; animation: fcal-rot .8s linear infinite; }
    .fcal-spin--sm { width: 13px; height: 13px; border-width: 2px; }
    @keyframes fcal-rot { to { transform: rotate(360deg); } }
    .fcal-cons { display: flex; align-items: center; justify-content: center; gap: 14px; padding: 6px 0; }
    .fcal-cons-col { display: flex; flex-direction: column; align-items: center; }
    .fcal-cons-n { font-size: 26px; font-weight: 800; color: var(--fg-secondary); line-height: 1; }
    .fcal-cons-n--dash { color: var(--fg-tertiary); }
    .fcal-cons-l { font-size: 11px; color: var(--fg-tertiary); margin-top: 3px; }
    .fcal-cons-l small { opacity: .8; }
    .fcal-cons-arrow { color: var(--fg-tertiary); font-size: 18px; }
    .fcal-cons-col--real .fcal-cons-n { color: #10E0A0; }
    .fcal-cons-col--pending .fcal-cons-n { color: var(--fg-tertiary); }
    .fcal-delta { margin: 0; font-size: 12px; line-height: 1.45; padding: 8px 11px; border-radius: 10px; }
    .fcal-delta[data-sign="up"] { background: color-mix(in srgb,#F59E0B 10%,transparent); color: #B45309; }
    .fcal-delta[data-sign="down"] { background: color-mix(in srgb,#10E0A0 10%,transparent); color: #047857; }
    :host-context(:root[data-theme="dark"]) .fcal-delta[data-sign="up"] { color: #FBBF24; }
    :host-context(:root[data-theme="dark"]) .fcal-delta[data-sign="down"] { color: #10E0A0; }
    .fcal-hint { margin: 0; font-size: 11.5px; line-height: 1.5; color: var(--fg-tertiary); padding: 8px 11px; border-radius: 10px; background: var(--bg-tertiary); }
    .fcal-cost { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; font-size: 12.5px; color: var(--fg-secondary); }
    .fcal-cost span { display: inline-flex; align-items: center; gap: 5px; }
    .fcal-cost lucide-icon { color: #F59E0B; }
    .fcal-cost strong { font-size: 15px; font-weight: 800; color: var(--fg-primary); }
    .fcal-cost--real strong { color: #10E0A0; }
    .fcal-cost--real lucide-icon { color: #10E0A0; }
    .fcal-add { display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px; border-radius: 10px; font-size: 12.5px; font-weight: 700; color: #F59E0B; background: color-mix(in srgb,#F59E0B 8%,transparent); border: 1px dashed color-mix(in srgb,#F59E0B 35%,transparent); cursor: pointer; }
    .fcal-add:hover { background: color-mix(in srgb,#F59E0B 14%,transparent); }
    .fcal-form { display: flex; flex-direction: column; gap: 8px; padding: 11px; border-radius: 11px; background: var(--bg-tertiary); border: 1px solid var(--border-subtle); }
    .fcal-form-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .fcal-form label { display: flex; flex-direction: column; gap: 3px; font-size: 11px; font-weight: 600; color: var(--fg-tertiary); }
    .fcal-form input[type=date], .fcal-form input[type=number] { padding: 7px 9px; border-radius: 8px; border: 1.5px solid var(--border-subtle); background: var(--bg-secondary); color: var(--fg-primary); font-size: 13px; font-family: inherit; }
    .fcal-form-check { flex-direction: row !important; align-items: center; gap: 6px; font-size: 11.5px; color: var(--fg-secondary); }
    .fcal-form-actions { display: flex; justify-content: flex-end; gap: 8px; }
    .fcal-btn { display: inline-flex; align-items: center; gap: 5px; padding: 8px 13px; border-radius: 9px; font-size: 12.5px; font-weight: 800; cursor: pointer; background: #F59E0B; color: #1c1207; border: none; }
    .fcal-btn:disabled { opacity: .6; }
    .fcal-btn--ghost { background: transparent; color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    .fcal-err { margin: 0; font-size: 11.5px; color: #EF4444; }
    .fcal-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
    .fcal-fill { display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 9px; background: var(--bg-tertiary); }
    .fcal-fill-main { display: flex; align-items: center; gap: 8px; font-size: 12.5px; }
    .fcal-fill-date { font-weight: 700; color: var(--fg-secondary); }
    .fcal-fill-liters { font-weight: 800; color: var(--fg-primary); }
    .fcal-fill-amount { color: var(--fg-tertiary); }
    .fcal-fill-partial { font-size: 10px; font-weight: 700; color: #F59E0B; }
    .fcal-fill-sub { display: flex; align-items: center; justify-content: space-between; font-size: 11px; color: var(--fg-tertiary); }
    .fcal-fill-cons { color: #10E0A0; font-weight: 700; }
    .fcal-del { color: var(--fg-tertiary); padding: 2px; cursor: pointer; }
    .fcal-del:hover { color: #EF4444; }
    .fcal-note { margin: 0; font-size: 11px; line-height: 1.5; color: var(--fg-tertiary); }
  `],
})
export class FuelCalibrationCardComponent {
  private readonly api = inject(TripAnalysisApiService);

  readonly vehicleId = input.required<string>();
  readonly days = input<number>(90);

  protected readonly data = signal<VehicleFuelModelDto | null>(null);
  protected readonly loading = signal(true);
  protected readonly showForm = signal(false);
  protected readonly saving = signal(false);
  protected readonly formError = signal<string | null>(null);

  // Champs du formulaire de plein.
  protected fDate = '';
  protected fLiters: number | null = null;
  protected fAmount: number | null = null;
  protected fOdo: number | null = null;
  protected fFull = true;

  protected readonly GaugeIcon = Gauge;
  protected readonly PlusIcon = Plus;
  protected readonly TrashIcon = Trash2;
  protected readonly XIcon = X;
  protected readonly CheckIcon = Check;
  protected readonly FuelIcon = Fuel;
  protected readonly UpIcon = TrendingUp;
  protected readonly DownIcon = TrendingDown;
  protected readonly ShieldIcon = ShieldCheck;

  constructor() {
    effect(() => {
      const id = this.vehicleId();
      if (id) void this.load(id);
    });
  }

  protected confLabel(c: FuelConfidence): string {
    return c === 'high' ? 'Fiable' : c === 'medium' ? 'Assez fiable' : c === 'low' ? 'À confirmer' : 'Estimation';
  }

  protected openForm(): void {
    this.formError.set(null);
    // Pré-remplit la date du jour.
    const now = new Date();
    this.fDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    this.fLiters = null; this.fAmount = null; this.fOdo = null; this.fFull = true;
    this.showForm.set(true);
  }
  protected closeForm(): void { this.showForm.set(false); }

  protected async submit(): Promise<void> {
    if (this.saving()) return;
    if (!this.fDate || this.fLiters == null || this.fLiters <= 0) { this.formError.set('Date et litres sont requis.'); return; }
    this.saving.set(true);
    this.formError.set(null);
    const dto: UpsertFuelFillUpDto = {
      vehicleId: this.vehicleId(),
      filledAt: new Date(`${this.fDate}T08:00:00`).toISOString(),
      litersFilled: Number(this.fLiters),
      amountPaidEur: this.fAmount != null ? Number(this.fAmount) : null,
      odometerKm: this.fOdo != null ? Number(this.fOdo) : null,
      fullTank: this.fFull,
    };
    try {
      await firstValueFrom(this.api.createFillUp(dto));
      this.showForm.set(false);
      await this.load(this.vehicleId());
    } catch (e) {
      this.formError.set(apiErrorMessage(e, 'Enregistrement impossible.'));
    } finally {
      this.saving.set(false);
    }
  }

  protected async remove(id: string): Promise<void> {
    try {
      await firstValueFrom(this.api.deleteFillUp(id));
      await this.load(this.vehicleId());
    } catch { /* silent */ }
  }

  private async load(vehicleId: string): Promise<void> {
    this.loading.set(true);
    try {
      this.data.set(await firstValueFrom(this.api.fuelCalibration(vehicleId, this.fromIso())));
    } catch {
      this.data.set(null);
    } finally {
      this.loading.set(false);
    }
  }
  private fromIso(): string { return new Date(Date.now() - this.days() * 24 * 3600 * 1000).toISOString(); }
}
