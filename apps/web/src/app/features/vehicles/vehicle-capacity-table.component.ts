import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnInit,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import {
  LucideAngularModule, Fuel, Save, Check, X, ArrowLeftRight, AlertTriangle, Loader,
  Info, Users, Baby, ClipboardList, Sparkles,
} from 'lucide-angular';
import type {
  InstallationEnergy,
  VehicleCapacityRowDto,
  VehicleSyncableField,
} from '@vizyo/tracky-shared';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { VehiclesApiService } from '../../core/services/vehicles.service';
import { PermissionsService } from '../../core/services/permissions.service';
import { ToastService } from '../../shared/ui/toast/toast.service';

const ENERGY_LABELS: Record<InstallationEnergy, string> = {
  DIESEL: 'Diesel',
  ESSENCE: 'Essence',
  ELECTRIQUE: 'Électrique',
  HYBRIDE: 'Hybride',
  AUTRE: 'Autre',
};
const ENERGIES: InstallationEnergy[] = ['DIESEL', 'ESSENCE', 'ELECTRIQUE', 'HYBRIDE', 'AUTRE'];
const FIELD_LABELS: Record<VehicleSyncableField, string> = {
  brand: 'Marque',
  model: 'Modèle',
  energy: 'Énergie',
};

interface EditRow extends VehicleCapacityRowDto {
  draftSeats: string;
  draftChildSeats: string;
  draftFeatures: string;
  draftEnergy: InstallationEnergy | '';
  saving: boolean;
  syncing: boolean;
}

/**
 * Sprint 10 — Vue « Parc & capacités ». Un endroit unique pour voir QUI a QUOI et éditer
 * la capacité (places / sièges-enfant / équipements / énergie) de chaque véhicule, avec en
 * regard le modèle/énergie issus du planning d'installation + une synchro 1-clic (aperçu des
 * écarts, application au choix). Édition gardée `vehicles_edit` (lecture seule sinon).
 */
@Component({
  selector: 'app-vehicle-capacity-table',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, RouterLink],
  template: `
    <div class="cap">
      <div class="cap-head">
        <div class="cap-intro">
          <p class="cap-lead">Capacité de chaque véhicule, alignée sur les données du planning d'installation.</p>
          <p class="cap-hint"><lucide-icon [img]="SparklesIcon" [size]="12"></lucide-icon> Remplissage assisté par IA : <a routerLink="/agenda" class="cap-link">Agenda → Optimisation</a>.</p>
        </div>
        @if (!canEdit()) {
          <span class="cap-ro"><lucide-icon [img]="InfoIcon" [size]="13"></lucide-icon> Lecture seule — droit « Modifier un véhicule » requis pour éditer.</span>
        }
      </div>

      @if (loading()) {
        <div class="cap-skel"></div><div class="cap-skel"></div><div class="cap-skel"></div>
      } @else if (error()) {
        <div class="cap-alert"><lucide-icon [img]="AlertIcon" [size]="14"></lucide-icon> {{ error() }}</div>
      } @else if (rows().length === 0) {
        <div class="cap-empty"><lucide-icon [img]="ClipboardIcon" [size]="34" class="cap-empty-ic"></lucide-icon><p>Aucun véhicule sur ce périmètre.</p></div>
      } @else {
        <div class="cap-grid">
          @for (r of rows(); track r.vehicleId) {
            <article class="cap-card" [class.cap-card--dirty]="isDirty(r)">
              <!-- Identité -->
              <header class="cap-card-head">
                <div class="cap-id">
                  <span class="cap-plate">{{ r.plate }}</span>
                  <span class="cap-model">{{ r.brand || '—' }} {{ r.model || '' }}</span>
                </div>
                <div class="cap-id-right">
                  @if (r.group) { <span class="cap-group">{{ r.group.name }}</span> }
                  @if (r.energy) { <span class="cap-energy"><lucide-icon [img]="FuelIcon" [size]="11"></lucide-icon> {{ energyLabel(r.energy) }}</span> }
                </div>
              </header>

              <!-- Source planning + synchro -->
              @if (r.installationSource; as src) {
                <div class="cap-src">
                  <span class="cap-src-label"><lucide-icon [img]="ClipboardIcon" [size]="11"></lucide-icon> Planning{{ src.planName ? ' · ' + src.planName : '' }} :</span>
                  <span class="cap-src-val">{{ src.brand || '—' }} {{ src.model || '' }}@if (src.energy) { · {{ energyLabel(src.energy) }} }</span>
                  @if (canEdit() && r.divergentFields.length > 0) {
                    <button type="button" class="cap-sync-btn" (click)="openSync(r)">
                      <lucide-icon [img]="SyncIcon" [size]="12"></lucide-icon> Synchroniser
                    </button>
                  } @else if (r.divergentFields.length === 0) {
                    <span class="cap-sync-ok"><lucide-icon [img]="CheckIcon" [size]="11"></lucide-icon> à jour</span>
                  }
                </div>

                <!-- Aperçu synchro (écarts, application au choix) -->
                @if (syncOpenId() === r.vehicleId) {
                  <div class="cap-sync-panel">
                    <p class="cap-sync-title">Recopier du planning vers le véhicule :</p>
                    @for (f of r.divergentFields; track f) {
                      <label class="cap-sync-row">
                        <input type="checkbox" [checked]="syncSel().has(f)" (change)="toggleSyncField(f)">
                        <span class="cap-sync-field">{{ fieldLabel(f) }}</span>
                        <span class="cap-sync-diff"><span class="cap-sync-old">{{ currentVal(r, f) || '—' }}</span> <lucide-icon [img]="SyncIcon" [size]="11"></lucide-icon> <span class="cap-sync-new">{{ sourceVal(r, f) || '—' }}</span></span>
                      </label>
                    }
                    <div class="cap-sync-actions">
                      <button type="button" class="cap-btn cap-btn--ghost" (click)="closeSync()">Annuler</button>
                      <button type="button" class="cap-btn cap-btn--primary" [disabled]="r.syncing || syncSel().size === 0" (click)="applySync(r)">
                        @if (r.syncing) { <lucide-icon [img]="LoaderIcon" [size]="13" class="cap-spin"></lucide-icon> }
                        Appliquer
                      </button>
                    </div>
                  </div>
                }
              } @else {
                <div class="cap-src cap-src--none"><lucide-icon [img]="InfoIcon" [size]="11"></lucide-icon> Aucun planning d'installation lié.</div>
              }

              <!-- Capacité éditable -->
              <div class="cap-fields">
                <label class="cap-f">
                  <span><lucide-icon [img]="UsersIcon" [size]="12"></lucide-icon> Places</span>
                  <input type="number" min="1" max="99" inputmode="numeric" class="cap-in" [disabled]="!canEdit()"
                         [value]="r.draftSeats" (input)="patch(r, 'draftSeats', $any($event.target).value)">
                </label>
                <label class="cap-f">
                  <span><lucide-icon [img]="BabyIcon" [size]="12"></lucide-icon> Sièges-enfant</span>
                  <input type="number" min="0" max="20" inputmode="numeric" class="cap-in" [disabled]="!canEdit()"
                         [value]="r.draftChildSeats" (input)="patch(r, 'draftChildSeats', $any($event.target).value)">
                </label>
                <label class="cap-f">
                  <span><lucide-icon [img]="FuelIcon" [size]="12"></lucide-icon> Énergie</span>
                  <select class="cap-in" [disabled]="!canEdit()" [value]="r.draftEnergy" (change)="patch(r, 'draftEnergy', $any($event.target).value)">
                    <option value="">—</option>
                    @for (e of energies; track e) { <option [value]="e">{{ energyLabel(e) }}</option> }
                  </select>
                </label>
                <label class="cap-f cap-f--wide">
                  <span><lucide-icon [img]="ClipboardIcon" [size]="12"></lucide-icon> Équipements (séparés par des virgules)</span>
                  <input type="text" class="cap-in" [disabled]="!canEdit()" placeholder="Ex. climatisation, hayon, GPS"
                         [value]="r.draftFeatures" (input)="patch(r, 'draftFeatures', $any($event.target).value)">
                </label>
              </div>

              @if (canEdit()) {
                <div class="cap-card-foot">
                  @if (isDirty(r)) { <button type="button" class="cap-btn cap-btn--ghost" (click)="resetRow(r)">Annuler</button> }
                  <button type="button" class="cap-btn cap-btn--primary" [disabled]="!isDirty(r) || r.saving" (click)="save(r)">
                    @if (r.saving) { <lucide-icon [img]="LoaderIcon" [size]="13" class="cap-spin"></lucide-icon> } @else { <lucide-icon [img]="SaveIcon" [size]="13"></lucide-icon> }
                    Enregistrer
                  </button>
                </div>
              }
            </article>
          }
        </div>
      }
    </div>
  `,
  styles: [`
    .cap { display: flex; flex-direction: column; gap: 12px; }
    .cap-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .cap-lead { font-size: 13px; color: var(--fg-secondary); }
    .cap-hint { font-size: 12px; color: var(--fg-tertiary); display: flex; align-items: center; gap: 5px; margin-top: 3px; }
    .cap-hint lucide-icon { color: var(--tracky-light); }
    .cap-link { color: var(--tracky-light); font-weight: 600; }
    .cap-ro { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; color: var(--fg-tertiary); background: var(--bg-secondary); border: 1px solid var(--border-subtle); border-radius: 9px; padding: 6px 10px; }
    .cap-grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 720px) { .cap-grid { grid-template-columns: 1fr 1fr; } }
    @media (min-width: 1180px) { .cap-grid { grid-template-columns: 1fr 1fr 1fr; } }
    .cap-card { display: flex; flex-direction: column; gap: 10px; padding: 14px; border-radius: var(--radius-card, 16px); background: var(--bg-secondary); border: 1px solid var(--border-subtle); transition: border-color .15s; }
    .cap-card--dirty { border-color: rgba(16,224,160,.4); }
    .cap-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; }
    .cap-id { display: flex; flex-direction: column; min-width: 0; }
    .cap-plate { font-family: var(--font-mono, monospace); font-weight: 800; font-size: 15px; color: var(--fg-primary); letter-spacing: .4px; }
    .cap-model { font-size: 12px; color: var(--fg-tertiary); margin-top: 1px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .cap-id-right { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; flex-shrink: 0; }
    .cap-group { font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: var(--bg-tertiary); color: var(--fg-secondary); }
    .cap-energy { display: inline-flex; align-items: center; gap: 4px; font-size: 10.5px; font-weight: 700; padding: 2px 8px; border-radius: 999px; background: rgba(56,189,248,.14); color: #38BDF8; }
    .cap-src { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 11.5px; padding: 8px 10px; border-radius: 10px; background: var(--bg-tertiary); }
    .cap-src--none { color: var(--fg-tertiary); }
    .cap-src-label { color: var(--fg-tertiary); display: inline-flex; align-items: center; gap: 4px; }
    .cap-src-val { color: var(--fg-secondary); font-weight: 600; }
    .cap-sync-btn { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 700; color: #F59E0B; background: rgba(245,158,11,.12); border-radius: 8px; padding: 4px 9px; }
    .cap-sync-ok { margin-left: auto; display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--tracky-light); }
    .cap-sync-panel { display: flex; flex-direction: column; gap: 7px; padding: 10px; border-radius: 10px; background: var(--bg-primary); border: 1px dashed var(--border-strong); }
    .cap-sync-title { font-size: 11.5px; font-weight: 700; color: var(--fg-secondary); }
    .cap-sync-row { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    .cap-sync-row input { width: 16px; height: 16px; accent-color: var(--tracky-light); }
    .cap-sync-field { font-weight: 600; color: var(--fg-secondary); min-width: 56px; }
    .cap-sync-diff { display: inline-flex; align-items: center; gap: 6px; color: var(--fg-tertiary); }
    .cap-sync-old { text-decoration: line-through; opacity: .7; }
    .cap-sync-new { color: var(--tracky-light); font-weight: 700; }
    .cap-sync-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 2px; }
    .cap-fields { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .cap-f { display: flex; flex-direction: column; gap: 4px; font-size: 11px; color: var(--fg-tertiary); }
    .cap-f--wide { grid-column: 1 / -1; }
    .cap-f > span { display: inline-flex; align-items: center; gap: 5px; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; }
    .cap-in { width: 100%; padding: 9px 10px; border-radius: 9px; background: var(--bg-primary); border: 1px solid var(--border-subtle); color: var(--fg-primary); font-size: 16px; }
    .cap-in:focus { outline: none; border-color: var(--tracky-light); }
    .cap-in:disabled { opacity: .6; cursor: not-allowed; }
    .cap-card-foot { display: flex; justify-content: flex-end; gap: 8px; }
    .cap-btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 9px; font-size: 12.5px; font-weight: 700; }
    .cap-btn--primary { background: var(--tracky, #10B981); color: #fff; }
    .cap-btn--primary:disabled { opacity: .5; }
    .cap-btn--ghost { background: var(--bg-tertiary); color: var(--fg-secondary); border: 1px solid var(--border-subtle); }
    .cap-alert { display: flex; align-items: center; gap: 8px; padding: 11px 13px; border-radius: 11px; background: rgba(239,68,68,.1); color: #EF4444; font-size: 13px; }
    .cap-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 36px; text-align: center; color: var(--fg-tertiary); font-size: 13px; }
    .cap-empty-ic { opacity: .3; }
    .cap-skel { height: 150px; border-radius: var(--radius-card, 16px); background: linear-gradient(90deg, var(--bg-secondary), var(--bg-tertiary), var(--bg-secondary)); background-size: 200% 100%; animation: cap-sh 1.3s infinite; }
    @keyframes cap-sh { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }
    .cap-spin { animation: cap-spin 1s linear infinite; }
    @keyframes cap-spin { to { transform: rotate(360deg); } }
  `],
})
export class VehicleCapacityTableComponent implements OnInit {
  private readonly api = inject(VehiclesApiService);
  private readonly perms = inject(PermissionsService);
  private readonly toast = inject(ToastService);

  protected readonly FuelIcon = Fuel;
  protected readonly SaveIcon = Save;
  protected readonly CheckIcon = Check;
  protected readonly XIcon = X;
  protected readonly SyncIcon = ArrowLeftRight;
  protected readonly AlertIcon = AlertTriangle;
  protected readonly LoaderIcon = Loader;
  protected readonly InfoIcon = Info;
  protected readonly UsersIcon = Users;
  protected readonly BabyIcon = Baby;
  protected readonly ClipboardIcon = ClipboardList;
  protected readonly SparklesIcon = Sparkles;
  protected readonly energies = ENERGIES;

  protected readonly canEdit = computed(() => this.perms.can('vehicles_edit'));
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly rows = signal<EditRow[]>([]);

  // Aperçu de synchro : véhicule ouvert + champs cochés.
  protected readonly syncOpenId = signal<string | null>(null);
  protected readonly syncSel = signal<Set<VehicleSyncableField>>(new Set());

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  protected energyLabel(e: InstallationEnergy): string { return ENERGY_LABELS[e]; }
  protected fieldLabel(f: VehicleSyncableField): string { return FIELD_LABELS[f]; }

  private toEditRow(r: VehicleCapacityRowDto): EditRow {
    return {
      ...r,
      draftSeats: r.seats != null ? String(r.seats) : '',
      draftChildSeats: r.childSeats != null ? String(r.childSeats) : '',
      draftFeatures: (r.features ?? []).join(', '),
      draftEnergy: r.energy ?? '',
      saving: false,
      syncing: false,
    };
  }

  private async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    try {
      const data = await firstValueFrom(this.api.capacityOverview());
      this.rows.set(data.map((r) => this.toEditRow(r)));
    } catch (e) {
      this.error.set(this.errMsg(e));
    } finally {
      this.loading.set(false);
    }
  }

  protected isDirty(r: EditRow): boolean {
    return (
      r.draftSeats !== (r.seats != null ? String(r.seats) : '') ||
      r.draftChildSeats !== (r.childSeats != null ? String(r.childSeats) : '') ||
      r.draftFeatures !== (r.features ?? []).join(', ') ||
      (r.draftEnergy || '') !== (r.energy ?? '')
    );
  }

  /** Mise à jour immuable d'un champ de brouillon (OnPush-safe). */
  protected patch(row: EditRow, key: 'draftSeats' | 'draftChildSeats' | 'draftFeatures' | 'draftEnergy', value: string): void {
    this.rows.update((list) => list.map((r) => (r.vehicleId === row.vehicleId ? { ...r, [key]: value } : r)));
  }

  protected resetRow(row: EditRow): void {
    this.rows.update((list) => list.map((r) => (r.vehicleId === row.vehicleId ? this.toEditRow(r) : r)));
  }

  private parseIntOrNull(s: string, min: number, max: number): number | null {
    const n = parseInt(s, 10);
    if (!Number.isFinite(n)) return null;
    return Math.min(max, Math.max(min, n));
  }

  protected async save(row: EditRow): Promise<void> {
    if (!this.canEdit() || row.saving) return;
    const seats = this.parseIntOrNull(row.draftSeats, 1, 99);
    const childSeats = this.parseIntOrNull(row.draftChildSeats, 0, 20);
    const features = row.draftFeatures.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 30);
    const energy = (row.draftEnergy || null) as InstallationEnergy | null;
    // Le DTO d'update ne valide pas `seats:null` (Min 1) — on n'envoie le champ que s'il a une valeur ;
    // un champ vidé reste donc à sa valeur précédente (capacité non destructive côté formulaire).
    const payload: Record<string, unknown> = { features, energy };
    if (seats != null) payload['seats'] = seats;
    if (childSeats != null) payload['childSeats'] = childSeats;

    this.setRow(row.vehicleId, { saving: true });
    try {
      const updated = await firstValueFrom(this.api.update(row.vehicleId, payload));
      this.rows.update((list) =>
        list.map((r) =>
          r.vehicleId === row.vehicleId
            ? this.toEditRow({
                ...r,
                seats: updated.seats,
                childSeats: updated.childSeats,
                features: updated.features ?? [],
                energy: updated.energy,
              })
            : r,
        ),
      );
      this.toast.success('Capacité enregistrée', row.plate);
    } catch (e) {
      this.setRow(row.vehicleId, { saving: false });
      this.toast.error('Échec', this.errMsg(e));
    }
  }

  // ─── Synchro depuis le planning ───
  protected openSync(row: EditRow): void {
    this.syncSel.set(new Set(row.divergentFields));
    this.syncOpenId.set(row.vehicleId);
  }
  protected closeSync(): void {
    this.syncOpenId.set(null);
    this.syncSel.set(new Set());
  }
  protected toggleSyncField(f: VehicleSyncableField): void {
    const next = new Set(this.syncSel());
    if (next.has(f)) next.delete(f); else next.add(f);
    this.syncSel.set(next);
  }
  protected currentVal(r: EditRow, f: VehicleSyncableField): string {
    if (f === 'energy') return r.energy ? this.energyLabel(r.energy) : '';
    return (r[f] as string | null) ?? '';
  }
  protected sourceVal(r: EditRow, f: VehicleSyncableField): string {
    const s = r.installationSource;
    if (!s) return '';
    if (f === 'energy') return s.energy ? this.energyLabel(s.energy) : '';
    return (s[f] as string | null) ?? '';
  }

  protected async applySync(row: EditRow): Promise<void> {
    const fields = [...this.syncSel()];
    if (!this.canEdit() || row.syncing || fields.length === 0) return;
    this.setRow(row.vehicleId, { syncing: true });
    try {
      const updated = await firstValueFrom(this.api.syncFromInstallation(row.vehicleId, fields));
      // Recalcule les écarts résiduels vs la source (un champ peut rester divergent s'il n'a pas été coché).
      this.rows.update((list) =>
        list.map((r) => {
          if (r.vehicleId !== row.vehicleId) return r;
          const merged: VehicleCapacityRowDto = {
            ...r,
            brand: updated.brand,
            model: updated.model,
            energy: updated.energy,
            divergentFields: this.recomputeDivergent(r, updated.brand, updated.model, updated.energy),
          };
          return this.toEditRow(merged);
        }),
      );
      this.toast.success('Synchronisé depuis le planning', row.plate);
      this.closeSync();
    } catch (e) {
      this.setRow(row.vehicleId, { syncing: false });
      this.toast.error('Échec de la synchro', this.errMsg(e));
    }
  }

  private recomputeDivergent(
    r: EditRow,
    brand: string | null,
    model: string | null,
    energy: InstallationEnergy | null,
  ): VehicleSyncableField[] {
    const s = r.installationSource;
    if (!s) return [];
    const out: VehicleSyncableField[] = [];
    if (s.brand && s.brand !== brand) out.push('brand');
    if (s.model && s.model !== model) out.push('model');
    if (s.energy && s.energy !== energy) out.push('energy');
    return out;
  }

  /** Patch immuable de quelques champs d'état d'une ligne (saving/syncing). */
  private setRow(vehicleId: string, partial: Partial<EditRow>): void {
    this.rows.update((list) => list.map((r) => (r.vehicleId === vehicleId ? { ...r, ...partial } : r)));
  }

  private errMsg(e: unknown): string {
    if (e instanceof HttpErrorResponse) {
      const m = (e.error as { message?: string } | null)?.message;
      if (m) return Array.isArray(m) ? m.join(', ') : m;
      return `Erreur (${e.status}).`;
    }
    return 'Une erreur est survenue.';
  }
}
