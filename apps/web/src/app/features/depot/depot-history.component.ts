import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DEPOT_KPI_MIN_SAMPLE, type DepotHistoryDto, type DepotHistoryRowDto } from '@vizyo/tracky-shared';
import { Eye, FileDown, LucideAngularModule, ShieldCheck } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { DepotApiService } from './depot-api.service';
import { DepotLiveStore } from './depot-live.store';
import { DepotExportModalComponent } from './modals/depot-export-modal.component';
import { DepotTripModalComponent } from './modals/depot-trip-modal.component';

/**
 * Espace dépôt (2026-08) — l'onglet Historique (A3 § 3).
 *
 * ┌─ LE « % À L'HEURE » EST LA NOTE DU TRANSPORTEUR ──────────────────────────┐
 * │ C'est l'indicateur que le dépôt regarde vraiment. D'où deux exigences :     │
 * │                                                                            │
 * │  · il est CALCULÉ CÔTÉ SERVEUR — un calcul client obligerait à servir       │
 * │    toutes les missions de la période pour en dériver quatre nombres ;       │
 * │  · sous cinq missions, il affiche un TIRET EXPLIQUÉ, jamais « 0 % » ou      │
 * │    « 100 % ». Un taux sur deux missions n'est pas une note, mais il se lit  │
 * │    comme un jugement — et c'est celui-là qu'on retiendrait.                 │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * Le pied de tableau et la mention de conservation disent CE QUI N'EST PAS LÀ : les
 * trajets hors missions n'y figurent pas, et l'historique s'arrête à douze mois.
 * Même principe que l'encart de la carte — une absence nommée est une garantie, une
 * absence muette est un doute.
 */

const PERIODES = [
  { valeur: 7, libelle: '7 jours' },
  { valeur: 30, libelle: '30 jours' },
  { valeur: 0, libelle: 'Ce mois' },
] as const;

@Component({
  selector: 'app-depot-history',
  standalone: true,
  imports: [FormsModule, LucideAngularModule, DepotTripModalComponent, DepotExportModalComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="dh">
      <header class="dh-tete">
        <div>
          <h1>Historique</h1>
          <p>Vos missions terminées</p>
        </div>
        <button type="button" class="dh-btn dh-btn--accent" (click)="exportOuvert.set(true)">Exporter</button>
      </header>

      <!-- ═══ Filtres ═══════════════════════════════════════════════════════ -->
      <div class="dh-filtres">
        <div class="dh-chips" role="radiogroup" aria-label="Période">
          @for (p of periodes; track p.valeur) {
            <button
              type="button" role="radio" [attr.aria-checked]="periode() === p.valeur"
              class="dh-chip" [class.dh-chip--actif]="periode() === p.valeur"
              (click)="changerPeriode(p.valeur)"
            >{{ p.libelle }}</button>
          }
        </div>
        <select class="dh-select" [ngModel]="plaque()" (ngModelChange)="changerPlaque($event)" aria-label="Camion">
          <option value="">Tous les camions</option>
          @for (p of donnees()?.plates ?? []; track p) { <option [value]="p">{{ p }}</option> }
        </select>
        <select
          class="dh-select" [ngModel]="destination()" (ngModelChange)="changerDestination($event)"
          aria-label="Destination"
        >
          <option value="">Toutes les destinations</option>
          @for (d of donnees()?.destinations ?? []; track d) { <option [value]="d">{{ d }}</option> }
        </select>
      </div>

      <!-- ═══ 4 KPI ═════════════════════════════════════════════════════════ -->
      <div class="dh-kpis">
        <div class="dh-kpi">
          <span class="dh-kpi-v">{{ kpis()?.delivered ?? '—' }}</span>
          <span class="dh-kpi-l">Missions livrées</span>
        </div>
        <div class="dh-kpi dh-kpi--phare">
          <span class="dh-kpi-v">{{ kpis()?.onTimePercent !== null && kpis() ? kpis()!.onTimePercent + ' %' : '—' }}</span>
          <span class="dh-kpi-l">À l'heure</span>
          @if (kpis() && kpis()!.onTimePercent === null) {
            <!-- Le tiret EXPLIQUÉ : on dit pourquoi il n'y a pas de taux. -->
            <span class="dh-kpi-note">
              {{ kpis()!.onTimeSampleSize }} mission{{ kpis()!.onTimeSampleSize > 1 ? 's' : '' }} seulement,
              un taux demande {{ SEUIL }} missions
            </span>
          }
        </div>
        <div class="dh-kpi">
          <span class="dh-kpi-v">{{ dureeMoyenne() }}</span>
          <span class="dh-kpi-l">Durée moyenne</span>
        </div>
        <div class="dh-kpi">
          <span class="dh-kpi-v">{{ kpis()?.avgDelayMinutes !== null && kpis() ? kpis()!.avgDelayMinutes + ' min' : '—' }}</span>
          <span class="dh-kpi-l">
            Retard moyen
            @if (kpis() && kpis()!.delayedCount > 0) {
              · {{ kpis()!.delayedCount }} cas
            }
          </span>
        </div>
      </div>

      @if (chargement()) {
        <div class="dh-sks">
          @for (i of [1, 2, 3, 4]; track i) { <div class="sk" style="height:52px;border-radius:12px"></div> }
        </div>
      } @else if (lignes().length === 0) {
        <div class="dh-vide">
          <p class="dh-vide-titre">Vos missions terminées apparaîtront ici</p>
          <p class="dh-vide-txt">
            Dès qu'une livraison est close, son trajet rejoint cet historique avec ses heures réelles.
          </p>
        </div>
      } @else {
        <!-- ═══ MOBILE : cartes ═════════════════════════════════════════════
             Un tableau à 10 colonnes sur 390 px imposerait un défilement
             horizontal, interdit par B1 (critère 5) et A3 § 3. -->
        <ul class="dh-cartes">
          @for (r of lignes(); track r.missionId) {
            <li class="dh-carte">
              <div class="dh-carte-tete">
                <span class="dh-ref">{{ r.ref }}</span>
                <span class="dh-ponct" [class.dh-ponct--retard]="r.onTime === false">
                  {{ libellePonctualite(r) }}
                </span>
              </div>
              <p class="dh-carte-trajet">{{ r.origin }} → {{ r.destination }}</p>
              <div class="dh-carte-pied">
                <span class="dh-plaque">{{ r.plate }}</span>
                <span>{{ jour(r.date) }} · {{ creneauReel(r) }}</span>
              </div>
              <div class="dh-carte-actions">
                @if (r.tripId) {
                  <button type="button" class="dh-mini" (click)="tripOuvert.set(r.tripId)">Voir</button>
                }
                <button type="button" class="dh-mini" (click)="telechargerBon(r)">PDF</button>
              </div>
            </li>
          }
        </ul>

        <!-- ═══ PC : tableau ════════════════════════════════════════════════ -->
        <div class="dh-table-wrap">
          <table class="dh-table">
            <thead>
              <tr>
                <th>Réf.</th><th>Trajet</th><th>Date</th><th>Créneau réel</th><th>Camion</th>
                <th>Conducteur</th><th>Distance</th><th>Arrêts</th><th>Ponctualité</th><th></th>
              </tr>
            </thead>
            <tbody>
              @for (r of lignes(); track r.missionId) {
                <tr>
                  <td class="dh-ref">{{ r.ref }}</td>
                  <td class="dh-trajet">{{ r.origin }} → {{ r.destination }}</td>
                  <td>{{ jour(r.date) }}</td>
                  <td class="dh-mono">{{ creneauReel(r) }}</td>
                  <td class="dh-plaque">{{ r.plate }}</td>
                  <td>{{ r.driverName ?? '—' }}</td>
                  <td class="dh-mono">{{ r.distanceKm !== null ? r.distanceKm + ' km' : '—' }}</td>
                  <td class="dh-mono">{{ r.stops !== null ? r.stops : '—' }}</td>
                  <td>
                    <span class="dh-ponct" [class.dh-ponct--retard]="r.onTime === false">
                      {{ libellePonctualite(r) }}
                    </span>
                  </td>
                  <td class="dh-td-actions">
                    @if (r.tripId) {
                      <button type="button" class="dh-icone" (click)="tripOuvert.set(r.tripId)" aria-label="Voir le trajet">
                        <lucide-icon [img]="Eye" [size]="15" />
                      </button>
                    }
                    <button type="button" class="dh-icone" (click)="telechargerBon(r)" aria-label="Bon de livraison PDF">
                      <lucide-icon [img]="FileDown" [size]="15" />
                    </button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        </div>

        <!-- Le pied qui dit ce qui N'EST PAS là. -->
        <p class="dh-pied">
          {{ lignes().length }} trajet{{ lignes().length > 1 ? 's' : '' }} sur {{ donnees()?.totalRetained ?? 0 }} ·
          les trajets hors de vos missions ne figurent pas dans cet historique.
        </p>
      }

      <!-- La conservation est ÉCRITE DANS L'INTERFACE, pas seulement dans les CGU. -->
      <p class="dh-conservation">
        <lucide-icon [img]="ShieldCheck" [size]="14" aria-hidden="true" />
        Vos trajets sont conservés {{ donnees()?.retentionMonths ?? 12 }} mois. Passé ce délai,
        ils sortent de votre espace.
      </p>
    </section>

    @if (tripOuvert()) {
      <!-- Pas de (partager) ici : l'historique ne montre que des missions TERMINÉES,
           et une livraison close ne se partage plus (A4 § 7, règle 3). -->
      <app-depot-trip-modal [tripId]="tripOuvert()" (fermer)="tripOuvert.set(null)" />
    }
    @if (exportOuvert()) { <app-depot-export-modal (fermer)="exportOuvert.set(false)" /> }
  `,
  styles: [`
    .dh { max-width: 1180px; margin: 0 auto; padding: 20px 18px 40px }
    .dh-tete { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; margin-bottom: 16px }
    .dh-tete h1 {
      margin: 0; font-family: var(--font-display); font-size: 22px; font-weight: 800;
      letter-spacing: -.02em; color: var(--text-primary);
    }
    .dh-tete p { margin: 5px 0 0; font-size: 13px; color: var(--depot-attenue) }

    .dh-filtres { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; margin-bottom: 16px }
    .dh-chips { display: flex; gap: 7px; flex-wrap: wrap }
    .dh-chip {
      min-height: 36px; padding: 7px 14px; border-radius: 9999px;
      background: var(--surface-secondary); border: 1px solid var(--border-color);
      color: var(--text-secondary); font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
    }
    .dh-chip--actif {
      background: color-mix(in srgb, var(--violet) 14%, transparent);
      border-color: color-mix(in srgb, var(--violet) 36%, transparent); color: var(--violet);
    }
    .dh-select {
      min-height: 36px; padding: 7px 12px; border-radius: 10px;
      background: var(--surface-secondary); border: 1px solid var(--border-color);
      color: var(--text-secondary); font-family: inherit; font-size: 12.5px;
    }

    .dh-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 10px; margin-bottom: 18px }
    .dh-kpi {
      display: flex; flex-direction: column; gap: 3px; padding: 14px 16px; border-radius: 14px;
      background: var(--surface-secondary); border: 1px solid var(--border-color);
    }
    /* Le « % à l'heure » porte le violet du dépôt : c'est SON indicateur. */
    .dh-kpi--phare { border-color: color-mix(in srgb, var(--violet) 32%, transparent) }
    .dh-kpi--phare .dh-kpi-v { color: var(--violet) }
    .dh-kpi-v { font-family: var(--font-display); font-size: 25px; font-weight: 800; line-height: 1.05; color: var(--text-primary) }
    .dh-kpi-l { font-size: 11.5px; color: var(--depot-attenue) }
    .dh-kpi-note { margin-top: 4px; font-size: 11px; line-height: 1.45; color: var(--depot-attente) }

    .dh-sks { display: flex; flex-direction: column; gap: 8px }
    .dh-vide { padding: 48px 20px; text-align: center }
    .dh-vide-titre { margin: 0 0 6px; font-size: 16px; font-weight: 700; color: var(--text-primary) }
    .dh-vide-txt { margin: 0; font-size: 13.5px; color: var(--text-secondary) }

    .dh-table-wrap { overflow-x: auto; border-radius: 14px; border: 1px solid var(--border-color) }
    .dh-table { width: 100%; border-collapse: collapse; min-width: 940px }
    .dh-table th {
      text-align: left; padding: 10px 13px; font-size: 10.5px; font-weight: 600;
      letter-spacing: .08em; text-transform: uppercase; color: var(--depot-attenue);
      background: var(--surface-tertiary); white-space: nowrap;
    }
    .dh-table td { padding: 11px 13px; font-size: 13px; border-top: 1px solid var(--border-color); vertical-align: middle }
    .dh-ref, .dh-plaque, .dh-mono { font-family: var(--font-mono); font-size: 12px; white-space: nowrap }
    .dh-ref, .dh-plaque { font-weight: 600 }
    .dh-trajet { font-weight: 600; color: var(--text-primary) }
    .dh-ponct { font-size: 12px; font-weight: 700; color: var(--depot-succes); white-space: nowrap }
    .dh-ponct--retard { color: var(--depot-alerte) }
    .dh-td-actions { text-align: right; white-space: nowrap }
    .dh-icone {
      display: inline-grid; place-items: center; width: 30px; height: 30px; margin-left: 4px;
      border-radius: 8px; border: 1px solid var(--border-color); background: transparent;
      color: var(--text-secondary); cursor: pointer;
    }
    .dh-icone:hover { background: var(--surface-tertiary); color: var(--text-primary) }

    .dh-cartes { display: none }
    .dh-carte {
      display: flex; flex-direction: column; gap: 7px; padding: 13px 14px; border-radius: 14px;
      background: var(--surface-secondary); border: 1px solid var(--border-color);
      min-height: var(--densite-liste);
    }
    .dh-carte-tete { display: flex; align-items: center; justify-content: space-between; gap: 10px }
    .dh-carte-trajet { margin: 0; font-size: 14px; font-weight: 600; color: var(--text-primary) }
    .dh-carte-pied {
      display: flex; align-items: baseline; justify-content: space-between; gap: 10px; flex-wrap: wrap;
      font-family: var(--font-mono); font-size: 11.5px; color: var(--depot-attenue);
    }
    .dh-carte-actions { display: flex; gap: 7px }
    .dh-mini {
      min-height: 44px; padding: 8px 16px; border-radius: 10px;
      border: 1px solid var(--border-color); background: var(--surface-tertiary);
      color: var(--text-secondary); font-family: inherit; font-size: 12.5px; font-weight: 600; cursor: pointer;
    }

    .dh-pied { margin: 12px 0 0; font-size: 12px; color: var(--depot-attenue) }
    .dh-conservation {
      display: flex; align-items: center; gap: 8px; margin: 20px 0 0;
      padding: 11px 13px; border-radius: 12px;
      border: 1px dashed var(--border-strong-color);
      font-size: 12px; color: var(--depot-attenue);
    }
    .dh-conservation lucide-icon { flex: 0 0 auto }

    .dh-btn {
      min-height: 38px; padding: 9px 16px; border-radius: 11px;
      border: 1px solid var(--border-color); background: var(--surface-secondary);
      color: var(--text-secondary); font-family: inherit; font-size: 13px; font-weight: 600; cursor: pointer;
    }
    .dh-btn--accent { background: var(--color-tracky-light); border-color: transparent; color: var(--accent-ink) }

    @media (max-width: 900px) {
      .dh-table-wrap { display: none }
      .dh-cartes { display: flex; flex-direction: column; gap: 9px; margin: 0; padding: 0; list-style: none }
      .dh { padding: 16px 14px 32px }
      .dh-chip, .dh-select, .dh-btn { min-height: 44px }
    }
  `],
})
export class DepotHistoryComponent implements OnInit {
  private readonly api = inject(DepotApiService);
  private readonly toast = inject(ToastService);
  private readonly store = inject(DepotLiveStore);

  protected readonly periodes = PERIODES;
  protected readonly SEUIL = DEPOT_KPI_MIN_SAMPLE;
  protected readonly Eye = Eye;
  protected readonly FileDown = FileDown;
  protected readonly ShieldCheck = ShieldCheck;

  protected readonly donnees = signal<DepotHistoryDto | null>(null);
  protected readonly chargement = signal(true);
  protected readonly periode = signal<number>(30);
  protected readonly plaque = signal('');
  protected readonly destination = signal('');

  protected readonly tripOuvert = signal<string | null>(null);
  protected readonly exportOuvert = signal(false);

  protected readonly kpis = computed(() => this.donnees()?.kpis ?? null);
  protected readonly lignes = computed(() => this.donnees()?.rows ?? []);

  protected readonly dureeMoyenne = computed(() => {
    const minutes = this.kpis()?.avgDurationMinutes;
    if (minutes === null || minutes === undefined) return '—';
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return h > 0 ? `${h} h ${String(m).padStart(2, '0')}` : `${m} min`;
  });

  ngOnInit(): void {
    void this.charger();
    // La marque du transporteur en tête du menu, même sur un accès direct à cet
    // onglet (lien d'e-mail, favori) : cf. `DepotLiveStore.assurerMarque`.
    void this.store.assurerMarque();
  }

  protected changerPeriode(valeur: number): void {
    this.periode.set(valeur);
    void this.charger();
  }

  protected changerPlaque(valeur: string): void {
    this.plaque.set(valeur);
    void this.charger();
  }

  protected changerDestination(valeur: string): void {
    this.destination.set(valeur);
    void this.charger();
  }

  private async charger(): Promise<void> {
    this.chargement.set(true);
    try {
      const to = new Date();
      const from = new Date(to);
      if (this.periode() === 0) {
        from.setDate(1);
        from.setHours(0, 0, 0, 0);
      } else {
        from.setDate(from.getDate() - this.periode());
      }
      this.donnees.set(
        await this.api.history({
          from: from.toISOString(),
          to: to.toISOString(),
          plate: this.plaque() || undefined,
          destination: this.destination() || undefined,
        }),
      );
    } catch (err) {
      swallow('depot-history:charger', err);
    } finally {
      this.chargement.set(false);
    }
  }

  protected jour(iso: string): string {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  }

  /** Le créneau RÉEL — pas celui qui était annoncé. C'est la colonne que le dépôt
   *  compare à ce qu'on lui avait promis. */
  protected creneauReel(r: DepotHistoryRowDto): string {
    const h = (iso: string | null): string =>
      iso ? new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '—';
    return `${h(r.actualStartAt)} → ${h(r.actualEndAt)}`;
  }

  protected libellePonctualite(r: DepotHistoryRowDto): string {
    if (r.onTime === null) return '—';
    if (r.onTime) return "À l'heure";
    return `+${r.delayMinutes ?? 0} min`;
  }

  protected async telechargerBon(r: DepotHistoryRowDto): Promise<void> {
    try {
      const blob = await this.api.bonDeLivraison(`note:${r.missionId}`);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `bon-de-livraison_${r.ref}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      swallow('depot-history:bon', err);
      this.toast.show({
        kind: 'error',
        title: 'Document indisponible',
        message: 'Le bon de livraison n\'a pas pu être généré.',
      });
    }
  }
}
