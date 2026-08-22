import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, DestroyRef, effect, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LucideAngularModule, Plus, Route, Truck, Warehouse } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { httpFailureMessage } from '../../core/services/http-failure';
import { MissionDialogComponent } from './mission-dialog/mission-dialog.component';
import { MissionStopsModalComponent } from './mission-stops-modal.component';

/**
 * Le message a afficher pour une panne de chargement des missions.
 *
 * Le message du SERVEUR passe en premier quand il existe : c'est lui qui porte la
 * cause. « Aucune flotte associée » dit quoi corriger ; « Vous n'avez pas
 * l'autorisation », derive du seul statut 403, serait ici FAUX — un super-admin a
 * bien le droit, il n'a simplement aucune societe rattachee. Le repli generique ne
 * sert que lorsque la reponse ne dit rien.
 */
export function messageDePanne(err: unknown): string {
  const brut = (err as { error?: { message?: unknown } } | null)?.error?.message;
  const duServeur = typeof brut === 'string' ? brut.trim() : '';
  return duServeur || httpFailureMessage(err, 'les missions');
}

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
  /**
   * A6 / T8 — les arrêts, dans l'ordre de passage. VIDE ou absent sur une mission
   * point à point, et sur toutes celles créées avant T8.
   */
  stops?: string[];
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
  imports: [LucideAngularModule, MissionDialogComponent, MissionStopsModalComponent],
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

    <div class="mp-barre">
      <div class="mp-filtres">
        @for (f of filtres; track f.valeur) {
          <button type="button" class="mp-filtre" [class.mp-filtre--actif]="filtre() === f.valeur"
                  (click)="changerFiltre(f.valeur)">{{ f.libelle }}</button>
        }
      </div>
      <button type="button" class="mp-creer" (click)="modaleOuverte.set(true)">
        <lucide-icon [img]="Plus" [size]="15" />Nouvelle mission
      </button>
    </div>

    @if (modaleOuverte()) {
      <app-mission-dialog (fermer)="modaleOuverte.set(false)" (creee)="charger()" />
    }
    @if (tourneeOuverte(); as m) {
      <app-mission-stops-modal
        [missionId]="m.id"
        [missionRef]="m.ref"
        [arretsInitiaux]="arretsDe(m)"
        (modifiee)="charger()"
        (fermer)="tourneeOuverte.set(null)"
      />
    }

    @if (chargement()) {
      <div class="mp-sk">
        @for (i of [1,2,3,4]; track i) { <div class="sk mp-sk-ligne"></div> }
      </div>
    } @else if (erreur()) {
      <!-- Une panne se DIT, et se distingue d'une liste vide. Le message du serveur
           passe en premier quand il existe : « Aucune flotte associée » indique la
           cause, là où « impossible de charger » ne fait que constater. -->
      <div class="mp-panne">
        <p class="mp-panne-txt">{{ erreur() }}</p>
        <button type="button" class="mp-panne-btn" (click)="charger()">Réessayer</button>
      </div>
    } @else if (missions().length === 0) {
      <p class="mp-vide">
        @if (filtre()) { Aucune mission pour ce filtre. } @else { Aucune mission créée pour l'instant. }
      </p>
    } @else {
      <!-- ═══ MOBILE : des CARTES, pas un tableau ════════════════════════════
           Un tableau à 6 colonnes sur 390 px impose un défilement horizontal, que
           B1 (critère 5) et A3 § 3 interdisent tous les deux. La carte porte la
           même information, empilée, à la densité de la plateforme. -->
      <ul class="mp-cartes">
        @for (m of missions(); track m.id) {
          <li class="mp-carte">
            <div class="mp-carte-tete">
              <span class="mp-ref">{{ m.ref }}</span>
              <span class="vt-status" [class]="classeStatut(m.status)">
                <span class="vt-status__dot"></span>{{ libelleStatut(m.status) }}
              </span>
            </div>
            <p class="mp-carte-trajet">{{ trajet(m) }}</p>
            <div class="mp-carte-pied">
              <span class="mp-plate">{{ m.plate }}</span>
              <span class="mp-carte-creneau">{{ jour(m.startAt) }} · {{ heure(m.startAt) }} → {{ heure(m.endAt) }}</span>
            </div>
            @if (m.depotName) {
              <span class="mp-depot"><lucide-icon [img]="Warehouse" [size]="13" />{{ m.depotName }}</span>
            } @else {
              <span class="mp-interne">Mission interne</span>
            }
            <!-- A6 — la tournee se modifie APRES creation, avec motif et journal. Le
                 bouton disparait sur une mission terminee ou annulee : son trajet a
                 eu lieu, ou n'aura pas lieu, et le serveur refuse de le reecrire. -->
            @if (modifiable(m)) {
              <button type="button" class="mp-tournee" (click)="ouvrirTournee(m)">
                <lucide-icon [img]="Route" [size]="14" /> Modifier la tournée
              </button>
            }
          </li>
        }
      </ul>

      <div class="mp-table-wrap">
        <table class="mp-table">
          <thead>
            <tr>
              <th>Réf.</th><th>Trajet</th><th>Créneau</th><th>Véhicule</th>
              <th>Dépôt destinataire</th><th>Statut</th><th></th>
            </tr>
          </thead>
          <tbody>
            @for (m of missions(); track m.id) {
              <tr>
                <td class="mp-ref">{{ m.ref }}</td>
                <td>
                  <span class="mp-trajet">{{ trajet(m) }}</span>
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
                <td>
                  @if (modifiable(m)) {
                    <button type="button" class="mp-tournee" (click)="ouvrirTournee(m)">
                      <lucide-icon [img]="Route" [size]="14" /> Tournée
                    </button>
                  }
                </td>
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

    .mp-barre { display: flex; align-items: center; justify-content: space-between; gap: 12px;
                flex-wrap: wrap; margin-bottom: 12px; }
    .mp-creer { display: inline-flex; align-items: center; gap: 7px; padding: 8px 15px;
                border-radius: 10px; border: none; font-size: 13px; font-weight: 700;
                font-family: inherit; cursor: pointer;
                background: var(--color-tracky-light); color: var(--accent-ink); }
    .mp-filtres { display: flex; gap: 7px; flex-wrap: wrap; }
    .mp-filtre { padding: 7px 14px; border-radius: 9999px; font-size: 12.5px; font-weight: 600;
                 background: var(--surface-secondary); border: 1px solid var(--border-color);
                 color: var(--text-secondary); cursor: pointer; }
    /* Etat actif d'un segment : --texte-succes, jamais le vert de marque
       (convention du kit, styles.css — 3:1 en clair sur ce lavis). */
    .mp-filtre--actif { background: color-mix(in srgb, var(--color-tracky-light) 12%, transparent);
                        border-color: color-mix(in srgb, var(--color-tracky-light) 30%, transparent);
                        color: var(--texte-succes); }

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
    /* ─── Cartes mobiles ────────────────────────────────────────────────────
       Masquées sur large écran ; c'est le tableau qui prend le relais. On ne
       duplique pas la donnée : le même signal alimente les deux rendus. */
    .mp-cartes { display: none; }
    /* A6 — modifier la tournee. Discret : c'est un geste rare, mais qui doit rester
       trouvable sans ouvrir un menu.
       ⚠️ DECLARE AVANT le bloc mobile, et pas apres : a specificite egale, c'est la
       DERNIERE regle qui gagne. Place en dessous, cette hauteur minimale de 34 px
       ecrasait le 44 px du telephone — la recette l'a mesure et l'a refuse. */
    .mp-tournee {
      display: inline-flex; align-items: center; gap: 6px; align-self: flex-start;
      min-height: 34px; padding: 7px 12px; border-radius: 9px; cursor: pointer;
      font-family: inherit; font-size: 12px; font-weight: 600;
      background: transparent; border: 1px dashed var(--border-strong-color);
      color: var(--text-secondary);
    }
    .mp-tournee:hover { color: var(--text-primary); border-style: solid; }

    @media (max-width: 767px) {
      .mp-table-wrap { display: none; }
      .mp-cartes { display: flex; flex-direction: column; gap: 9px; margin: 0; padding: 0; list-style: none; }

      /* Cibles tactiles : mesurees a 35 px (filtres) et 36 px (creer) pendant la
         recette du 2026-08-14. Les quatre filtres sont colles les uns aux autres —
         c'est la que quatre pixels manquants se paient, pas sur un bouton isole. */
      .mp-filtre { min-height: 44px; }
      .mp-creer { min-height: 44px; }
      .mp-tournee { min-height: 44px; }
    }
    .mp-carte { display: flex; flex-direction: column; gap: 7px; padding: 13px 14px;
                border-radius: 14px; background: var(--surface-secondary);
                border: 1px solid var(--border-color);
                /* Densité de la plateforme : 44 px sur iOS, 56 px sur Android. */
                min-height: var(--densite-liste); }
    .mp-carte-tete { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .mp-carte-trajet { margin: 0; font-size: 14px; font-weight: 600; line-height: 1.35;
                       color: var(--text-primary); }
    .mp-carte-pied { display: flex; align-items: baseline; justify-content: space-between;
                     gap: 10px; flex-wrap: wrap; }
    .mp-carte-creneau { font-family: var(--font-mono); font-size: 11.5px; color: var(--text-tertiary); }

    .mp-vide { padding: 40px 0; text-align: center; font-size: 13.5px; color: var(--text-tertiary); }
    .mp-panne { padding: 32px 16px; text-align: center; display: flex; flex-direction: column;
                align-items: center; gap: 12px; }
    .mp-panne-txt { font-size: 13.5px; color: var(--texte-alerte); max-width: 34ch; margin: 0; }
    .mp-panne-btn { min-height: 44px; padding: 0 18px; border-radius: 10px; cursor: pointer;
                    font-size: 13.5px; font-weight: 600; color: var(--fg-primary);
                    background: var(--bg-secondary); border: 1px solid var(--border-subtle); }
    .mp-panne-btn:hover { background: var(--bg-tertiary); }
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
  protected readonly Plus = Plus;

  protected readonly modaleOuverte = signal(false);
  /** A6 — la mission dont on modifie la tournée. */
  protected readonly tourneeOuverte = signal<MissionLigne | null>(null);

  /**
   * Une tournée terminée ou annulée ne se retouche pas : son trajet a eu lieu, ou
   * n'aura pas lieu. Le serveur le refuse ; l'écran ne propose donc pas le geste.
   */
  protected modifiable(m: MissionLigne): boolean {
    return m.status !== 'DONE' && m.status !== 'CANCELLED';
  }

  protected ouvrirTournee(m: MissionLigne): void {
    this.tourneeOuverte.set(m);
  }

  /**
   * Les arrêts à charger dans la modale.
   *
   * Une mission point à point n'en a aucun : on lui passe alors ses deux libellés,
   * qui SONT sa tournée à deux points. Sans cela, le formulaire s'ouvrirait vide sur
   * une mission qui a bel et bien un départ et une arrivée.
   */
  protected arretsDe(m: MissionLigne): string[] {
    return m.stops && m.stops.length >= 2 ? m.stops : [m.origin, m.destination];
  }
  private readonly fleetFilter = inject(FleetFilterService);
  /** Le sélecteur de société change → on recharge dans la nouvelle société. */
  private readonly effetSociete = effect(() => {
    this.fleetFilter.selectedFleetId();
    this.charger();
  });

  protected readonly chargement = signal(true);
  /** Motif de panne du dernier chargement, ou `null`. Distinct d'une liste vide. */
  protected readonly erreur = signal<string | null>(null);
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

  /** Public : la modale la rappelle après une création réussie. */
  protected charger(): void {
    this.chargement.set(true);
    this.erreur.set(null);
    // Un SUPER_ADMIN n'a pas de flotte : sans ce paramètre, le serveur ne sait pas
    // dans quelle société lire, et répondait « Aucune flotte associée ».
    const q = new URLSearchParams();
    if (this.filtre()) q.set('status', this.filtre());
    const societe = this.fleetFilter.selectedFleetId();
    if (societe) q.set('fleetId', societe);
    const params = q.toString() ? `?${q}` : '';
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
          // ⚠️ C'ETAIT UN ECHEC MUET. La liste restait vide et l'ecran affichait
          // « Aucune mission créée pour l'instant » — LA REPONSE METIER D'UNE FLOTTE
          // SANS MISSION — pour un 403, une session expiree ou une panne serveur.
          // Cas reel (2026-08-12) : un SUPER_ADMIN a `fleetId = null`, le serveur
          // repondait « Aucune flotte associée », et l'onglet annonçait sereinement
          // qu'aucune mission n'existait tout en faisant surgir un toast d'erreur.
          // Deux messages contradictoires, dont aucun n'indiquait quoi faire.
          this.erreur.set(messageDePanne(err));
          this.chargement.set(false);
        },
      });
  }

  /**
   * A6 / T8 — le trajet, en une ligne, qu'il ait deux points ou six.
   *
   * ┌─ ON NE DÉROULE PAS LA TOURNÉE ICI ────────────────────────────────────────┐
   * │ Cette liste sert à retrouver une mission, pas à préparer une feuille de    │
   * │ route. Six adresses sur une ligne de tableau la rendent illisible, et sur  │
   * │ une carte mobile elle passe sur quatre lignes. On garde donc les deux      │
   * │ bouts — les seuls que le gestionnaire cherche des yeux — et on ANNONCE le  │
   * │ nombre de livraisons, qui est l'information réellement nouvelle.            │
   * └────────────────────────────────────────────────────────────────────────────┘
   *
   * Deux arrêts ou moins → exactement la chaîne d'avant T8. C'est ce qui garantit
   * qu'aucune mission existante ne change d'apparence.
   */
  protected trajet(m: MissionLigne): string {
    const base = `${m.origin} → ${m.destination}`;
    const n = m.stops?.length ?? 0;
    return n > 2 ? `${base} (${n - 1} livraisons)` : base;
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
