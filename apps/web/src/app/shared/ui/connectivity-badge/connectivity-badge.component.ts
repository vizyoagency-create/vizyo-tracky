import { Component, computed, input } from '@angular/core';
import { AlertTriangle, LucideAngularModule, Wifi, WifiOff } from 'lucide-angular';
import type { VehicleConnectivityState } from '@vizyo/tracky-shared';

/**
 * Métadonnées d'affichage d'un état de connectivité véhicule. Source unique de
 * vérité visuelle (label + couleurs + icône) réutilisée partout : badge de liste,
 * détail, popup carte. Les couleurs distinguent les deux causes de non-suivi :
 *  - OFFLINE (ambre)        : débranché / hors-ligne — il fonctionnait, à traiter.
 *  - NOT_CONFIGURED (gris)  : pas (ou mal) installé — neutre, à équiper.
 */
export interface ConnectivityMeta {
  label: string;
  /** Couleur d'accent (texte + pastille). */
  color: string;
  /** Fond du chip. */
  bg: string;
  icon: typeof Wifi;
}

export function connectivityMeta(state: VehicleConnectivityState): ConnectivityMeta {
  switch (state) {
    case 'ONLINE':
      return { label: 'En ligne', color: '#10b981', bg: 'rgba(16,185,129,.12)', icon: Wifi };
    case 'OFFLINE':
      return { label: 'Hors ligne', color: '#f59e0b', bg: 'rgba(245,158,11,.13)', icon: WifiOff };
    case 'NOT_CONFIGURED':
    default:
      return { label: 'Non configuré', color: '#9ca3af', bg: 'rgba(156,163,175,.14)', icon: AlertTriangle };
  }
}

/**
 * Badge de connectivité véhicule. Rend un chip coloré « En ligne / Hors ligne /
 * Non configuré » à partir du tri-état partagé `getVehicleConnectivityState`.
 *
 * Usage :
 *   <app-connectivity-badge [state]="connectivity(v)" />
 *   <app-connectivity-badge [state]="state" [compact]="true" />   (pastille + icône seules)
 *   <app-connectivity-badge [state]="state" [hideWhenOnline]="true" />  (ne flague que les problèmes)
 */
@Component({
  selector: 'app-connectivity-badge',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    @if (visible()) {
      <span
        class="conn-badge"
        [class.conn-badge--compact]="compact()"
        [style.color]="meta().color"
        [style.background]="meta().bg"
        [style.border-color]="meta().color + '40'"
        [attr.title]="title()"
      >
        <lucide-icon [img]="meta().icon" [size]="compact() ? 12 : 11" aria-hidden="true"></lucide-icon>
        @if (!compact()) {
          <span class="conn-badge-label">{{ meta().label }}</span>
        }
      </span>
    }
  `,
  styles: [`
    .conn-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      font-size: 10px;
      line-height: 1.2;
      font-weight: 700;
      letter-spacing: .01em;
      border-radius: 9999px;
      border: 1px solid transparent;
      white-space: nowrap;
    }
    .conn-badge--compact {
      padding: 3px;
      border-radius: 9999px;
    }
    .conn-badge-label { overflow: hidden; text-overflow: ellipsis; }
  `],
})
export class ConnectivityBadgeComponent {
  /** État de connectivité à afficher. */
  readonly state = input.required<VehicleConnectivityState>();
  /** Pastille + icône seules (sans texte), pour les rangées denses. */
  readonly compact = input<boolean>(false);
  /** Si true, ne rend rien quand le véhicule est ONLINE (ne flague que les problèmes). */
  readonly hideWhenOnline = input<boolean>(false);

  protected readonly meta = computed(() => connectivityMeta(this.state()));
  protected readonly visible = computed(() => !(this.hideWhenOnline() && this.state() === 'ONLINE'));
  protected readonly title = computed(() => {
    switch (this.state()) {
      case 'ONLINE': return 'Boîtier en ligne — suivi en direct';
      case 'OFFLINE': return 'Hors ligne — boîtier débranché ou sans réseau depuis > 15 min';
      case 'NOT_CONFIGURED': return 'Non configuré — aucun boîtier connecté à Tracky';
      default: return '';
    }
  });
}
