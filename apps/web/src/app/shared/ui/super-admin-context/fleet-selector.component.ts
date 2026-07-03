import { Component, computed, inject, signal } from '@angular/core';
import { Building2, ChevronDown, Check, LucideAngularModule } from 'lucide-angular';
import { AuthService } from '../../../core/services/auth.service';
import { FleetCacheService } from '../../../core/services/fleet-cache.service';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';

/**
 * Selecteur de societe global — SUPER_ADMIN uniquement.
 *
 * Rendu dans le top-bar du shell (dashboard-layout). Ecrit dans
 * FleetFilterService, que les pages "liste" consomment pour filtrer leurs
 * lignes par flotte. Dropdown CUSTOM (le <select> natif rendait une liste
 * d'options au style systeme, illisible sur le theme sombre). Ne rend RIEN
 * pour les non-SA.
 */
@Component({
  selector: 'app-fleet-selector',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (isSuperAdmin()) {
      <div class="fs-wrap">
        <button
          type="button"
          class="fleet-selector"
          [class.is-active]="selected() !== null"
          [class.open]="open()"
          (click)="toggle($event)"
          aria-haspopup="listbox"
          [attr.aria-expanded]="open()"
          aria-label="Filtrer par société">
          <lucide-icon [img]="BuildingIcon" [size]="14" class="fs-icon" aria-hidden="true"></lucide-icon>
          <span class="fs-label">{{ currentLabel() }}</span>
          <lucide-icon [img]="ChevronIcon" [size]="14" class="fs-chev" [class.up]="open()" aria-hidden="true"></lucide-icon>
        </button>

        @if (open()) {
          <div class="fs-menu" role="listbox">
            <button type="button" class="fs-opt" [class.sel]="selected() === null" role="option" [attr.aria-selected]="selected() === null" (click)="pick(null)">
              <span class="fs-opt-txt">Toutes les sociétés</span>
              @if (selected() === null) { <lucide-icon [img]="CheckIcon" [size]="15" class="fs-opt-check"></lucide-icon> }
            </button>
            @for (f of fleetList(); track f.id) {
              <button type="button" class="fs-opt" [class.sel]="selected() === f.id" role="option" [attr.aria-selected]="selected() === f.id" (click)="pick(f.id)">
                <span class="fs-opt-txt">{{ f.name }}</span>
                @if (selected() === f.id) { <lucide-icon [img]="CheckIcon" [size]="15" class="fs-opt-check"></lucide-icon> }
              </button>
            }
          </div>
          <div class="fs-backdrop" (click)="close()"></div>
        }
      </div>
    }
  `,
  styles: [`
    .fs-wrap { position: relative; }
    .fleet-selector {
      display: inline-flex; align-items: center; gap: 6px;
      height: 34px; padding: 0 8px 0 10px; border-radius: 10px;
      background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
      color: var(--fg-secondary); cursor: pointer;
      transition: border-color .2s, color .2s, background .2s;
      max-width: 220px; font: inherit;
    }
    .fleet-selector:hover { border-color: var(--border-strong); color: var(--fg-primary); }
    .fleet-selector.open { border-color: var(--border-strong); color: var(--fg-primary); }
    /* Une societe est choisie : accent emeraude DS (filtre actif). */
    .fleet-selector.is-active {
      background: color-mix(in srgb, var(--tracky) 12%, transparent);
      border-color: color-mix(in srgb, var(--tracky) 35%, transparent);
      color: var(--tracky-light);
    }
    .fs-icon { flex-shrink: 0; }
    .fs-label {
      font-size: 12px; font-weight: 600; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis; max-width: 150px;
    }
    .fs-chev { flex-shrink: 0; opacity: .7; transition: transform .2s; }
    .fs-chev.up { transform: rotate(180deg); }

    /* ── Dropdown custom ── */
    .fs-menu {
      position: absolute; top: calc(100% + 6px); right: 0; z-index: 60;
      min-width: 210px; max-width: 260px; padding: 6px;
      border-radius: 12px;
      background: var(--surface, var(--bg-secondary));
      border: 1px solid var(--border-strong, var(--border-subtle));
      box-shadow: 0 18px 44px -14px rgba(0,0,0,.5);
      max-height: 320px; overflow-y: auto;
      animation: fs-in .14s ease-out;
    }
    @keyframes fs-in { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
    .fs-opt {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      width: 100%; padding: 9px 11px; border-radius: 8px;
      border: none; background: transparent; cursor: pointer;
      color: var(--fg-secondary); font-size: 12.5px; font-weight: 600; text-align: left;
      transition: background .12s, color .12s;
    }
    .fs-opt:hover { background: var(--bg-tertiary); color: var(--fg-primary); }
    .fs-opt.sel { color: var(--tracky-light); }
    .fs-opt-txt { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fs-opt-check { flex-shrink: 0; color: var(--tracky-light); }
    .fs-backdrop { position: fixed; inset: 0; z-index: 59; }

    @media (max-width: 768px) {
      .fleet-selector { max-width: 160px; height: 32px; }
      .fs-label { max-width: 96px; font-size: 11px; }
      .fs-menu { min-width: 190px; }
    }
  `],
})
export class FleetSelectorComponent {
  private readonly auth = inject(AuthService);
  private readonly fleetCache = inject(FleetCacheService);
  private readonly fleetFilter = inject(FleetFilterService);

  protected readonly BuildingIcon = Building2;
  protected readonly ChevronIcon = ChevronDown;
  protected readonly CheckIcon = Check;

  protected readonly open = signal(false);

  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  protected readonly selected = this.fleetFilter.selectedFleetId;

  /** Liste des flottes (id + nom) triee par nom pour l'affichage. */
  protected readonly fleetList = computed(() =>
    Array.from(this.fleetCache.fleets().entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  /** Libellé du bouton : nom de la société choisie, ou « Toutes les sociétés ». */
  protected readonly currentLabel = computed(() => {
    const id = this.selected();
    if (id === null) return 'Toutes les sociétés';
    return this.fleetCache.fleets().get(id) ?? 'Société';
  });

  protected toggle(ev: Event): void {
    ev.stopPropagation();
    this.open.update((v) => !v);
  }
  protected close(): void { this.open.set(false); }

  protected pick(id: string | null): void {
    this.fleetFilter.set(id);
    this.open.set(false);
  }
}
