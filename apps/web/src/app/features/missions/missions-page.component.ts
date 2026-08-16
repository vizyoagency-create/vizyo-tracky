import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { PermissionsService } from '../../core/services/permissions.service';
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
        <!-- Le sous-titre suit les droits, comme les onglets. Annoncer « les demandes
             de vos dépôts » à un compte qui n'y a pas accès lui ferait chercher un
             écran qui ne s'ouvrira pas — et pour lui, cette page EST la grille. -->
        <p class="mp-sous">
          @if (peutNegocier()) {
            Les demandes de vos dépôts, et la grille tarifaire qui les chiffre.
          } @else {
            La grille tarifaire qui chiffre vos missions.
          }
        </p>
      </header>

      <nav class="mp-onglets" role="tablist" aria-label="Sections des missions">
        <!-- L'onglet n'existe que pour qui peut negocier. Le montrer a un compte qui
             recevra 403 en l'ouvrant serait promettre ce qu'on ne tient pas — et la
             liste des demandes porte des montants commerciaux. -->
        @if (peutNegocier()) {
          <button type="button" role="tab" class="mp-onglet"
                  [class.active]="onglet() === 'demandes'"
                  [attr.aria-selected]="onglet() === 'demandes'"
                  (click)="allerA('demandes')">
            <lucide-icon [img]="Inbox" [size]="15" /> Demandes
          </button>
        }
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
  private readonly perms = inject(PermissionsService);

  protected readonly Settings = Settings;
  protected readonly Route = Route;
  protected readonly Inbox = Inbox;

  /**
   * Négocier une demande, c'est `missions_request` — la même capacité des deux côtés
   * de la table. Sans elle, l'onglet n'apparaît pas et son URL ne mène nulle part.
   */
  protected readonly peutNegocier = computed(() => this.perms.can('missions_request'));

  /**
   * Les demandes par défaut, et non les paramètres.
   *
   * C'est ce que le gestionnaire vient voir : une grille se règle une fois, des
   * demandes arrivent tous les jours. L'e-mail de notification pointe d'ailleurs ici.
   */
  protected readonly onglet = signal<Onglet>('demandes');

  ngOnInit(): void {
    // ⚠️ LE DÉFAUT DÉPEND DE CE QU'ON A LE DROIT DE VOIR. Ouvrir `/missions` sur un
    // onglet « Demandes » qui n'existe pas pour ce compte afficherait un panneau vide
    // sous une barre d'onglets qui n'en propose qu'un — l'écran aurait l'air cassé.
    if (!this.peutNegocier()) {
      this.onglet.set('parametres');
      return;
    }
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
