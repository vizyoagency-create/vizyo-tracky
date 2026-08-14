import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule, Route, Settings, Inbox } from 'lucide-angular';
import { MissionPricingTabComponent } from './mission-pricing-tab.component';

/**
 * A6 / T3 — la page `/missions` du transporteur, a trois onglets.
 *
 * `Demandes` et `Missions` arrivent avec T5 et T6 : les declarer maintenant
 * pointerait vers du vide. Un onglet qui promet ce qu'il ne tient pas est le defaut
 * que B1 § J releve sur le mode simplifie — on les ajoute AVEC leurs ecrans.
 *
 * L'onglet actif vit dans l'URL (`?tab=`) : un gestionnaire qui envoie le lien de sa
 * grille a un collegue doit ouvrir la grille, pas la page d'accueil.
 */
type Onglet = 'parametres';

@Component({
  selector: 'app-missions-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, MissionPricingTabComponent],
  template: `
    <div class="mpage">
      <header class="mp-tete">
        <span class="vt-eyebrow">Exploitation</span>
        <h1 class="mp-titre">Missions</h1>
        <p class="mp-sous">
          Vos tarifs, et bientôt les demandes de vos dépôts.
        </p>
      </header>

      <nav class="mp-onglets" role="tablist" aria-label="Sections des missions">
        <button type="button" role="tab" class="mp-onglet active"
                [attr.aria-selected]="true">
          <lucide-icon [img]="Settings" [size]="15" /> Paramètres
        </button>
        <span class="mp-onglet mp-onglet--futur" aria-disabled="true" title="Disponible prochainement">
          <lucide-icon [img]="Inbox" [size]="15" /> Demandes
        </span>
        <span class="mp-onglet mp-onglet--futur" aria-disabled="true" title="Disponible prochainement">
          <lucide-icon [img]="Route" [size]="15" /> Missions
        </span>
      </nav>

      <section role="tabpanel">
        <app-mission-pricing-tab />
      </section>
    </div>
  `,
  styles: [`
    :host { display: block }
    .mpage { display: flex; flex-direction: column; gap: 18px }
    .mp-tete { display: flex; flex-direction: column; gap: 2px }
    .mp-titre { margin: 0; font-family: var(--font-display); font-size: 26px;
                font-weight: 800; color: var(--fg-primary) }
    .mp-sous { margin: 0; font-size: 13.5px; color: var(--fg-tertiary) }

    .mp-onglets { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none;
                  border-bottom: 1px solid var(--border-subtle) }
    .mp-onglets::-webkit-scrollbar { display: none }
    .mp-onglet { display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0;
                 min-height: 44px; padding: 0 14px; margin-bottom: -1px;
                 border: 0; border-bottom: 2px solid transparent; background: none;
                 font-family: inherit; font-size: 13.5px; font-weight: 600;
                 color: var(--fg-tertiary); cursor: pointer; white-space: nowrap }
    .mp-onglet.active { color: var(--fg-primary); border-bottom-color: var(--color-tracky-light) }
    /* Un onglet a venir se voit mais ne se clique pas — et il le dit. */
    .mp-onglet--futur { opacity: .45; cursor: not-allowed }
  `],
})
export class MissionsPageComponent implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly Settings = Settings;
  protected readonly Route = Route;
  protected readonly Inbox = Inbox;

  protected readonly onglet = signal<Onglet>('parametres');

  ngOnInit(): void {
    // Un seul onglet pour l'instant : on normalise l'URL plutot que de laisser
    // trainer un `?tab=` qui ne correspond a rien.
    if (this.route.snapshot.queryParamMap.get('tab')) {
      void this.router.navigate([], { queryParams: {}, replaceUrl: true });
    }
  }
}
