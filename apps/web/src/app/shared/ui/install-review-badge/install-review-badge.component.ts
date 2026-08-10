import { Component, input } from '@angular/core';
import { AlertTriangle, LucideAngularModule } from 'lucide-angular';

/**
 * Badge d'alerte « Installation à revoir » : un boîtier posé depuis moins d'un
 * mois qui se déconnecte → pose probablement bâclée, à traiter au plus vite.
 * Rouge/urgent, volontairement voyant. Visible partout (liste, fiche, dashboard,
 * alertes) et pour tous les rôles ayant accès au véhicule.
 *
 * Usage : `@if (installToReview(v)) { <app-install-review-badge /> }`
 * ou compact : `<app-install-review-badge [compact]="true" />` (pastille seule).
 */
@Component({
  selector: 'app-install-review-badge',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    <span
      class="ir-badge"
      [class.ir-badge--compact]="compact()"
      title="Boîtier installé depuis moins d'un mois qui se déconnecte — installation probablement à revoir au plus vite"
    >
      <lucide-icon [img]="Icon" [size]="11" aria-hidden="true"></lucide-icon>
      @if (!compact()) {
        <span class="ir-label">Installation à revoir</span>
      }
    </span>
  `,
  styles: [`
    .ir-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 9999px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: .01em;
      white-space: nowrap;
      background: color-mix(in srgb, var(--texte-alerte) 14%, transparent);
      color: var(--texte-alerte);
      border: 1px solid color-mix(in srgb, var(--texte-alerte) 35%, transparent);
    }
    .ir-badge--compact { padding: 3px; }
  `],
})
export class InstallReviewBadgeComponent {
  /** Pastille seule (sans texte), pour les rangées denses. */
  readonly compact = input<boolean>(false);
  protected readonly Icon = AlertTriangle;
}
