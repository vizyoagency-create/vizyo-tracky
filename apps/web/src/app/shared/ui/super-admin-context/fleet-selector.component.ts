import { Component, computed, inject } from '@angular/core';
import { Building2, LucideAngularModule } from 'lucide-angular';
import { AuthService } from '../../../core/services/auth.service';
import { FleetCacheService } from '../../../core/services/fleet-cache.service';
import { FleetFilterService } from '../../../core/services/fleet-filter.service';

/**
 * Selecteur de societe global — SUPER_ADMIN uniquement.
 *
 * Rendu dans le top-bar du shell (dashboard-layout). Ecrit dans
 * FleetFilterService, que les pages "liste" consomment pour filtrer leurs
 * lignes par flotte. Rend un <select> natif (fiable, accessible, mobile-
 * friendly) prefixe de l'icone societe. Ne rend RIEN pour les non-SA.
 *
 * La liste des flottes vient de FleetCacheService (deja pre-charge au mount
 * du shell). L'option par defaut "Toutes les societes" = pas de filtre.
 */
@Component({
  selector: 'app-fleet-selector',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (isSuperAdmin()) {
      <label class="fleet-selector" [class.is-active]="selected() !== null">
        <lucide-icon [img]="BuildingIcon" [size]="14" class="fs-icon" aria-hidden="true"></lucide-icon>
        <select
          class="fs-select"
          aria-label="Filtrer par société"
          (change)="onChange($event)">
          <option value="" [selected]="selected() === null">Toutes les sociétés</option>
          @for (f of fleetList(); track f.id) {
            <option [value]="f.id" [selected]="selected() === f.id">{{ f.name }}</option>
          }
        </select>
      </label>
    }
  `,
  styles: [`
    .fleet-selector {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      height: 34px;
      padding: 0 8px 0 10px;
      border-radius: 10px;
      background: var(--bg-tertiary);
      border: 1px solid var(--border-subtle);
      color: var(--fg-secondary);
      cursor: pointer;
      transition: border-color .2s, color .2s, background .2s;
      max-width: 200px;
    }
    .fleet-selector:hover { border-color: var(--border-strong); color: var(--fg-primary); }
    /* Une societe est choisie : accent violet coherent avec le badge societe. */
    .fleet-selector.is-active {
      background: rgba(168, 85, 247, 0.12);
      border-color: rgba(168, 85, 247, 0.35);
      color: rgb(192, 132, 252);
    }
    .fs-icon { flex-shrink: 0; }
    .fs-select {
      appearance: none;
      -webkit-appearance: none;
      background: transparent;
      border: none;
      outline: none;
      color: inherit;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      max-width: 150px;
      text-overflow: ellipsis;
      padding-right: 4px;
    }
    /* Les <option> heritent du fond systeme : forcer un fond lisible en dark. */
    .fs-select option { color: var(--fg-primary); background: var(--bg-secondary); }

    @media (max-width: 768px) {
      .fleet-selector { max-width: 150px; height: 32px; }
      .fs-select { max-width: 108px; font-size: 11px; }
    }
  `],
})
export class FleetSelectorComponent {
  private readonly auth = inject(AuthService);
  private readonly fleetCache = inject(FleetCacheService);
  private readonly fleetFilter = inject(FleetFilterService);

  protected readonly BuildingIcon = Building2;

  protected readonly isSuperAdmin = computed(() => this.auth.user()?.role === 'SUPER_ADMIN');
  protected readonly selected = this.fleetFilter.selectedFleetId;

  /** Liste des flottes (id + nom) triee par nom pour l'affichage. */
  protected readonly fleetList = computed(() =>
    Array.from(this.fleetCache.fleets().entries())
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  );

  protected onChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value;
    this.fleetFilter.set(value || null);
  }
}
