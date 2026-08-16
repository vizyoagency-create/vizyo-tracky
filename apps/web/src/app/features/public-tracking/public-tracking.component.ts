import { HttpClient } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import type { PublicTrackingDto } from '@vizyo/tracky-shared';
import { firstValueFrom } from 'rxjs';
import { PublicTrackingMapComponent } from './public-tracking-map.component';

/**
 * Lot A4 — la page publique `/s/:token`.
 *
 * ┌─ ELLE S'OUVRE DEPUIS UN SMS, SUR UN TÉLÉPHONE, PAR QUELQU'UN QUI ATTEND ──┐
 * │ Pas de compte, pas de menu, pas de formulaire, pas de lien vers            │
 * │ l'application. Une carte, une heure d'arrivée, et quand le lien expire.    │
 * │                                                                            │
 * │ Et surtout : LA PAGE NE POSE RIEN sur l'appareil du destinataire. Aucun    │
 * │ cookie, aucun stockage local, aucune mesure d'audience. Il n'a rien        │
 * │ demandé, il n'a consenti à rien — il a reçu un lien (A4 § 6).              │
 * └────────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─ LES QUATRE ÉTATS, ET POURQUOI TROIS SONT IDENTIQUES ─────────────────────┐
 * │ actif → carte. Expiré, révoqué, introuvable → LE MÊME ÉCRAN.               │
 * │                                                                            │
 * │ Distinguer « ce lien a été révoqué » de « ce lien n'existe pas » dirait    │
 * │ qu'il a existé, donc que cette mission existe — et permettrait d'énumérer   │
 * │ les tokens en lisant les différences. Le serveur répond `410` dans les      │
 * │ trois cas ; l'écran dit la même chose.                                     │
 * └────────────────────────────────────────────────────────────────────────────┘
 */

/** Polling, pas de WebSocket : un socket non authentifié serait une surface d'attaque
 *  disproportionnée pour un point sur une carte (A4 § 3). */
const PERIODE_POLLING_MS = 20_000;

type Etat = 'chargement' | 'actif' | 'ferme';

@Component({
  selector: 'app-public-tracking',
  standalone: true,
  imports: [PublicTrackingMapComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="pt">
      @switch (etat()) {
        @case ('chargement') {
          <div class="pt-centre">
            <div class="sk pt-sk"></div>
            <p class="pt-attente">Chargement du suivi…</p>
          </div>
        }

        @case ('ferme') {
          <!-- L'écran des TROIS états fermés. Aucun bouton de renouvellement : le
               destinataire n'a pas ce droit, et le lui proposer serait une impasse. -->
          <div class="pt-centre">
            <span class="pt-ico" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                   stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
              </svg>
            </span>
            <h1>Ce lien de suivi a expiré</h1>
            <p>Demandez-en un nouveau à votre expéditeur.</p>
          </div>
        }

        @case ('actif') {
          <header class="pt-tete">
            <span class="pt-transporteur">{{ suivi()!.carrierName }}</span>
          </header>

          <app-public-tracking-map
            class="pt-carte"
            [position]="suivi()!.position"
            [enRetard]="suivi()!.status === 'LATE'"
          />

          <!-- ═══ LE BANDEAU BAS — ce que le destinataire vient chercher ═════ -->
          <footer class="pt-bandeau">
            <p class="pt-statut" [class]="classeStatut()">{{ libelleStatut() }}</p>

            @if (suivi()!.status === 'PLANNED') {
              <p class="pt-arrivee">Le suivi démarrera à {{ heure(suivi()!.startAt) }}</p>
            } @else if (suivi()!.status === 'DONE') {
              <p class="pt-arrivee">Livraison effectuée à {{ heure(suivi()!.etaAt) }}</p>
            } @else if (suivi()!.status === 'CANCELLED') {
              <p class="pt-arrivee pt-arrivee--annule">
                Cette livraison a été annulée. Contactez votre expéditeur.
              </p>
            } @else {
              <p class="pt-arrivee">
                Arrivée estimée <strong>{{ heure(suivi()!.etaAt) }}</strong>
              </p>
            }

            <p class="pt-destination">Destination · {{ suivi()!.destinationLabel }}</p>

            <!-- Jamais un point périmé présenté comme actuel (A4 § 8). -->
            @if (positionPerimee(); as minutes) {
              <p class="pt-perime">Position indisponible depuis {{ minutes }} min</p>
            }

            <p class="pt-expire">Ce lien expire à {{ heure(suivi()!.expiresAt) }}</p>
          </footer>
        }
      }
    </div>
  `,
  styles: [`
    /* Cette page vit HORS du shell : elle porte donc ses propres fondations, sans
       supposer qu'un layout parent ait pose une hauteur ou un fond. */
    :host { display: block; position: fixed; inset: 0; background: var(--surface-primary) }
    .pt { display: flex; flex-direction: column; height: 100%; height: 100dvh }

    .pt-tete {
      flex: 0 0 auto; padding: 14px 18px calc(14px + env(safe-area-inset-top));
      padding-top: calc(14px + env(safe-area-inset-top));
    }
    /* Le transporteur assume sa livraison — mais DISCRETEMENT : le destinataire vient
       voir un camion, pas une marque (A4 § 6). */
    .pt-transporteur {
      font-size: 13px; font-weight: 700; letter-spacing: .01em; color: var(--text-secondary);
    }

    .pt-carte { flex: 1; min-height: 0; display: block }

    .pt-bandeau {
      flex: 0 0 auto; display: flex; flex-direction: column; gap: 5px;
      padding: 16px 18px calc(18px + env(safe-area-inset-bottom));
      background: var(--surface-secondary);
      border-top: 1px solid var(--border-color);
      box-shadow: 0 -8px 28px rgba(0, 0, 0, .12);
    }
    .pt-statut {
      margin: 0; font-size: 12px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
      color: var(--text-secondary);
    }
    /* ⚠️ Les alias --depot-* sont definis SOUS .layout--depot, et cette page est
       PUBLIQUE : elle vit hors du shell, donc sans cette classe. Les variables y
       etaient vides et le repli gagnait — mesure a 3,43:1 et 3,02:1 en theme
       clair, sur le seul ecran que voit le destinataire du lien. On emploie donc
       les jetons GLOBAUX, qui existent partout. */
    .pt-statut--route { color: var(--texte-succes) }
    .pt-statut--retard { color: var(--texte-alerte) }
    .pt-arrivee {
      margin: 0; font-family: var(--font-display); font-size: 21px; font-weight: 800;
      letter-spacing: -.02em; line-height: 1.2; color: var(--text-primary);
    }
    .pt-arrivee strong { color: var(--texte-succes) }
    .pt-arrivee--annule { font-size: 16px; font-weight: 700 }
    .pt-destination { margin: 2px 0 0; font-size: 13px; color: var(--text-secondary) }
    .pt-perime { margin: 4px 0 0; font-size: 12.5px; font-weight: 600; color: var(--texte-attente) }
    .pt-expire { margin: 6px 0 0; font-size: 11.5px; color: var(--text-secondary) }

    .pt-centre {
      flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 12px; padding: 40px 24px; text-align: center;
    }
    .pt-ico {
      display: grid; place-items: center; width: 56px; height: 56px; border-radius: 18px;
      background: var(--surface-tertiary); color: var(--text-secondary);
    }
    .pt-centre h1 {
      margin: 0; font-family: var(--font-display); font-size: 20px; font-weight: 800;
      letter-spacing: -.02em; color: var(--text-primary);
    }
    .pt-centre p { margin: 0; font-size: 14px; line-height: 1.6; color: var(--text-secondary) }
    .pt-sk { width: 200px; height: 14px; border-radius: 7px }
    .pt-attente { font-size: 13px }

    /* 360 px : le plus petit ecran courant. L'arrivee doit rester lisible SANS
       defilement — c'est le critere de recette n° 10. */
    @media (max-height: 640px) {
      .pt-arrivee { font-size: 19px }
      .pt-bandeau { padding-top: 12px; gap: 3px }
    }
  `],
})
export class PublicTrackingComponent implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly http = inject(HttpClient);

  protected readonly suivi = signal<PublicTrackingDto | null>(null);
  protected readonly etat = signal<Etat>('chargement');
  private readonly maintenant = signal(Date.now());

  /**
   * Minutes depuis la derniere position connue, quand elle est trop vieille pour etre
   * presentee comme actuelle.
   *
   * ⚠️ CALCULE PAR LE SERVEUR, pas ici. Il ne sert pas l'horodatage d'un point qu'il
   * refuse de servir : le client n'a donc rien a soustraire. Et c'est le serveur qui
   * sait distinguer « le boitier s'est tu » (duree affichable) de « suivi suspendu »
   * (aucune duree — elle apprendrait quand le conducteur est passe en prive).
   */
  protected readonly positionPerimee = computed(() => this.suivi()?.positionUnavailableSince ?? null);

  protected readonly classeStatut = computed(() => {
    switch (this.suivi()?.status) {
      case 'LATE':
        return 'pt-statut--retard';
      case 'IN_PROGRESS':
        return 'pt-statut--route';
      default:
        return '';
    }
  });

  private timer: ReturnType<typeof setInterval> | null = null;
  private tic: ReturnType<typeof setInterval> | null = null;

  ngOnInit(): void {
    void this.charger();
    this.timer = setInterval(() => void this.charger(), PERIODE_POLLING_MS);
    this.tic = setInterval(() => this.maintenant.set(Date.now()), 30_000);
  }

  ngOnDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.tic) clearInterval(this.tic);
  }

  private async charger(): Promise<void> {
    const token = this.route.snapshot.paramMap.get('token');
    if (!token) {
      this.etat.set('ferme');
      return;
    }
    try {
      const reponse = await firstValueFrom(
        this.http.get<PublicTrackingDto>(`/api/public/track/${encodeURIComponent(token)}`),
      );
      this.suivi.set(reponse);
      this.maintenant.set(Date.now());
      this.etat.set('actif');
    } catch {
      // ⚠️ AUCUNE distinction ici non plus. Le serveur renvoie `410` pour expire,
      // revoque et inexistant ; le client n'a pas a inventer une nuance que le
      // protocole refuse d'exprimer. Toute erreur mene au meme ecran, et le polling
      // s'arrete : un lien ferme ne se rouvre pas.
      this.etat.set('ferme');
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  }

  protected heure(iso: string | null): string {
    if (!iso) return '—';
    return new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  protected libelleStatut(): string {
    const s = this.suivi();
    if (!s) return '';
    switch (s.status) {
      case 'PLANNED':
        return 'Livraison planifiée';
      case 'IN_PROGRESS':
        return 'En route';
      case 'LATE':
        return this.retardLisible(s);
      case 'DONE':
        return 'Livrée';
      case 'CANCELLED':
        return 'Annulée';
    }
  }

  /** « En retard de 22 min » — l'ecart, pas seulement l'etiquette : c'est ce que le
   *  destinataire veut savoir quand il attend. */
  private retardLisible(s: PublicTrackingDto): string {
    const minutes = Math.max(0, Math.floor((this.maintenant() - new Date(s.etaAt ?? '').getTime()) / 60_000));
    return minutes > 0 ? `En retard de ${minutes} min` : 'En retard';
  }
}
