import { ChangeDetectionStrategy, Component, computed, inject, OnInit, signal } from '@angular/core';
import { Inbox, LucideAngularModule, RefreshCw } from 'lucide-angular';
import { swallow } from '../../core/error/swallow';
import { FleetFilterService } from '../../core/services/fleet-filter.service';
import { httpFailureMessage } from '../../core/services/http-failure';
import {
  aLaMain,
  libelleStatut,
  montantEuros,
  tonStatut,
  MissionRequestsApi,
  type Demande,
} from '../../core/services/mission-requests.api';
import { MissionRequestModalComponent } from '../../shared/components/mission-request-modal.component';

/**
 * A6 / T6 — l'onglet **Demandes** de `/missions`, côté TRANSPORTEUR.
 * Cf. docs/A6-DEMANDES-ET-DEVIS.md § 7bis.
 *
 * ┌─ UNE FILE D'ATTENTE, PAS UN TABLEAU ──────────────────────────────────────┐
 * │ Ce que le gestionnaire vient faire ici tient en une question : « qu'est-ce │
 * │ qui m'attend ? ». L'écran répond en mettant EN TÊTE ce dont c'est le tour, │
 * │ de la plus ancienne à la plus récente — une demande qui attend depuis deux │
 * │ jours passe avant celle d'il y a dix minutes.                              │
 * │                                                                            │
 * │ Le reste (accords conclus, refusées, expirées) suit, en dessous : ça se    │
 * │ consulte, ça ne se traite pas. Trier tout par date de création aurait noyé │
 * │ les trois demandes urgentes sous quarante demandes closes.                 │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ⚠️ LE PÉRIMÈTRE EST CELUI DU SERVEUR. `GET /mission-requests` ne rend que les
 * demandes de la société : aucun filtrage côté client ne remplace ça, et il ne faut
 * surtout pas en ajouter un qui donnerait l'illusion d'une protection.
 */
@Component({
  selector: 'app-mission-requests-tab',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule, MissionRequestModalComponent],
  template: `
    @if (chargement()) {
      <div class="mrq-sk">@for (i of [1,2,3]; track i) { <div class="sk mrq-sk-l"></div> }</div>
    } @else if (erreur()) {
      <div class="mrq-panne">
        <p>{{ erreur() }}</p>
        <button type="button" class="mrq-btn" (click)="charger()">Réessayer</button>
      </div>
    } @else {
      <header class="mrq-tete">
        <p class="mrq-compte">
          @if (aTraiter().length > 0) {
            <strong>{{ aTraiter().length }}</strong> demande{{ aTraiter().length > 1 ? 's' : '' }}
            {{ aTraiter().length > 1 ? 'attendent' : 'attend' }} votre réponse
          } @else {
            Aucune demande n'attend votre réponse
          }
        </p>
        <button type="button" class="mrq-btn" (click)="charger()" aria-label="Actualiser la liste">
          <lucide-icon [img]="RefreshCw" [size]="15" /> Actualiser
        </button>
      </header>

      @if (demandes().length === 0) {
        <!-- L'etat vide dit CE QUI VA SE PASSER, pas seulement qu'il n'y a rien. -->
        <div class="mrq-vide">
          <span class="vt-icon-tile mrq-vide-ico"><lucide-icon [img]="Inbox" [size]="24" /></span>
          <h3>Aucune demande pour l'instant</h3>
          <p>
            Vos dépôts peuvent demander une mission depuis leur espace. Vous recevrez un
            e-mail à chaque demande, avec le devis calculé sur votre grille tarifaire.
          </p>
        </div>
      } @else {
        @if (aTraiter().length > 0) {
          <h3 class="mrq-section">À traiter</h3>
          <ul class="mrq-liste">
            @for (d of aTraiter(); track d.id) {
              <li>
                <button type="button" class="mrq-ligne mrq-ligne--urgente" (click)="ouvrir(d)">
                  <span class="mrq-l1">
                    <span class="mrq-ref">{{ d.ref }}</span>
                    <span class="mrq-badge mrq-badge--attente">{{ statut(d) }}</span>
                    <span class="mrq-age">{{ age(d) }}</span>
                  </span>
                  <span class="mrq-l2">{{ trajet(d) }}</span>
                  <span class="mrq-l3">
                    <span>{{ d.depot?.nom || 'Dépôt' }} · {{ creneau(d) }}</span>
                    <strong>{{ montant(d) }}</strong>
                  </span>
                </button>
              </li>
            }
          </ul>
        }

        @if (suivies().length > 0) {
          <h3 class="mrq-section">Le reste</h3>
          <ul class="mrq-liste">
            @for (d of suivies(); track d.id) {
              <li>
                <button type="button" class="mrq-ligne" (click)="ouvrir(d)">
                  <span class="mrq-l1">
                    <span class="mrq-ref">{{ d.ref }}</span>
                    <span class="mrq-badge" [class]="'mrq-badge--' + ton(d)">{{ statut(d) }}</span>
                    <span class="mrq-age">{{ age(d) }}</span>
                  </span>
                  <span class="mrq-l2">{{ trajet(d) }}</span>
                  <span class="mrq-l3">
                    <span>{{ d.depot?.nom || 'Dépôt' }} · {{ creneau(d) }}</span>
                    <strong>{{ montant(d) }}</strong>
                  </span>
                </button>
              </li>
            }
          </ul>
        }
      }
    }

    @if (ouverte(); as d) {
      <app-mission-request-modal
        [demande]="d"
        camp="CARRIER"
        (misAJour)="remplacer($event)"
        (fermer)="ouverte.set(null)"
      />
    }
  `,
  styles: [`
    :host { display: block }

    .mrq-tete { display: flex; align-items: center; justify-content: space-between;
                gap: 12px; flex-wrap: wrap; margin-bottom: 14px }
    .mrq-compte { margin: 0; font-size: 13.5px; color: var(--fg-secondary) }
    .mrq-compte strong { color: var(--fg-primary) }

    .mrq-section { margin: 18px 0 8px; font-size: 11.5px; font-weight: 700;
                   text-transform: uppercase; letter-spacing: .06em; color: var(--fg-secondary) }
    .mrq-section:first-of-type { margin-top: 0 }

    .mrq-liste { margin: 0; padding: 0; list-style: none;
                 display: flex; flex-direction: column; gap: 8px }
    .mrq-ligne { display: flex; flex-direction: column; gap: 6px; width: 100%;
                 padding: 12px 14px; border-radius: 13px; text-align: left; cursor: pointer;
                 background: var(--bg-secondary); border: 1px solid var(--border-subtle);
                 font-family: inherit }
    .mrq-ligne:hover { border-color: var(--border-strong) }
    /* Ce dont c'est le tour porte un liseré : dans une file de vingt lignes, la
       distinction doit se voir sans lire les badges un par un. */
    .mrq-ligne--urgente { border-color: color-mix(in srgb, var(--warning) 40%, transparent) }

    .mrq-l1 { display: flex; align-items: center; gap: 9px; flex-wrap: wrap }
    .mrq-ref { font-family: var(--font-display); font-size: 14px; font-weight: 800;
               color: var(--fg-primary) }
    .mrq-badge { padding: 2px 9px; border-radius: 9999px; font-size: 10.5px; font-weight: 700;
                 text-transform: uppercase; letter-spacing: .04em;
                 background: var(--bg-tertiary); color: var(--fg-secondary) }
    .mrq-badge--attente { color: var(--texte-attente) }
    .mrq-badge--succes { color: var(--texte-succes) }
    .mrq-badge--alerte { color: var(--texte-alerte) }
    .mrq-age { margin-left: auto; flex-shrink: 0; font-size: 11.5px; color: var(--fg-secondary) }

    .mrq-l2 { font-size: 13px; color: var(--fg-primary); overflow-wrap: anywhere }
    .mrq-l3 { display: flex; align-items: baseline; justify-content: space-between;
              gap: 12px; font-size: 12px; color: var(--fg-secondary) }
    .mrq-l3 > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap }
    .mrq-l3 strong { flex-shrink: 0; font-size: 13px; color: var(--fg-primary) }

    .mrq-vide { display: flex; flex-direction: column; align-items: center; gap: 11px;
                padding: 44px 20px; text-align: center }
    .mrq-vide-ico { width: 54px; height: 54px; border-radius: 16px }
    .mrq-vide h3 { margin: 0; font-family: var(--font-display); font-size: 18px;
                   font-weight: 800; color: var(--fg-primary) }
    .mrq-vide p { margin: 0; max-width: 460px; font-size: 13px; line-height: 1.65;
                  color: var(--fg-secondary) }

    .mrq-panne { display: flex; flex-direction: column; align-items: center; gap: 12px;
                 padding: 32px 16px; text-align: center }
    .mrq-panne p { margin: 0; max-width: 34ch; font-size: 13.5px; color: var(--texte-alerte) }
    .mrq-btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px;
               min-height: 44px; padding: 0 15px; border-radius: 10px; cursor: pointer;
               font-family: inherit; font-size: 13px; font-weight: 600;
               background: var(--bg-tertiary); border: 1px solid var(--border-subtle);
               color: var(--fg-primary) }
    .mrq-sk { display: flex; flex-direction: column; gap: 9px }
    .mrq-sk-l { height: 76px; border-radius: 13px }

    @media (max-width: 560px) {
      .mrq-age { margin-left: 0 }
      .mrq-l3 { flex-direction: column; gap: 3px; align-items: flex-start }
      .mrq-l3 > span { white-space: normal }
    }
  `],
})
export class MissionRequestsTabComponent implements OnInit {
  private readonly api = inject(MissionRequestsApi);
  private readonly fleetFilter = inject(FleetFilterService);

  protected readonly Inbox = Inbox;
  protected readonly RefreshCw = RefreshCw;

  protected readonly chargement = signal(true);
  protected readonly erreur = signal<string | null>(null);
  protected readonly demandes = signal<Demande[]>([]);
  protected readonly ouverte = signal<Demande | null>(null);

  /**
   * Ce dont c'est LE TOUR DU TRANSPORTEUR, de la plus ancienne à la plus récente.
   *
   * Le tri par ancienneté n'est pas cosmétique : une demande oubliée trois jours est
   * un dépôt qui a déjà appelé. La plus vieille passe donc devant, quelle que soit sa
   * date d'arrivée dans la liste.
   */
  protected readonly aTraiter = computed(() =>
    this.demandes()
      .filter((d) => aLaMain(d, 'CARRIER'))
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
  );

  /**
   * Tout le reste : ce qui attend le dépôt, les accords à affecter, et les closes.
   *
   * Les accords conclus mais NON AFFECTÉS passent en tête : ce sont eux qui portent
   * encore un geste du transporteur, même s'ils ne sont plus une négociation.
   */
  protected readonly suivies = computed(() =>
    this.demandes()
      .filter((d) => !aLaMain(d, 'CARRIER'))
      .sort((a, b) => this.rang(a) - this.rang(b) || +new Date(b.createdAt) - +new Date(a.createdAt)),
  );

  ngOnInit(): void {
    void this.charger();
  }

  protected async charger(): Promise<void> {
    this.chargement.set(true);
    this.erreur.set(null);
    try {
      // Le super-admin travaille dans la société choisie au bandeau ; pour les autres,
      // le serveur borne de toute façon.
      const fleetId = this.fleetFilter.selectedFleetId() ?? undefined;
      this.demandes.set(await this.api.lister(fleetId));
    } catch (err) {
      swallow('mission-requests-tab:charger', err);
      this.erreur.set(httpFailureMessage(err, 'les demandes'));
    } finally {
      this.chargement.set(false);
    }
  }

  protected ouvrir(d: Demande): void {
    this.ouverte.set(d);
  }

  /**
   * Une action a changé la demande : on remplace LA LIGNE, sans recharger la liste.
   *
   * Recharger fermerait la modale sur un rendu intermédiaire et ferait perdre le
   * contexte de lecture. Le serveur a déjà rendu l'état à jour — il n'y a rien de plus
   * à demander.
   */
  protected remplacer(maj: Demande): void {
    this.demandes.update((liste) => liste.map((d) => (d.id === maj.id ? maj : d)));
  }

  // ═══ AFFICHAGE ═════════════════════════════════════════════════════════════

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

  protected creneau(d: Demande): string {
    return new Date(d.wantedStartAt).toLocaleString('fr-FR', {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  /** L'âge de la demande, en clair : c'est lui qui dit l'urgence. */
  protected age(d: Demande): string {
    const minutes = Math.max(0, Math.round((Date.now() - +new Date(d.createdAt)) / 60_000));
    if (minutes < 60) return `il y a ${minutes} min`;
    const heures = Math.round(minutes / 60);
    if (heures < 24) return `il y a ${heures} h`;
    const jours = Math.round(heures / 24);
    return `il y a ${jours} j`;
  }

  private rang(d: Demande): number {
    if (d.status === 'ACCEPTED') return 0; // un accord non affecté attend un geste
    if (d.status === 'SUBMITTED' || d.status === 'NEGOTIATING') return 1;
    if (d.status === 'CONVERTED') return 2;
    return 3;
  }
}
