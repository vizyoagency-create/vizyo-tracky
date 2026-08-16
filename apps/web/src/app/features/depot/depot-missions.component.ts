import { ChangeDetectionStrategy, Component, computed, inject, OnDestroy, OnInit, signal } from '@angular/core';
import type { DepotMissionDto } from '@vizyo/tracky-shared';
import { LucideAngularModule, Plus, Route as RouteIcon, Truck } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import {
  aLaMain,
  libelleStatut,
  montantEuros,
  tonStatut,
  MissionRequestsApi,
  type Demande,
} from '../../core/services/mission-requests.api';
import { MissionRequestModalComponent } from '../../shared/components/mission-request-modal.component';
import { ToastService } from '../../shared/ui/toast/toast.service';
import { DepotApiService } from './depot-api.service';
import { DepotLiveStore } from './depot-live.store';
import { DepotMissionCardComponent } from './depot-mission-card.component';
import { DepotIncidentModalComponent } from './modals/depot-incident-modal.component';
import { DepotOnboardingModalComponent } from './modals/depot-onboarding-modal.component';
import { DepotRequestModalComponent } from './modals/depot-request-modal.component';
import { DepotShareModalComponent } from './modals/depot-share-modal.component';
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
    DepotRequestModalComponent,
    DepotShareModalComponent,
    MissionRequestModalComponent,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="dms">
      <header class="dms-tete">
        <div class="dms-tete-txt">
          <h1>Mes missions</h1>
          <p>{{ store.missions().length }} mission{{ store.missions().length > 1 ? 's' : '' }} · {{ store.depotName() }}</p>
        </div>
        <!-- Lot A6 — la PREMIERE ecriture jamais offerte au role DEPOT. Elle vit ici,
             a cote de ses missions : c'est l'ecran ou il constate qu'il lui en manque
             une. -->
        <button type="button" class="dms-cta dms-demander" (click)="nouvelleDemande.set(true)">
          <lucide-icon [img]="Plus" [size]="16" aria-hidden="true" /> Demander une mission
        </button>
      </header>

      <!-- ═══ MES DEMANDES (A6) ══════════════════════════════════════════════
           Placees AVANT les missions, et c'est deliberé : une demande en cours
           attend un geste, une mission planifiee se consulte. Ce qui appelle une
           action passe devant ce qui informe. -->
      @if (demandes().length > 0) {
        <section class="dms-demandes">
          <h2 class="dms-section">
            Mes demandes
            @if (enAttente() > 0) {
              <span class="dms-pastille">{{ enAttente() }} en attente de vous</span>
            }
          </h2>
          <ul class="dms-dliste">
            @for (d of demandesTriees(); track d.id) {
              <li>
                <button type="button" class="dms-dligne"
                        [class.dms-dligne--moi]="jAiLaMain(d)"
                        (click)="demandeOuverte.set(d)">
                  <span class="dms-dl1">
                    <span class="dms-dref">{{ d.ref }}</span>
                    <span class="dms-dbadge" [class]="'dms-dbadge--' + ton(d)">{{ statut(d) }}</span>
                  </span>
                  <span class="dms-dl2">{{ trajet(d) }}</span>
                  <span class="dms-dl3">
                    <span>{{ quand(d) }}</span>
                    <strong>{{ montant(d) }}</strong>
                  </span>
                </button>
              </li>
            }
          </ul>
        </section>
      }

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
                @if (m.status !== 'DONE' && m.status !== 'CANCELLED') {
                  <button type="button" class="dms-btn" (click)="partageOuvert.set(m)">Partager le suivi</button>
                }
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
        (partager)="depuisTrajetVersPartage($event)"
      />
    }
    @if (incidentPour()) {
      <app-depot-incident-modal
        [missions]="store.missions()"
        [missionInitiale]="incidentPour()"
        (fermer)="incidentPour.set(null)"
      />
    }
    @if (partageOuvert(); as m) {
      <app-depot-share-modal [mission]="m" (fermer)="partageOuvert.set(null)" />
    }
    @if (onboardingOuvert()) {
      <app-depot-onboarding-modal [carrierName]="store.carrierName()" (fermer)="onboardingOuvert.set(false)" />
    }
    @if (nouvelleDemande()) {
      <app-depot-request-modal
        (envoyee)="rechargerDemandes()"
        (fermer)="nouvelleDemande.set(false)"
      />
    }
    <!-- Le MEME fil que celui du transporteur, avec le camp DEPOT : les deux parties
         lisent la meme chose, seuls les mots changent. Cf. mission-request-thread. -->
    @if (demandeOuverte(); as d) {
      <app-mission-request-modal
        [demande]="d"
        camp="DEPOT"
        (misAJour)="remplacerDemande($event)"
        (fermer)="demandeOuverte.set(null)"
      />
    }
  `,
  styles: [`
    .dms { max-width: 860px; margin: 0 auto; padding: 20px 18px 40px }
    .dms-tete {
      display: flex; align-items: flex-start; justify-content: space-between;
      gap: 14px; flex-wrap: wrap; margin-bottom: 18px;
    }
    .dms-tete-txt { min-width: 0 }
    .dms-demander { flex: 0 0 auto; display: inline-flex; align-items: center; gap: 7px }
    .dms-tete h1 {
      margin: 0; font-family: var(--font-display); font-size: 22px; font-weight: 800;
      letter-spacing: -.02em; color: var(--text-primary);
    }
    .dms-tete p { margin: 5px 0 0; font-size: 13px; color: var(--depot-attenue) }

    /* ─── Mes demandes (A6) ───────────────────────────────────────────────── */
    .dms-demandes { margin-bottom: 22px }
    .dms-section { display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
                   margin: 0 0 9px; font-size: 12px; font-weight: 700;
                   text-transform: uppercase; letter-spacing: .06em; color: var(--text-secondary) }
    .dms-pastille { padding: 2px 9px; border-radius: 9999px; font-size: 10.5px; font-weight: 700;
                    text-transform: none; letter-spacing: 0; color: var(--texte-attente);
                    background: color-mix(in srgb, var(--warning) 14%, transparent) }
    .dms-dliste { margin: 0; padding: 0; list-style: none;
                  display: flex; flex-direction: column; gap: 8px }
    .dms-dligne { display: flex; flex-direction: column; gap: 5px; width: 100%;
                  padding: 12px 14px; border-radius: 13px; text-align: left; cursor: pointer;
                  background: var(--surface-secondary); border: 1px solid var(--border-color);
                  font-family: inherit }
    .dms-dligne:hover { border-color: var(--border-strong-color) }
    /* Ce dont c'est le tour du depot porte un lisere : dans une liste, la difference
       doit se voir avant qu'on ait lu le badge. */
    .dms-dligne--moi { border-color: color-mix(in srgb, var(--warning) 40%, transparent) }
    .dms-dl1 { display: flex; align-items: center; gap: 9px; flex-wrap: wrap }
    .dms-dref { font-family: var(--font-display); font-size: 14px; font-weight: 800;
                color: var(--text-primary) }
    .dms-dbadge { padding: 2px 9px; border-radius: 9999px; font-size: 10.5px; font-weight: 700;
                  text-transform: uppercase; letter-spacing: .04em;
                  background: var(--surface-tertiary); color: var(--text-secondary) }
    .dms-dbadge--attente { color: var(--texte-attente) }
    .dms-dbadge--succes { color: var(--texte-succes) }
    .dms-dbadge--alerte { color: var(--texte-alerte) }
    .dms-dl2 { font-size: 13px; color: var(--text-primary); overflow-wrap: anywhere }
    .dms-dl3 { display: flex; align-items: baseline; justify-content: space-between;
               gap: 12px; font-size: 12px; color: var(--text-secondary) }
    .dms-dl3 > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .dms-dl3 strong { flex-shrink: 0; font-size: 13px; color: var(--text-primary) }

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
  /** Lot A6 — la seule surface du dépôt hors `/api/depot/*`, cf. `DepotApiService`. */
  private readonly requetes = inject(MissionRequestsApi);
  private readonly toast = inject(ToastService);

  protected readonly Plus = Plus;
  protected readonly RouteIcon = RouteIcon;
  protected readonly Truck = Truck;

  protected readonly selection = signal<string | null>(null);
  protected readonly tripOuvert = signal<string | null>(null);
  protected readonly incidentPour = signal<string | null>(null);
  protected readonly onboardingOuvert = signal(false);
  /** La modale de SAISIE d'une nouvelle demande. */
  protected readonly nouvelleDemande = signal(false);
  /** La modale de NÉGOCIATION d'une demande existante — la même que le transporteur. */
  protected readonly demandeOuverte = signal<Demande | null>(null);
  protected readonly demandes = signal<Demande[]>([]);

  /**
   * Ce dont c'est le tour du dépôt d'abord, puis le reste par date décroissante.
   *
   * Une demande qui attend SA réponse est la seule chose de cet écran sur laquelle il
   * peut agir : elle ne doit pas se retrouver sous trois accords conclus.
   */
  protected readonly demandesTriees = computed(() =>
    [...this.demandes()].sort((a, b) => {
      const ecart = Number(aLaMain(b, 'DEPOT')) - Number(aLaMain(a, 'DEPOT'));
      if (ecart !== 0) return ecart;
      return +new Date(b.createdAt) - +new Date(a.createdAt);
    }),
  );

  protected readonly enAttente = computed(
    () => this.demandes().filter((d) => aLaMain(d, 'DEPOT')).length,
  );
  protected readonly partageOuvert = signal<DepotMissionDto | null>(null);

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
    // Les deux chargements sont INDÉPENDANTS : une liste de demandes en échec ne doit
    // pas priver le dépôt de ses missions, qui sont l'objet principal de l'écran.
    void this.rechargerDemandes();
    await this.store.demarrer();
  }

  /**
   * Ses demandes. Un échec est SILENCIEUX, et c'est voulu : un compte dépôt créé avant
   * la permission `missions_request` reçoit un 403 légitime ici. Lui afficher une
   * bannière d'erreur sur un écran qui fonctionne par ailleurs lui apprendrait que
   * l'outil est cassé, alors qu'il ne l'est pas — c'est la modale de demande, elle,
   * qui explique le cas quand il l'ouvre.
   */
  protected async rechargerDemandes(): Promise<void> {
    try {
      this.demandes.set(await this.requetes.lister());
    } catch (err) {
      swallow('depot-missions:demandes', err);
      this.demandes.set([]);
    }
  }

  protected remplacerDemande(maj: Demande): void {
    this.demandes.update((liste) => liste.map((d) => (d.id === maj.id ? maj : d)));
    this.demandeOuverte.set(maj);
  }

  // ═══ AFFICHAGE DES DEMANDES ════════════════════════════════════════════════

  protected jAiLaMain(d: Demande): boolean {
    return aLaMain(d, 'DEPOT');
  }

  protected statut(d: Demande): string {
    return libelleStatut(d.status);
  }

  protected ton(d: Demande): string {
    return tonStatut(d.status);
  }

  protected montant(d: Demande): string {
    return montantEuros(d.agreedAmountCents ?? d.currentAmountCents);
  }

  protected trajet(d: Demande): string {
    const s = d.stops;
    if (s.length === 0) return '—';
    const base = `${s[0].label} → ${s[s.length - 1].label}`;
    return s.length > 2 ? `${base} (${s.length - 1} livraisons)` : base;
  }

  protected quand(d: Demande): string {
    return new Date(d.wantedStartAt).toLocaleString('fr-FR', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  ngOnDestroy(): void {
    this.store.arreter();
  }

  /** Depuis la modale de trajet : on ferme le trajet et on ouvre le partage. */
  protected depuisTrajetVersPartage(missionId: string): void {
    const m = this.store.missions().find((x) => x.id === missionId);
    this.tripOuvert.set(null);
    if (m) this.partageOuvert.set(m);
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
