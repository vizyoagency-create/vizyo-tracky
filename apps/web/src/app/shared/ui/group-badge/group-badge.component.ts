import { Component, input } from '@angular/core';
import { Layers, LucideAngularModule } from 'lucide-angular';

/**
 * Sprint 1 (Fondation Groupes) — badge discret affichant le groupe (unique) d'un
 * véhicule, cohérent partout où le véhicule apparaît (liste, détail, popup carte,
 * rapports). Calque le style des autres chips du design system (cf. SaFleetBadge).
 *
 * Usage :
 *   <app-group-badge [group]="vehicle.group" />
 *   <app-group-badge [group]="vehicle.group" [showEmpty]="true" />  (affiche « Sans groupe »)
 *
 * - `group` null/undefined + `showEmpty=false` (défaut) → ne rend rien (UI propre).
 * - `showEmpty=true` → rend un chip muet « Sans groupe ».
 */
@Component({
  selector: 'app-group-badge',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (group(); as g) {
      <span class="group-badge" [attr.title]="'Groupe : ' + g.name">
        <lucide-icon [img]="LayersIcon" [size]="10" aria-hidden="true"></lucide-icon>
        <span class="group-badge-name">{{ g.name }}</span>
      </span>
    } @else if (showEmpty()) {
      <span class="group-badge group-badge--empty" title="Sans groupe">
        <lucide-icon [img]="LayersIcon" [size]="10" aria-hidden="true"></lucide-icon>
        <span class="group-badge-name">Sans groupe</span>
      </span>
    }
  `,
  styles: [`
    .group-badge {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      padding: 2px 6px;
      font-size: 10px;
      line-height: 1.2;
      font-weight: 600;
      border-radius: 9999px;
      background: var(--bg-tertiary);
      color: var(--fg-secondary);
      border: 1px solid var(--border-subtle);
      white-space: nowrap;
      max-width: 160px;
      overflow: hidden;
    }
    .group-badge-name {
      text-overflow: ellipsis;
      overflow: hidden;
    }
    .group-badge--empty {
      color: var(--fg-tertiary);
      font-weight: 500;
      border-style: dashed;
    }
  `],
})
export class GroupBadgeComponent {
  /** Groupe à afficher, ou null/undefined pour « sans groupe ». */
  readonly group = input<{ id?: string; name: string } | null | undefined>(null);
  /** Si true, affiche un chip muet « Sans groupe » au lieu de ne rien rendre. */
  readonly showEmpty = input<boolean>(false);

  protected readonly LayersIcon = Layers;
}
