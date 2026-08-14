import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { LucideAngularModule, Route, Settings, Inbox } from 'lucide-angular';
import { MissionPricingTabComponent } from './mission-pricing-tab.component';
import { MissionRequestsTabComponent } from './mission-requests-tab.component';

/**
 * A6 — la page `/missions` du transporteur.
 *
 * `Demandes` est arrivé avec T6 : il n'était déclaré qu'en « bientôt » tant qu'il
 * pointait vers du vide — un onglet qui promet ce qu'il ne tient pas est le défaut que
 * B1 § J relève sur le mode simplifié. `Missions` reste dans cet état : son écran
 * n'existe pas encore, et l'agenda le porte pour l'instant.
 *
 * L'onglet actif vit dans l'URL (`?tab=`) : un gestionnaire qui envoie le lien de sa
 * grille à un collègue doit ouvrir la grille, pas la page d'accueil. Et l'e-mail de
 * demande pointe sur `/missions?demande=<id>` — cf. `MissionRequestsService.notifier`.
 */
type Onglet = 'demandes' | 'parametres';

const ONGLETS: Onglet[] = ['demandes', 'parametres'];

@Component({
  selector: 'app-missions-page',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, MissionPricingTabComponent, MissionRequestsTabComponent],
  template: `
    <div class="mpage">
      <header class="mp-tete">
        <span class="vt-eyebrow">Exploitation</span>
        <h1 class="mp-titre">Missions</h1>
        <p class="mp-sous">
          Les demandes de vos dépôts, et la grille tarifaire qui les chiffre.
        </p>
      </header>

      <nav class="mp-onglets" role="tablist" aria-label="Sections des missions">
        <button type="button" role="tab" class="mp-onglet"
                [class.active]="onglet() === 'demandes'"
                [attr.aria-selected]="onglet() === 'demandes'"
                (click)="allerA('demandes')">
          <lucide-icon [img]="Inbox" [size]="15" /> Demandes
        </button>
        <button type="button" role="tab" class="mp-onglet"
                [class.active]="onglet() === 'parametres'"
                [attr.aria-selected]="onglet() === 'parametres'"
                (click)="allerA('parametres')">
          <lucide-icon [img]="Settings" [size]="15" /> Paramètres
        </button>
        <span class="mp-onglet mp-onglet--futur" aria-disabled="true" title="Disponible prochainement">
          <lucide-icon [img]="Route" [size]="15" /> Missions
        </span>
      </nav>

      <section role="tabpanel">
        @if (onglet() === 'demandes') {
          <app-mission-requests-tab />
        } @else {
          <app-mission-pricing-tab />
        }
      </section>
    </div>
  `,
  styles: [`
    :host { display: block }
    .mpage { display: flex; flex-direction: column; gap: 18px }
    .mp-tete { display: flex; flex-direction: column; gap: 2px }
    .mp-titre { margin: 0; font-family: var(--font-display); font-size: 26px;
                font-weight: 800; color: var(--fg-primary) }
    .mp-sous { margin: 0; font-size: 13.5px; color: var(--fg-secondary) }

    .mp-onglets { display: flex; gap: 4px; overflow-x: auto; scrollbar-width: none;
                  border-bottom: 1px solid var(--border-subtle) }
    .mp-onglets::-webkit-scrollbar { display: none }
    .mp-onglet { display: inline-flex; align-items: center; gap: 7px; flex-shrink: 0;
                 min-height: 44px; padding: 0 14px; margin-bottom: -1px;
                 border: 0; border-bottom: 2px solid transparent; background: none;
                 font-family: inherit; font-size: 13.5px; font-weight: 600;
                 color: var(--fg-secondary); cursor: pointer; white-space: nowrap }
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

  /**
   * Les demandes par défaut, et non les paramètres.
   *
   * C'est ce que le gestionnaire vient voir : une grille se règle une fois, des
   * demandes arrivent tous les jours. L'e-mail de notification pointe d'ailleurs ici.
   */
  protected readonly onglet = signal<Onglet>('demandes');

  ngOnInit(): void {
    const demande = this.route.snapshot.queryParamMap.get('tab');
    if (demande && (ONGLETS as string[]).includes(demande)) {
      this.onglet.set(demande as Onglet);
      return;
    }
    // Un `?tab=` inconnu est normalisé plutôt que laissé traîner : il désignerait un
    // onglet qui n'existe pas, et le lien partagé n'ouvrirait rien.
    if (demande) void this.router.navigate([], { queryParams: {}, replaceUrl: true });
  }

  protected allerA(o: Onglet): void {
    this.onglet.set(o);
    void this.router.navigate([], {
      queryParams: { tab: o },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
