import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import type { DepotMissionDto } from '@vizyo/tracky-shared';
import { LucideAngularModule, Phone, Truck } from 'lucide-angular';

/**
 * Espace dépôt (2026-08) — la carte d'une mission (A3 § 1).
 *
 * Un seul composant pour le panneau de la carte live ET l'onglet Missions : la spec
 * dit « même liste que le panneau de la carte, en pleine largeur » (A3 § 2). Deux
 * composants auraient divergé sur le premier détail — un statut, un format d'heure —
 * et le dépôt aurait lu deux vérités pour la même mission.
 *
 * ⚠️ **Aucun identifiant interne à l'écran.** La PLAQUE est la clé : c'est ce que le
 * dépôt lit sur le camion qui se présente à son quai (A3 § 7, règle 3).
 */
@Component({
  selector: 'app-depot-mission-card',
  standalone: true,
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <article
      class="dmc"
      [class.dmc--active]="selectionnee()"
      [class.dmc--retard]="mission().status === 'LATE'"
      (click)="choisir.emit(mission())"
      (keydown.enter)="choisir.emit(mission())"
      tabindex="0"
      role="button"
      [attr.aria-pressed]="selectionnee()"
    >
      <header class="dmc-tete">
        <span class="dmc-ref">{{ mission().ref }}</span>
        <span class="vt-status" [class]="classeStatut()">
          <span class="vt-status__dot"></span>{{ libelleStatut() }}
        </span>
      </header>

      <p class="dmc-trajet">{{ mission().origin }} <span aria-hidden="true">→</span> {{ mission().destination }}</p>

      <div class="dmc-creneau">
        <span>{{ jour() }} · {{ heure(mission().startAt) }} → {{ heure(mission().endAt) }}</span>
        @if (mission().delayMinutes !== null && mission().delayMinutes! > 0) {
          <span class="dmc-retard">+{{ mission().delayMinutes }} min</span>
        }
      </div>

      <!-- Mission planifiée : on DIT quand le suivi démarrera. Une carte sans camion
           et sans explication se lit comme une panne (A3 § 6). -->
      @if (mission().status === 'PLANNED') {
        <p class="dmc-attente">Le suivi démarrera à {{ heure(mission().startAt) }}</p>
      }

      <footer class="dmc-pied">
        <span class="dmc-plaque">
          <lucide-icon [img]="Truck" [size]="14" aria-hidden="true" />{{ mission().vehicle.plate }}
        </span>
        @if (mission().driver; as conducteur) {
          <span class="dmc-conducteur">
            {{ conducteur.displayName }}
            @if (conducteur.phone && suiviActif()) {
              <button
                type="button"
                class="dmc-appel"
                (click)="appeler.emit(mission()); $event.stopPropagation()"
                [attr.aria-label]="'Appeler ' + conducteur.displayName"
              >
                <lucide-icon [img]="Phone" [size]="13" aria-hidden="true" />
                {{ conducteur.phone }}
              </button>
            } @else if (conducteur.phone) {
              <span class="dmc-tel">{{ conducteur.phone }}</span>
            }
          </span>
        }
      </footer>

      <!-- La distance restante n'apparaît que sur la sélection : affichée partout,
           elle transforme la liste en tableau de bord et noie la référence. -->
      @if (selectionnee() && distanceRestanteKm() !== null) {
        <p class="dmc-distance">{{ distanceRestanteKm() }} km restants</p>
      }
    </article>
  `,
  styles: [`
    .dmc {
      display: flex; flex-direction: column; gap: 7px;
      padding: 13px 14px; border-radius: 14px; cursor: pointer;
      background: var(--surface-secondary); border: 1px solid var(--border-color);
      /* Densité de la plateforme : 44 px sur iOS, 56 px sur Android. */
      min-height: var(--densite-liste);
      transition: border-color .15s ease, background .15s ease;
    }
    .dmc:hover { border-color: var(--border-strong-color) }
    .dmc:focus-visible { outline: 2px solid var(--violet); outline-offset: 2px }
    /* Violet = dépôt (design/TOKENS.md, règle « une couleur = une signification »). */
    .dmc--active { border-color: var(--violet); background: color-mix(in srgb, var(--violet) 7%, var(--surface-secondary)) }
    .dmc--retard { border-left: 3px solid var(--danger) }

    .dmc-tete { display: flex; align-items: center; justify-content: space-between; gap: 10px }
    .dmc-ref { font-family: var(--font-mono); font-size: 12px; font-weight: 700; color: var(--text-primary) }
    .dmc-trajet { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.35; color: var(--text-primary) }
    .dmc-creneau {
      display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
      font-family: var(--font-mono); font-size: 11.5px; color: var(--depot-attenue);
    }
    .dmc-retard { color: var(--depot-alerte); font-weight: 700 }
    .dmc-attente { margin: 0; font-size: 12px; color: var(--text-secondary); font-style: italic }
    .dmc-pied { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap }
    .dmc-plaque {
      display: inline-flex; align-items: center; gap: 6px;
      font-family: var(--font-mono); font-size: 12px; font-weight: 600; color: var(--text-secondary);
    }
    .dmc-conducteur { display: inline-flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-secondary) }
    .dmc-tel { font-family: var(--font-mono); font-size: 11.5px; color: var(--depot-attenue) }
    .dmc-appel {
      display: inline-flex; align-items: center; gap: 5px;
      /* ≥ 44 px de haut sur mobile : cible tactile du critère de recette n° 8. */
      min-height: 32px; padding: 5px 10px; border-radius: 9999px;
      border: 1px solid color-mix(in srgb, var(--color-tracky-light) 32%, transparent);
      background: color-mix(in srgb, var(--color-tracky-light) 11%, transparent);
      color: var(--depot-succes);
      font-family: var(--font-mono); font-size: 11.5px; font-weight: 700; cursor: pointer;
    }
    .dmc-appel:hover { background: color-mix(in srgb, var(--color-tracky-light) 18%, transparent) }
    .dmc-distance {
      margin: 2px 0 0; font-size: 12px; font-weight: 700; color: var(--violet);
    }
    @media (max-width: 767px) {
      .dmc-appel { min-height: 44px; padding: 8px 14px }
    }
  `],
})
export class DepotMissionCardComponent {
  readonly mission = input.required<DepotMissionDto>();
  readonly selectionnee = input(false);
  /** Distance restante, calculée par le parent qui connaît la position. */
  readonly distanceRestanteKm = input<number | null>(null);

  readonly choisir = output<DepotMissionDto>();
  readonly appeler = output<DepotMissionDto>();

  protected readonly Truck = Truck;
  protected readonly Phone = Phone;

  /** Le bouton d'appel n'existe que pendant le suivi : hors fenêtre, l'endpoint
   *  refuse de toute façon, et un bouton qui échoue vaut moins qu'un bouton absent. */
  protected readonly suiviActif = computed(
    () => this.mission().status === 'IN_PROGRESS' || this.mission().status === 'LATE',
  );

  protected readonly classeStatut = computed(() => {
    switch (this.mission().status) {
      case 'IN_PROGRESS':
        return 'vt-status--on';
      case 'LATE':
        return 'vt-status--danger';
      case 'PLANNED':
        return 'vt-status--idle';
      default:
        return 'vt-status--offline';
    }
  });

  protected readonly libelleStatut = computed(
    () =>
      ({
        PLANNED: 'Planifiée',
        IN_PROGRESS: 'En cours',
        LATE: 'En retard',
        DONE: 'Terminée',
        CANCELLED: 'Annulée',
      })[this.mission().status],
  );

  protected readonly jour = computed(() =>
    new Date(this.mission().startAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' }),
  );

  protected heure(iso: string): string {
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }
}
