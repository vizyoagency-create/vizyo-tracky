import { ChangeDetectionStrategy, Component, effect, inject, untracked } from '@angular/core';
import { URGENCE_TEL_AFFICHE, urgenceWhatsappLien } from '../../core/config/assistance-urgence';
import { AssistanceApiService } from '../../core/services/assistance.service';
import { AuthService } from '../../core/services/auth.service';
import { MiseAJourEnCoursService } from '../../core/services/mise-a-jour-en-cours.service';

/**
 * L'écran affiché quand l'API ne répond plus — incident CDEF31 du 24/09/2026.
 *
 * Il remplace ce qui se passait avant : rien. L'application restait à l'écran, apparemment
 * normale, et se dégradait en silence.
 *
 * Trois partis pris :
 *   1. PLEIN ÉCRAN ET NON REFERMABLE. Il n'y a rien d'utile à faire derrière — les boutons
 *      afficheraient un état périmé et les commandes ne partiraient pas. Laisser l'opérateur
 *      cliquer dans une application morte est ce qui a coûté la nuit du 24/09.
 *   2. AUCUN BOUTON « RÉESSAYER ». La sonde tourne toute seule et recharge dès le retour ; un
 *      bouton n'accélérerait rien et suggérerait qu'il faut agir.
 *   3. LE MESSAGE DISTINGUE LES DEUX CAUSES. « Mise à jour en cours » quand c'est nous,
 *      « connexion perdue » quand c'est le réseau du poste : accuser le mauvais coupable ferait
 *      perdre du temps à 3 h du matin.
 */
@Component({
  selector: 'app-mise-a-jour-overlay',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (service.indisponible()) {
      <div class="maj-fond" role="alertdialog" aria-modal="true" aria-live="assertive"
           [attr.aria-label]="service.horsLigne() ? 'Connexion perdue' : 'Mise à jour en cours'">
        <div class="maj-carte">
          <div class="maj-anneau" aria-hidden="true"></div>

          @if (service.horsLigne()) {
            <h1 class="maj-titre">Connexion perdue</h1>
            <p class="maj-texte">
              Votre appareil n’a plus accès au réseau. L’application reprendra toute seule
              dès que la connexion reviendra.
            </p>
          } @else {
            <h1 class="maj-titre">Mise à jour en cours</h1>
            <p class="maj-texte">
              Tracky est en train d’être mis à jour. L’écran se rechargera tout seul dans
              quelques secondes — <strong>ne fermez pas cette page</strong>.
            </p>
            <p class="maj-note">
              Les véhicules ne sont pas affectés : les coupures et rallumages déjà envoyés
              restent en place.
            </p>
          }

          <!--
            Le numéro vient de « assistance-urgence.ts », jamais écrit ici. Le 27/09 cet écran
            est parti en production avec un numéro INVENTÉ, proche du vrai : un numéro codé en
            dur se relit comme du décor, personne ne le vérifie.
          -->
          <!--
            L'appui est signalé (01/10/2026) — et comme l'API est justement à terre ici, il est
            RETENU puis retransmis à son retour, avec son heure réelle. data-no-track : la trace
            vient du serveur, la capture automatique des clics la doublerait.
          -->
          <a class="maj-secours" [href]="lienWhatsapp" target="_blank" rel="noopener"
             data-no-track (click)="signaler()">
            Véhicule bloqué pendant ce temps&nbsp;?
            <strong>WhatsApp {{ telAffiche }}</strong> — 24&nbsp;h/24
          </a>
        </div>
      </div>
    }
  `,
  styles: [
    `
    /* Jetons du thème, SANS repli en dur (06/10/2026). Cet écran est un composant de
       l'application : il n'existe qu'une fois Angular démarré, et ne s'affiche qu'après 6 s
       d'API injoignable. La feuille globale est alors chargée — servie avec la page par le
       conteneur web, qui ne dépend pas de l'API, ou par le service worker, dans le même groupe
       « app-shell » que le code. Les replis ne pouvaient donc jamais servir ; et ils copiaient
       un thème sombre qui n'est pas le nôtre, faux en thème clair s'ils avaient servi. */
    .maj-fond {
      position: fixed; inset: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      background: var(--bg-primary);
      /* Opaque : rien derrière ne doit être cliquable, ni même lisible — l'écran du dessous
         affiche un état périmé, et c'est précisément ce qui trompe l'opérateur. */
    }
    .maj-carte {
      max-width: 420px; width: 100%; text-align: center;
      display: flex; flex-direction: column; align-items: center; gap: 14px;
    }
    .maj-anneau {
      width: 44px; height: 44px; border-radius: 9999px;
      border: 3px solid var(--border-subtle);
      border-top-color: var(--texte-succes);
      animation: maj-tourne 900ms linear infinite;
    }
    @keyframes maj-tourne { to { transform: rotate(360deg); } }
    /* Un mouvement perpétuel peut gêner ; le message porte l'information, pas l'animation. */
    @media (prefers-reduced-motion: reduce) {
      .maj-anneau { animation: none; border-top-color: var(--texte-succes); }
    }
    .maj-titre {
      margin: 0; font-size: 19px; font-weight: 700; line-height: 1.25;
      color: var(--fg-primary);
    }
    .maj-texte {
      margin: 0; font-size: 14px; line-height: 1.55; text-wrap: pretty;
      color: var(--fg-secondary);
    }
    .maj-note {
      margin: 0; font-size: 12.5px; line-height: 1.5; text-wrap: pretty;
      color: var(--fg-tertiary);
    }
    /* C'est un LIEN, et sur un téléphone il doit se toucher : 44 px de haut, pas une ligne de
       texte de 12 px. C'est le seul geste utile de cet écran. */
    .maj-secours {
      display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 4px;
      margin: 6px 0 0; padding: 12px 8px 4px; min-height: 44px;
      font-size: 12.5px; line-height: 1.5; text-align: center; text-decoration: none;
      border-top: 1px solid var(--border-subtle); width: 100%;
      color: var(--fg-secondary);
    }
    .maj-secours strong { color: var(--fg-primary); }
    .maj-secours:hover strong { text-decoration: underline; }
    `,
  ],
})
export class MiseAJourOverlayComponent {
  protected readonly service = inject(MiseAJourEnCoursService);
  protected readonly telAffiche = URGENCE_TEL_AFFICHE;
  protected readonly lienWhatsapp = urgenceWhatsappLien();

  private readonly assistance = inject(AssistanceApiService);
  private readonly auth = inject(AuthService);

  constructor() {
    // Un appui fait sur cet écran n'a pas pu partir — l'API ne répondait plus. Il repart dès
    // qu'une session existe : au rechargement que cet écran déclenche lui-même au retour de
    // l'API, ou à la connexion suivante si la session s'était perdue entre-temps.
    effect(() => {
      if (this.auth.isAuthenticated()) untracked(() => this.assistance.retransmettreAppuiRetenu());
    });
  }

  /** Signale l'appui, sans retenir le clic : WhatsApp s'ouvre dans le même geste. */
  protected signaler(): void {
    this.assistance.signalerUrgenceWhatsapp('mise-a-jour');
  }
}
