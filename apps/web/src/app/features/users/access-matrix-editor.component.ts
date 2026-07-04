import { Component, computed, inject, input, OnInit, output } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideAngularModule, Globe, FolderOpen, Truck, Trash2 } from 'lucide-angular';
import {
  getDefaultPermissions,
  PERMISSION_GROUP_ORDER,
  PERMISSION_LABELS,
  type UserPermissions,
  type UserRoleSlug,
} from '@vizyo/tracky-shared';
import type { VehicleGroup } from '../../core/services/vehicle-groups.service';
import type { VehicleDetailDto } from '../../core/services/vehicles.service';

/**
 * Un scope d'accès éditable EN MÉMOIRE (buffered). `permissions` est PARTIEL :
 * seules les clés explicitement basculées y figurent ; les autres HÉRITENT des
 * défauts du rôle (même sémantique que la matrice live UserVehicleAccess).
 * `_key` = clé locale de tracking (@for), non persistée.
 */
export interface EditableAccessScope {
  _key: string;
  type: 'ALL' | 'GROUP' | 'VEHICLE';
  groupId?: string | null;
  vehicleId?: string | null;
  permissions: Record<string, boolean>;
}

/**
 * Éditeur présentiel de la matrice « Accès & Permissions », SANS aucun appel API.
 * Contrôlé : reçoit `scopes` et émet `scopesChange` à chaque mutation. Réutilisable
 * à l'invitation (buffered → émis au Save du drawer) comme partout où l'on veut
 * éditer des scopes hors persistance immédiate. Le set de permissions et les groupes
 * viennent de la SOURCE PARTAGÉE (PERMISSION_LABELS / PERMISSION_GROUP_ORDER).
 */
@Component({
  selector: 'app-access-matrix-editor',
  standalone: true,
  imports: [FormsModule, LucideAngularModule],
  template: `
    <div class="ame-add">
      <span class="ame-add-label">Ajouter un scope :</span>
      @if (!hasAll()) {
        <button type="button" (click)="addAll()" class="ame-add-btn">
          <lucide-icon [img]="GlobeIcon" [size]="13"></lucide-icon> Toute la flotte
        </button>
      }
      <select [(ngModel)]="newGroupId" class="ame-select" [disabled]="availableGroups().length === 0">
        <option [ngValue]="null">+ Groupe…</option>
        @for (g of availableGroups(); track g.id) {
          <option [ngValue]="g.id">{{ g.name }}</option>
        }
      </select>
      @if (newGroupId) { <button type="button" (click)="addGroup()" class="ame-confirm">Ajouter</button> }
      <select [(ngModel)]="newVehicleId" class="ame-select" [disabled]="availableVehicles().length === 0">
        <option [ngValue]="null">+ Véhicule…</option>
        @for (v of availableVehicles(); track v.id) {
          <option [ngValue]="v.id">{{ v.plate }}</option>
        }
      </select>
      @if (newVehicleId) { <button type="button" (click)="addVehicle()" class="ame-confirm">Ajouter</button> }
    </div>

    @if (scopes().length === 0) {
      <div class="ame-empty">Aucun scope d'accès. Ajoutez-en un ci-dessus.</div>
    }

    @for (scope of scopes(); track scope._key) {
      <div class="ame-card">
        <div class="ame-card-head">
          <div class="ame-scope">
            @if (scope.type === 'ALL') {
              <lucide-icon [img]="GlobeIcon" [size]="15"></lucide-icon><span>Toute la flotte</span>
            } @else if (scope.type === 'GROUP') {
              <lucide-icon [img]="FolderIcon" [size]="15"></lucide-icon><span>Groupe : {{ groupName(scope.groupId) }}</span>
            } @else {
              <lucide-icon [img]="TruckIcon" [size]="15"></lucide-icon><span>Véhicule : {{ vehiclePlate(scope.vehicleId) }}</span>
            }
          </div>
          @if (scopes().length > 1) {
            <button type="button" (click)="remove(scope)" class="ame-del" title="Retirer ce scope">
              <lucide-icon [img]="TrashIcon" [size]="14"></lucide-icon>
            </button>
          }
        </div>
        @for (grp of visibleGroups(); track grp.group) {
          <div class="ame-grp">
            <p class="ame-grp-title">{{ grp.group }}</p>
            <div class="ame-grid">
              @for (k of grp.keys; track k) {
                <label class="ame-perm">
                  <input type="checkbox" [checked]="isChecked(scope, k)"
                         (change)="toggle(scope, k, $any($event.target).checked)" />
                  <span>{{ labelOf(k) }}</span>
                </label>
              }
            </div>
          </div>
        }
      </div>
    }
  `,
  styles: [`
    .ame-add { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:10px 12px; border:1px solid var(--border-subtle); border-radius:12px; background:var(--bg-secondary); margin-bottom:12px }
    .ame-add-label { font-size:12px; color:var(--fg-secondary); font-weight:500 }
    .ame-add-btn { display:inline-flex; align-items:center; gap:5px; font-size:12px; padding:5px 10px; border-radius:8px; background:var(--tracky); color:#fff; border:none; cursor:pointer }
    .ame-select { padding:5px 8px; font-size:12px; border-radius:8px; background:var(--bg-tertiary); border:1px solid var(--border-subtle); color:var(--fg-primary); cursor:pointer }
    .ame-select:disabled { opacity:.4; cursor:not-allowed }
    .ame-confirm { padding:5px 10px; font-size:12px; border-radius:8px; background:var(--tracky); color:#fff; border:none; cursor:pointer }
    .ame-empty { padding:20px; text-align:center; font-size:13px; color:var(--fg-tertiary); border:1px dashed var(--border-subtle); border-radius:12px }
    .ame-card { border:1px solid var(--border-subtle); border-radius:12px; padding:12px 14px; background:var(--bg-secondary); margin-bottom:10px }
    .ame-card-head { display:flex; align-items:center; justify-content:space-between; margin-bottom:10px }
    .ame-scope { display:flex; align-items:center; gap:8px; font-size:14px; font-weight:600; color:var(--fg-primary) }
    .ame-scope lucide-icon { color:var(--tracky-light) }
    .ame-del { padding:4px; border-radius:6px; border:none; background:transparent; color:var(--fg-tertiary); cursor:pointer }
    .ame-del:hover { color:#f87171; background:rgba(248,113,113,.1) }
    .ame-grp { margin-bottom:8px }
    .ame-grp:last-child { margin-bottom:0 }
    .ame-grp-title { font-size:10px; text-transform:uppercase; letter-spacing:.04em; color:var(--fg-tertiary); margin:0 0 6px }
    .ame-grid { display:grid; grid-template-columns:1fr 1fr; gap:2px 12px }
    @media (max-width: 460px) { .ame-grid { grid-template-columns:1fr } }
    .ame-perm { display:flex; align-items:center; gap:7px; font-size:13px; color:var(--fg-primary); padding:3px 4px; border-radius:6px; cursor:pointer }
    .ame-perm:hover { background:var(--bg-tertiary) }
  `],
})
export class AccessMatrixEditorComponent implements OnInit {
  readonly scopes = input.required<EditableAccessScope[]>();
  readonly groups = input<VehicleGroup[]>([]);
  readonly vehicles = input<VehicleDetailDto[]>([]);
  readonly role = input.required<UserRoleSlug>();
  /** Fail-closed : la permission audio n'apparaît QUE si la flotte est éligible N1. */
  readonly audioEligible = input(false);

  readonly scopesChange = output<EditableAccessScope[]>();

  protected readonly GlobeIcon = Globe;
  protected readonly FolderIcon = FolderOpen;
  protected readonly TruckIcon = Truck;
  protected readonly TrashIcon = Trash2;

  protected newGroupId: string | null = null;
  protected newVehicleId: string | null = null;

  private permissionGroups: readonly string[] = [];
  private permissionsByGroup: Record<string, (keyof UserPermissions)[]> = {};

  ngOnInit(): void {
    this.permissionGroups = PERMISSION_GROUP_ORDER ?? [];
    const labels = PERMISSION_LABELS ?? {};
    const byGroup: Record<string, (keyof UserPermissions)[]> = {};
    for (const key of Object.keys(labels) as (keyof UserPermissions)[]) {
      const g = labels[key]?.group;
      if (!g) continue;
      (byGroup[g] ??= []).push(key);
    }
    this.permissionsByGroup = byGroup;
  }

  protected readonly hasAll = computed(() => this.scopes().some((s) => s.type === 'ALL'));
  private readonly usedGroupIds = computed(() => new Set(this.scopes().filter((s) => s.groupId).map((s) => s.groupId!)));
  private readonly usedVehicleIds = computed(() => new Set(this.scopes().filter((s) => s.vehicleId).map((s) => s.vehicleId!)));
  protected readonly availableGroups = computed(() => this.groups().filter((g) => !this.usedGroupIds().has(g.id)));
  protected readonly availableVehicles = computed(() => this.vehicles().filter((v) => !this.usedVehicleIds().has(v.id)));

  /** Groupes de permissions affichés : audio masqué tant que la flotte n'est pas éligible. */
  protected readonly visibleGroups = computed<{ group: string; keys: (keyof UserPermissions)[] }[]>(() => {
    const audioOk = this.audioEligible();
    return this.permissionGroups
      .map((group) => ({
        group,
        keys: (this.permissionsByGroup[group] ?? []).filter((k) => audioOk || k !== 'audio_monitoring'),
      }))
      .filter((g) => g.keys.length > 0);
  });

  protected labelOf(k: keyof UserPermissions): string { return PERMISSION_LABELS[k].label; }
  protected groupName(id: string | null | undefined): string { return this.groups().find((g) => g.id === id)?.name ?? '?'; }
  protected vehiclePlate(id: string | null | undefined): string { return this.vehicles().find((v) => v.id === id)?.plate ?? '?'; }

  /** Case cochée ? clé explicite du scope, sinon héritage du défaut de rôle. */
  protected isChecked(scope: EditableAccessScope, key: keyof UserPermissions): boolean {
    if (key in scope.permissions) return scope.permissions[key] === true;
    return getDefaultPermissions(this.role())[key] === true;
  }

  protected toggle(scope: EditableAccessScope, key: keyof UserPermissions, value: boolean): void {
    this.emit(this.scopes().map((s) =>
      s._key === scope._key ? { ...s, permissions: { ...s.permissions, [key]: value } } : s,
    ));
  }

  protected addAll(): void {
    this.emit([{ _key: this.newKey(), type: 'ALL', permissions: {} }, ...this.scopes()]);
  }
  protected addGroup(): void {
    if (!this.newGroupId) return;
    this.emit([...this.scopes(), { _key: this.newKey(), type: 'GROUP', groupId: this.newGroupId, permissions: {} }]);
    this.newGroupId = null;
  }
  protected addVehicle(): void {
    if (!this.newVehicleId) return;
    this.emit([...this.scopes(), { _key: this.newKey(), type: 'VEHICLE', vehicleId: this.newVehicleId, permissions: {} }]);
    this.newVehicleId = null;
  }
  protected remove(scope: EditableAccessScope): void {
    if (this.scopes().length <= 1) return;
    this.emit(this.scopes().filter((s) => s._key !== scope._key));
  }

  private emit(next: EditableAccessScope[]): void { this.scopesChange.emit(next); }
  private newKey(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    return c?.randomUUID ? c.randomUUID() : 'k' + Date.now() + Math.round(Math.random() * 1e6);
  }
}
