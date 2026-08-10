import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import type { DepotMissionDto } from '@vizyo/tracky-shared';
import { LucideAngularModule, Route as RouteIcon, Truck } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { DepotApiService } from './depot-api.service';
import { DepotLiveStore } from './depot-live.store';
import { DepotMissionCardComponent } from './depot-mission-card.component';
import { DepotIncidentModalComponent } from './modals/depot-incident-modal.component';
import { DepotOnboardingModalComponent } from './modals/depot-onboarding-modal.component';
import { DepotTripModalComponent } from './modals/depot-trip-modal.component';

/**
 * Espace dépôt (2026-08) — l'onglet Missions (A3 § 2).
 *
 * « Même liste que le panneau de la carte, en pleine largeur » : c'est donc le MÊME
 * composant de carte de mission, et le même store. Deux implémentations auraient
 * divergé sur un détail — un statut, un format d'heure — et le dépôt aurait lu deux
 * vérités pour la même mission.
 *
 * ┌─ L'ÉTAT VIDE EST L'ÉCRAN LE PLUS IMPORTANT DE CE LOT ─────────────────────┐
 * │ C'est le premier écran d'un nouveau dépôt : à l'instant où on lui ouvre     │
 * │ l'accès, il n'a encore aucune mission. Un écran vide sans explication lui    │
 * │ apprend que l'outil ne marche pas ; un écran vide qui dit CE QUI VA SE       │
 * │ PASSER lui apprend comment l'outil marche.                                  │
 * └────────────────────────────────────────────────────────────────────────────┘
 */
@Component({
  selector: 'app-depot-missions',
  standalone: true,
  imports: [
    LucideAngularModule,
    DepotMissionCardComponent,
    DepotTripModalComponent,
    DepotIncidentModalComponent,
    DepotOnboardingModalComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="dms">
      <header class="dms-tete">
        <h1>Mes missions</h1>
        <p>{{ store.missions().length }} mission{{ store.missions().length > 1 ? 's' : '' }} · {{ store.depotName() }}</p>
      </header>

      @if (store.chargement()) {
        <div class="dms-liste">
          @for (i of [1, 2, 3, 4]; track i) { <div class="sk dms-sk"></div> }
        </div>
      } @else if (store.missions().length === 0) {
        <!-- ═══ L'ÉTAT VIDE ═══════════════════════════════════════════════ -->
        <div class="dms-vide">
          <span class="vt-icon-tile dms-vide-ico"><lucide-icon [img]="RouteIcon" [size]="26" /></span>
          <h2>Aucune mission pour l'instant</h2>
          <p>
            {{ store.carrierName() }} vous assignera des missions depuis son espace.
            Vous recevrez un e-mail à chaque nouvelle mission.
          </p>
          <button type="button" class="dms-cta" (click)="onboardingOuvert.set(true)">
            Comment ça marche
          </button>

          <div class="dms-encart">
            <lucide-icon [img]="Truck" [size]="16" aria-hidden="true" />
            <p>
              Vous ne verrez que les camions engagés sur vos missions, et seulement
              pendant leur créneau. Les autres véhicules de votre transporteur ne vous
              sont pas visibles.
            </p>
          </div>
        </div>
      } @else {
        <div class="dms-liste">
          @for (m of missionsTriees(); track m.id) {
            <app-depot-mission-card
              [mission]="m"
              [selectionnee]="selection() === m.id"
              (choisir)="basculer($event)"
              (appeler)="appeler($event)"
            />
            @if (selection() === m.id) {
              <div class="dms-actions">
                <button type="button" class="dms-btn" (click)="tripOuvert.set(m.id)">Voir le trajet</button>
                <button type="button" class="dms-btn" (click)="incidentPour.set(m.id)">Signaler un incident</button>
              </div>
            }
          }
        </div>

        <div class="dms-encart dms-encart--bas">
          <lucide-icon [img]="Truck" [size]="16" aria-hidden="true" />
          <p>
            @if (store.otherVehiclesCount() > 0) {
              Les <strong>{{ store.otherVehiclesCount() }}</strong> autres camions de
              {{ store.carrierName() }} ne sont pas sur vos missions : ils ne vous sont pas visibles.
            } @else {
              Vous ne voyez que les camions engagés sur vos missions, et seulement pendant leur créneau.
            }
          </p>
        </div>
      }
    </section>

    @if (tripOuvert()) {
      <app-depot-trip-modal
        [missionId]="tripOuvert()"
        (fermer)="tripOuvert.set(null)"
        (signaler)="incidentPour.set($event); tripOuvert.set(null)"
      />
    }
    @if (incidentPour()) {
      <app-depot-incident-modal
        [missions]="store.missions()"
        [missionInitiale]="incidentPour()"
        (fermer)="incidentPour.set(null)"
      />
    }
    @if (onboardingOuvert()) {
      <app-depot-onboarding-modal [carrierName]="store.carrierName()" (fermer)="onboardingOuvert.set(false)" />
    }
  `,
  styles: [`
    .dms { max-width: 860px; margin: 0 auto; padding: 20px 18px 40px }
    .dms-tete { margin-bottom: 18px }
    .dms-tete h1 {
      margin: 0; font-family: var(--font-display); font-size: 22px; font-weight: 800;
      letter-spacing: -.02em; color: var(--text-primary);
    }
    .dms-tete p { margin: 5px 0 0; font-size: 13px; color: var(--depot-attenue) }

    .dms-liste { display: flex; flex-direction: column; gap: 10px }
    .dms-sk { height: 96px; border-radius: 14px }
    .dms-actions { display: flex; gap: 8px; flex-wrap: wrap; margin: -2px 0 4px; padding-left: 4px }
    .dms-btn {
      min-height: 38px; padding: 8px 15px; border-radius: 10px;
      border: 1px solid var(--border-color); background: var(--surface-secondary);
      color: var(--text-secondary); font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
    }
    .dms-btn:hover { color: var(--text-primary); border-color: var(--border-strong-color) }

    .dms-vide {
      display: flex; flex-direction: column; align-items: center; gap: 12px;
      padding: 56px 20px; text-align: center;
    }
    .dms-vide-ico { width: 58px; height: 58px; border-radius: 17px }
    .dms-vide h2 {
      margin: 0; font-family: var(--font-display); font-size: 21px; font-weight: 800;
      letter-spacing: -.02em; color: var(--text-primary);
    }
    .dms-vide > p { margin: 0; max-width: 460px; font-size: 14px; line-height: 1.65; color: var(--text-secondary) }
    .dms-cta {
      min-height: 42px; padding: 10px 20px; border-radius: 11px; border: none;
      background: var(--color-tracky-light); color: var(--accent-ink);
      font-family: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer;
    }

    .dms-encart {
      display: flex; align-items: flex-start; gap: 11px; max-width: 520px;
      margin-top: 12px; padding: 12px 14px; border-radius: 13px;
      border: 1px dashed var(--border-strong-color); text-align: left;
    }
    .dms-encart--bas { max-width: none; margin-top: 18px }
    .dms-encart lucide-icon { flex: 0 0 auto; margin-top: 1px; color: var(--depot-attenue) }
    .dms-encart p { margin: 0; font-size: 12px; line-height: 1.6; color: var(--depot-attenue) }
    .dms-encart strong { color: var(--text-secondary) }

    @media (max-width: 767px) {
      .dms { padding: 16px 14px 32px }
      .dms-btn, .dms-cta { min-height: 44px }
    }
  `],
})
export class DepotMissionsComponent implements OnInit, OnDestroy {
  protected readonly store = inject(DepotLiveStore);
  private readonly api = inject(DepotApiService);
  private readonly toast = inject(ToastService);

  protected readonly RouteIcon = RouteIcon;
  protected readonly Truck = Truck;

  protected readonly selection = signal<string | null>(null);
  protected readonly tripOuvert = signal<string | null>(null);
  protected readonly incidentPour = signal<string | null>(null);
  protected readonly onboardingOuvert = signal(false);

  /**
   * Le tri d'A3 § 2 : en cours d'abord, LES RETARDS EN TÊTE, puis les planifiées par
   * heure de départ, puis les terminées.
   *
   * Les retards en tête parce que c'est la seule catégorie qui appelle une action du
   * dépôt — décaler un quai, prévenir un client. Les autres, il les consulte.
   */
  protected readonly missionsTriees = computed(() =>
    [...this.store.missions()].sort((a, b) => {
      const ecart = this.rang(a) - this.rang(b);
      if (ecart !== 0) return ecart;
      // À rang égal : par heure de départ. Les terminées à l'envers — la plus
      // récente d'abord, parce qu'on relit la dernière livraison, pas la première.
      const sens = a.status === 'DONE' ? -1 : 1;
      return sens * (new Date(a.startAt).getTime() - new Date(b.startAt).getTime());
    }),
  );

  async ngOnInit(): Promise<void> {
    await this.store.demarrer();
  }

  ngOnDestroy(): void {
    this.store.arreter();
  }

  protected basculer(m: DepotMissionDto): void {
    this.selection.set(this.selection() === m.id ? null : m.id);
  }

  private rang(m: DepotMissionDto): number {
    switch (m.status) {
      case 'LATE':
        return 0;
      case 'IN_PROGRESS':
        return 1;
      case 'PLANNED':
        return 2;
      case 'DONE':
        return 3;
      default:
        return 4;
    }
  }

  protected async appeler(m: DepotMissionDto): Promise<void> {
    try {
      const { phone } = await this.api.numeroConducteur(m.id);
      window.location.href = `tel:${phone}`;
    } catch (err) {
      swallow('depot-missions:appeler', err);
      this.toast.show({
        kind: 'warning',
        title: 'Appel indisponible',
        message: 'Le contact du conducteur n\'est joignable que pendant le créneau de la mission.',
      });
    }
  }
}
