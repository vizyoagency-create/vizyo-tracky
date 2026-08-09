import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideAngularModule, Route, Truck, Warehouse } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';

/**
 * Espace dépôt (2026-08) — l'onglet Missions de `/agenda`. Cf. design/A2-MISSIONS.md § 6.
 *
 * **Pourquoi un composant à part** : `agenda.component.ts` fait 1816 lignes. Y verser
 * un tableau, ses filtres et ses cinq compteurs le rendrait plus difficile à relire —
 * et la refonte du bloc B devra le reprendre. Le panneau se monte dans l'agenda, il ne
 * s'y dissout pas.
 *
 * **Décision client, rappelée ici** : la mission vit dans l'agenda, pas dans une page à
 * part. Une page « Missions » séparée dupliquerait le calendrier, les filtres et la
 * gestion des conflits.
 */

interface MissionLigne {
  id: string;
  ref: string;
  origin: string;
  destination: string;
  startAt: string;
  endAt: string;
  status: 'PLANNED' | 'IN_PROGRESS' | 'LATE' | 'DONE' | 'CANCELLED';
  plate: string;
  driverName: string | null;
  depotId: string | null;
  depotName: string | null;
}

interface Compteurs {
  enCours: number;
  planifiees: number;
  enRetard: number;
  vehiculesIndisponibles: number;
  depotsDestinataires: number;
}

/** Filtres d'A2 § 6 : Toutes / En cours / Planifiées / Terminées. */
const FILTRES = [
  { valeur: '', libelle: 'Toutes' },
  { valeur: 'IN_PROGRESS', libelle: 'En cours' },
  { valeur: 'PLANNED', libelle: 'Planifiées' },
  { valeur: 'DONE', libelle: 'Terminées' },
] as const;

@Component({
  selector: 'app-missions-panel',
  standalone: true,
  imports: [LucideAngularModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <!-- ═══ Les 5 compteurs ═══════════════════════════════════════════════════
         « Véhicules indisponibles » est le lien VISIBLE avec l'effet 2 : il dit le
         coût des missions sur la disponibilité de la flotte. Sans lui, un gestionnaire
         ne comprend pas pourquoi il ne lui reste plus rien à réserver. -->
    <div class="mp-kpis">
      <div class="mp-kpi"><span class="mp-kpi-n">{{ compteurs().enCours }}</span><span class="mp-kpi-l">En cours</span></div>
      <div class="mp-kpi"><span class="mp-kpi-n">{{ compteurs().planifiees }}</span><span class="mp-kpi-l">Planifiées</span></div>
      <div class="mp-kpi" [class.mp-kpi--alerte]="compteurs().enRetard > 0">
        <span class="mp-kpi-n">{{ compteurs().enRetard }}</span><span class="mp-kpi-l">En retard</span>
      </div>
      <div class="mp-kpi">
        <span class="mp-kpi-n">{{ compteurs().vehiculesIndisponibles }}</span>
        <span class="mp-kpi-l">Véhicules indisponibles</span>
      </div>
      <div class="mp-kpi">
        <span class="mp-kpi-n">{{ compteurs().depotsDestinataires }}</span>
        <span class="mp-kpi-l">Dépôts destinataires</span>
      </div>
    </div>

    <div class="mp-filtres">
      @for (f of filtres; track f.valeur) {
        <button type="button" class="mp-filtre" [class.mp-filtre--actif]="filtre() === f.valeur"
                (click)="changerFiltre(f.valeur)">{{ f.libelle }}</button>
      }
    </div>

    @if (chargement()) {
      <div class="mp-sk">
        @for (i of [1,2,3,4]; track i) { <div class="sk mp-sk-ligne"></div> }
      </div>
    } @else if (missions().length === 0) {
      <p class="mp-vide">
        @if (filtre()) { Aucune mission pour ce filtre. } @else { Aucune mission créée pour l'instant. }
      </p>
    } @else {
      <div class="mp-table-wrap">
        <table class="mp-table">
          <thead>
            <tr>
              <th>Réf.</th><th>Trajet</th><th>Créneau</th><th>Véhicule</th>
              <th>Dépôt destinataire</th><th>Statut</th>
            </tr>
          </thead>
          <tbody>
            @for (m of missions(); track m.id) {
              <tr>
                <td class="mp-ref">{{ m.ref }}</td>
                <td>
                  <span class="mp-trajet">{{ m.origin }} → {{ m.destination }}</span>
                  @if (m.driverName) { <span class="mp-driver">{{ m.driverName }}</span> }
                </td>
                <td class="mp-creneau">{{ jour(m.startAt) }}<span>{{ heure(m.startAt) }} → {{ heure(m.endAt) }}</span></td>
                <td class="mp-plate">{{ m.plate }}</td>
                <td>
                  @if (m.depotName) {
                    <span class="mp-depot">
                      <lucide-icon [img]="Warehouse" [size]="13" />{{ m.depotName }}
                    </span>
                  } @else {
                    <!-- Mission interne : aucun tiers ne la voit. On le DIT, plutôt que
                         de laisser une case vide qu'on interprète comme un oubli. -->
                    <span class="mp-interne">Interne</span>
                  }
                </td>
                <td><span class="vt-status" [class]="classeStatut(m.status)">
                  <span class="vt-status__dot"></span>{{ libelleStatut(m.status) }}
                </span></td>
              </tr>
            }
          </tbody>
        </table>
      </div>
    }
  `,
  styles: [`
    .mp-kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 14px; }
    .mp-kpi { display: flex; flex-direction: column; gap: 3px; padding: 12px 14px; border-radius: 14px;
              background: var(--surface-secondary); border: 1px solid var(--border-color); }
    .mp-kpi--alerte { border-color: color-mix(in srgb, var(--danger) 40%, transparent); }
    .mp-kpi--alerte .mp-kpi-n { color: var(--danger); }
    .mp-kpi-n { font-family: var(--font-display); font-size: 22px; font-weight: 800; color: var(--text-primary); line-height: 1; }
    .mp-kpi-l { font-size: 11.5px; color: var(--text-tertiary); }

    .mp-filtres { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 12px; }
    .mp-filtre { padding: 7px 14px; border-radius: 9999px; font-size: 12.5px; font-weight: 600;
                 background: var(--surface-secondary); border: 1px solid var(--border-color);
                 color: var(--text-secondary); cursor: pointer; }
    .mp-filtre--actif { background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent);
                        border-color: color-mix(in srgb, var(--color-tracky-light) 30%, transparent);
                        color: var(--color-tracky-light); }

    /* Le tableau défile DANS son conteneur : la page ne défile jamais
       horizontalement (critère de recette B1 n° 5). */
    .mp-table-wrap { overflow-x: auto; border-radius: 14px; border: 1px solid var(--border-color); }
    .mp-table { width: 100%; border-collapse: collapse; min-width: 780px; }
    .mp-table th { text-align: left; padding: 10px 14px; font-size: 10.5px; font-weight: 600;
                   letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-tertiary);
                   background: var(--surface-tertiary); white-space: nowrap; }
    .mp-table td { padding: 12px 14px; font-size: 13px; border-top: 1px solid var(--border-color);
                   vertical-align: middle; }
    .mp-ref, .mp-plate { font-family: var(--font-mono); font-size: 12px; font-weight: 600; white-space: nowrap; }
    .mp-trajet { display: block; font-weight: 600; color: var(--text-primary); }
    .mp-driver { display: block; font-size: 11.5px; color: var(--text-tertiary); margin-top: 2px; }
    .mp-creneau { white-space: nowrap; color: var(--text-secondary); }
    .mp-creneau span { display: block; font-family: var(--font-mono); font-size: 11.5px; color: var(--text-tertiary); }
    .mp-depot { display: inline-flex; align-items: center; gap: 6px; color: var(--violet); font-weight: 600; font-size: 12.5px; }
    .mp-interne { font-size: 12px; color: var(--text-tertiary); font-style: italic; }
    .mp-vide { padding: 40px 0; text-align: center; font-size: 13.5px; color: var(--text-tertiary); }
    .mp-sk { display: flex; flex-direction: column; gap: 8px; }
    .mp-sk-ligne { height: 46px; border-radius: 12px; }
  `],
})
export class MissionsPanelComponent implements OnInit {
  private readonly http = inject(HttpClient);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly filtres = FILTRES;
  protected readonly Warehouse = Warehouse;
  protected readonly Truck = Truck;
  protected readonly Route = Route;

  protected readonly chargement = signal(true);
  protected readonly missions = signal<MissionLigne[]>([]);
  protected readonly filtre = signal<string>('');
  protected readonly compteurs = signal<Compteurs>({
    enCours: 0,
    planifiees: 0,
    enRetard: 0,
    vehiculesIndisponibles: 0,
    depotsDestinataires: 0,
  });

  ngOnInit(): void {
    this.charger();
  }

  protected changerFiltre(valeur: string): void {
    if (this.filtre() === valeur) return;
    this.filtre.set(valeur);
    this.charger();
  }

  private charger(): void {
    this.chargement.set(true);
    const params = this.filtre() ? `?status=${this.filtre()}` : '';
    this.http
      .get<{ missions: MissionLigne[]; compteurs: Compteurs }>(`/api/missions${params}`)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (r) => {
          this.missions.set(r?.missions ?? []);
          // ⚠️ Les compteurs viennent du SERVEUR et ne sont PAS recalculés sur la page
          // affichée : filtrée sur « En cours », elle ne contient pas les planifiées.
          // Les recalculer ici afficherait « 0 planifiées » dès qu'on filtre.
          if (r?.compteurs) this.compteurs.set(r.compteurs);
          this.chargement.set(false);
        },
        error: (err) => {
          swallow('missions-panel:charger', err);
          this.chargement.set(false);
        },
      });
  }

  protected jour(iso: string): string {
    return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
  }

  protected heure(iso: string): string {
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  /** Une couleur = une signification (design/TOKENS.md). */
  protected classeStatut(s: MissionLigne['status']): string {
    switch (s) {
      case 'IN_PROGRESS':
        return 'vt-status--on';
      case 'LATE':
        return 'vt-status--danger';
      case 'PLANNED':
        return 'vt-status--idle';
      default:
        return 'vt-status--offline';
    }
  }

  protected libelleStatut(s: MissionLigne['status']): string {
    return {
      PLANNED: 'Planifiée',
      IN_PROGRESS: 'En cours',
      LATE: 'En retard',
      DONE: 'Terminée',
      CANCELLED: 'Annulée',
    }[s];
  }
}
