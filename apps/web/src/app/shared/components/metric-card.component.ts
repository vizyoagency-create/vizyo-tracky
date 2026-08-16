import { Component, computed, input } from '@angular/core';
import { LucideAngularModule } from 'lucide-angular';

/**
 * Carte chiffrée du tableau de bord et des rapports.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ MIEUX VAUT UN TIRET EXPLIQUÉ QU'UN « 0 » FAUX                             │
 * │                                                                            │
 * │ Règle du kit (`Kit Partage Refonte`), présentée comme « le manque le plus │
 * │ courant sur les cartes chiffrées ». Une valeur absente et une valeur nulle │
 * │ se ressemblent à l'écran et ne veulent pas du tout dire la même chose :    │
 * │ « 0 km parcourus » est une information ; « 0 km » affiché parce que le     │
 * │ calcul n'a pas abouti est un mensonge, et il se propage — on en tire des   │
 * │ moyennes, des comparaisons, des décisions.                                 │
 * │                                                                            │
 * │ D'où `manquant` : la carte affiche « — » et DIT pourquoi. Un tiret nu      │
 * │ serait le même problème en plus discret.                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Usage :
 *   <app-metric-card label="Distance" value="1 240 km" />
 *   <app-metric-card label="Score de conduite" manquant="Aucun trajet sur la période" />
 */
@Component({
  selector: 'app-metric-card',
  standalone: true,
  imports: [LucideAngularModule],
  template: `
    <div class="flex flex-col gap-3 p-5 rounded-[--radius-card]
                bg-bg-secondary border border-border-subtle
                transition-all duration-300 ease-tracky
                hover:border-border-strong hover:shadow-tracky-glow">
      <div class="flex items-center justify-between">
        <span class="text-sm font-medium text-fg-tertiary">{{ label() }}</span>
        @if (icon()) {
          <lucide-icon [img]="icon()!" [size]="20" class="text-tracky-light"></lucide-icon>
        }
      </div>

      @if (manquant()) {
        <span class="text-3xl font-display font-bold mc-absent" [attr.title]="manquant()">—</span>
        <span class="text-xs mc-pourquoi">{{ manquant() }}</span>
      } @else {
        <span class="text-3xl font-display font-bold text-fg-primary">{{ valeurAffichee() }}</span>
        @if (trend()) {
          <span class="text-xs text-fg-secondary">{{ trend() }}</span>
        }
      }
    </div>
  `,
  styles: [`
    /* Le tiret est atténué : il ne doit pas se lire comme un chiffre. */
    .mc-absent { color: var(--fg-tertiary) }
    .mc-pourquoi { color: var(--texte-attente); line-height: 1.4 }
  `],
})
export class MetricCardComponent {
  label = input.required<string>();
  /**
   * La valeur, quand elle existe. `null` et `undefined` sont traités comme une absence
   * même si `manquant` n'est pas fourni — sans quoi un `value` non résolu s'afficherait
   * « null » en gros et en gras.
   */
  value = input<string | number | null | undefined>();
  /**
   * La RAISON de l'absence. La renseigner bascule la carte en « — » : « Aucun trajet sur
   * la période », « Le boîtier n'a rien envoyé depuis 6 jours », « Limites de vitesse
   * inconnues sur ce secteur ».
   */
  manquant = input<string>();
  trend = input<string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon = input<any>();

  /** Un `null` non annoncé reste un tiret : jamais « null », jamais « NaN ». */
  protected readonly valeurAffichee = computed(() => {
    const v = this.value();
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'number' && !Number.isFinite(v)) return '—';
    return v;
  });
}
