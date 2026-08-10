import { ChangeDetectionStrategy, Component, computed, inject, input, OnInit, output, signal } from '@angular/core';
import type { DepotMissionDto } from '@vizyo/tracky-shared';
import { Lock, LucideAngularModule, Phone } from 'lucide-angular';
import { swallow } from '../../../core/error/swallow';
import { ToastService } from '../../../shared/ui/toast/toast.service';
import { DepotApiService } from '../depot-api.service';
import { DepotModalComponent } from './depot-modal.component';

/**
 * Espace dépôt (2026-08) — le détail d'un camion (A3 § 5).
 *
 * ┌─ L'ENCART DE FERMETURE EST LE CŒUR DE CETTE MODALE ───────────────────────┐
 * │ « Hors fenêtre de mission, la position de ce camion vous est masquée. Vous  │
 * │ ne voyez ni ses trajets privés ni les autres véhicules du transporteur. »   │
 * │                                                                            │
 * │ Une fiche de camion, dans une application de flotte, promet habituellement  │
 * │ un suivi permanent. Celle-ci n'en promet pas — et le DIT, à l'endroit exact │
 * │ où le dépôt pourrait le supposer. C'est aussi ce que le transporteur montre │
 * │ à son conducteur pour lui expliquer ce qu'un tiers voit de lui.             │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ Aucun coût, aucun score de conduite, aucune consommation : ce sont les données
 * d'exploitation du transporteur (A3 § 7, règle 2). Les « missions du mois » et le
 * taux de ponctualité se calculent sur LES MISSIONS DU DÉPÔT, pas sur l'activité du
 * camion — le dépôt ne doit rien pouvoir déduire du volume de son transporteur.
 */
@Component({
  selector: 'app-depot-truck-modal',
  standalone: true,
  imports: [LucideAngularModule, DepotModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-depot-modal
      [titre]="mission().vehicle.plate"
      [sousTitre]="mission().vehicle.label"
      (fermer)="fermer.emit()"
    >
      <dl class="dtk-champs">
        <div><dt>Transporteur</dt><dd>{{ mission().carrierName }}</dd></div>
        @if (mission().driver; as c) {
          <div>
            <dt>Conducteur</dt>
            <dd class="dtk-conducteur">
              {{ c.displayName }}
              @if (c.phone) { <span class="dtk-tel">{{ c.phone }}</span> }
            </dd>
          </div>
        }
        <div><dt>Mission en cours</dt><dd>{{ mission().ref }} · {{ mission().origin }} → {{ mission().destination }}</dd></div>
        <div><dt>Créneau</dt><dd>{{ creneau() }}</dd></div>
      </dl>

      @if (mission().driver?.phone && suiviActif()) {
        <button type="button" class="dtk-appel" (click)="appeler()">
          <lucide-icon [img]="Phone" [size]="16" aria-hidden="true" />
          Appeler {{ mission().driver!.displayName }}
        </button>
      }

      <!-- Les chiffres du mois : calculés sur les missions DU DÉPÔT. -->
      <div class="dtk-mois">
        <div class="dtk-kpi">
          <span class="dtk-kpi-v">{{ missionsDuMois() }}</span>
          <span class="dtk-kpi-l">Vos missions ce mois-ci</span>
        </div>
        <div class="dtk-kpi">
          <span class="dtk-kpi-v">{{ ponctualite() === null ? '—' : ponctualite() + ' %' }}</span>
          <span class="dtk-kpi-l">Ponctualité sur ces missions</span>
        </div>
      </div>

      <!-- ═══ L'ENCART DE FERMETURE ═══════════════════════════════════════ -->
      <div class="dtk-cadenas">
        <lucide-icon [img]="Lock" [size]="17" aria-hidden="true" />
        <p>
          Hors fenêtre de mission, la position de ce camion vous est masquée.
          Vous ne voyez ni ses trajets privés ni les autres véhicules de {{ mission().carrierName }}.
        </p>
      </div>
    </app-depot-modal>
  `,
  styles: [`
    .dtk-champs { margin: 0 0 14px; display: flex; flex-direction: column; gap: 11px }
    .dtk-champs > div { display: flex; align-items: baseline; gap: 14px }
    .dtk-champs dt { flex: 0 0 132px; font-size: 12px; color: var(--depot-attenue) }
    .dtk-champs dd { margin: 0; font-size: 13.5px; font-weight: 600; color: var(--text-primary) }
    .dtk-conducteur { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap }
    /* Le numéro masqué vient du SERVEUR : le numéro complet ne transite jamais par
       le DTO, il passe par un endpoint dédié qui journalise l'accès (A3 § 7). */
    .dtk-tel { font-family: var(--font-mono); font-size: 12px; font-weight: 500; color: var(--depot-attenue) }

    .dtk-appel {
      display: inline-flex; align-items: center; gap: 8px; min-height: 40px; padding: 9px 16px;
      margin-bottom: 16px; border-radius: 11px; border: none;
      background: var(--color-tracky-light); color: var(--accent-ink);
      font-family: inherit; font-size: 13.5px; font-weight: 700; cursor: pointer;
    }

    .dtk-mois { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 14px }
    .dtk-kpi {
      display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; border-radius: 13px;
      background: var(--surface-tertiary); border: 1px solid var(--border-color);
    }
    .dtk-kpi-v { font-family: var(--font-display); font-size: 20px; font-weight: 800; line-height: 1; color: var(--text-primary) }
    .dtk-kpi-l { font-size: 11px; color: var(--depot-attenue) }

    /* Violet = dépôt. L'encart parle du périmètre du dépôt, il en porte la couleur. */
    .dtk-cadenas {
      display: flex; align-items: flex-start; gap: 11px; padding: 13px 15px; border-radius: 13px;
      background: color-mix(in srgb, var(--violet) 9%, transparent);
      border: 1px solid color-mix(in srgb, var(--violet) 26%, transparent);
    }
    .dtk-cadenas lucide-icon { flex: 0 0 auto; margin-top: 1px; color: var(--violet) }
    .dtk-cadenas p { margin: 0; font-size: 12.5px; line-height: 1.6; color: var(--text-secondary) }

    @media (max-width: 767px) {
      .dtk-champs > div { flex-direction: column; gap: 3px }
      .dtk-champs dt { flex: none }
      .dtk-appel { width: 100%; justify-content: center; min-height: 48px }
    }
  `],
})
export class DepotTruckModalComponent implements OnInit {
  readonly mission = input.required<DepotMissionDto>();
  readonly fermer = output<void>();

  private readonly api = inject(DepotApiService);
  private readonly toast = inject(ToastService);

  protected readonly Lock = Lock;
  protected readonly Phone = Phone;

  protected readonly missionsDuMois = signal(0);
  protected readonly ponctualite = signal<number | null>(null);

  protected readonly suiviActif = computed(
    () => this.mission().status === 'IN_PROGRESS' || this.mission().status === 'LATE',
  );

  protected readonly creneau = computed(() => {
    const m = this.mission();
    const h = (iso: string): string =>
      new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    return `${new Date(m.startAt).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long' })} · ${h(m.startAt)} → ${h(m.endAt)}`;
  });

  /**
   * Les chiffres du mois viennent de l'historique — donc des missions DU DÉPÔT,
   * bornées à ce camion. On ne demande jamais « l'activité de ce véhicule » : cette
   * question n'a pas de réponse dans l'espace dépôt, et c'est voulu.
   */
  async ngOnInit(): Promise<void> {
    try {
      const debutDuMois = new Date();
      debutDuMois.setDate(1);
      debutDuMois.setHours(0, 0, 0, 0);
      const h = await this.api.history({
        from: debutDuMois.toISOString(),
        plate: this.mission().vehicle.plate,
      });
      this.missionsDuMois.set(h.rows.length);
      const cloturees = h.rows.filter((r) => r.onTime !== null);
      this.ponctualite.set(
        cloturees.length === 0
          ? null
          : Math.round((cloturees.filter((r) => r.onTime).length / cloturees.length) * 100),
      );
    } catch (err) {
      swallow('depot-truck-modal:mois', err);
    }
  }

  protected async appeler(): Promise<void> {
    try {
      const { phone } = await this.api.numeroConducteur(this.mission().id);
      window.location.href = `tel:${phone}`;
    } catch (err) {
      swallow('depot-truck-modal:appeler', err);
      this.toast.show({
        kind: 'warning',
        title: 'Appel indisponible',
        message: 'Le contact du conducteur n\'est joignable que pendant le créneau de la mission.',
      });
    }
  }
}
