import { Component, computed, inject, input } from '@angular/core';
import { Building2, LucideAngularModule } from 'lucide-angular';
import { AuthService } from '../../../core/services/auth.service';
import { FleetCacheService } from '../../../core/services/fleet-cache.service';

/**
 * V1.15 — Badge "Société" / nom de flotte affiche uniquement pour SUPER_ADMIN.
 *
 * Usage :
 *   <app-sa-fleet-badge [fleetId]="vehicle.fleetId" />
 *
 * Comportement :
 * - Si l'utilisateur courant n'est PAS SUPER_ADMIN, rend rien (template vide).
 * - Si SA mais fleet inconnue dans le cache (ou cache pas encore charge),
 *   rend rien plutot que de polluer l'UI avec des badges vides.
 * - Sinon, rend un petit chip violet "🏢 <nom flotte>" coherent dans toutes
 *   les pages (vehicules, users, conducteurs, groupes, geofences, alertes,
 *   popup map).
 *
 * Pattern signal-based : tout est computed, no manual change detection.
 * Le FleetCacheService est rempli au mount du shell (dashboard-layout).
 */
@Component({
  selector: 'app-sa-fleet-badge',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (visibleName(); as name) {
      <span class="sa-fleet-badge" [attr.title]="'Flotte : ' + name">
        <lucide-icon [img]="BuildingIcon" [size]="10" aria-hidden="true"></lucide-icon>
        <span class="sa-fleet-badge-name">{{ name }}</span>
      </span>
    }
  `,
  styles: [`
    .sa-fleet-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 6px;
      font-size: 10px;
      line-height: 1.2;
      font-weight: 600;
      border-radius: 9999px;
      background: rgba(168, 85, 247, 0.12);
      color: rgb(192, 132, 252);
      border: 1px solid rgba(168, 85, 247, 0.25);
      white-space: nowrap;
      max-width: 140px;
      overflow: hidden;
    }
    .sa-fleet-badge-name {
      text-overflow: ellipsis;
      overflow: hidden;
    }
    /* Light mode override : reste lisible sur fond clair */
    :host-context(html.light) .sa-fleet-badge {
      background: rgba(168, 85, 247, 0.08);
      color: rgb(126, 34, 206);
      border-color: rgba(168, 85, 247, 0.2);
    }
  `],
})
export class SaFleetBadgeComponent {
  private readonly auth = inject(AuthService);
  private readonly fleets = inject(FleetCacheService);

  readonly fleetId = input<string | null | undefined>(null);
  protected readonly BuildingIcon = Building2;

  /** Nom de flotte a afficher, ou null pour ne rien rendre. */
  protected readonly visibleName = computed(() => {
    if (this.auth.user()?.role !== 'SUPER_ADMIN') return null;
    return this.fleets.getName(this.fleetId());
  });
}
