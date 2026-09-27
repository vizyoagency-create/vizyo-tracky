import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
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

          <p class="maj-secours">
            Urgence véhicule pendant ce temps : <strong>WhatsApp 06 56 69 16 15</strong>
          </p>
        </div>
      </div>
    }
  `,
  styles: [
    `
    .maj-fond {
      position: fixed; inset: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
      padding: 24px;
      background: var(--bg-primary, #0b0f14);
      /* Opaque : rien derrière ne doit être cliquable, ni même lisible — l'écran du dessous
         affiche un état périmé, et c'est précisément ce qui trompe l'opérateur. */
    }
    .maj-carte {
      max-width: 420px; width: 100%; text-align: center;
      display: flex; flex-direction: column; align-items: center; gap: 14px;
    }
    .maj-anneau {
      width: 44px; height: 44px; border-radius: 9999px;
      border: 3px solid var(--border-subtle, #2a3340);
      border-top-color: var(--texte-succes, #34d399);
      animation: maj-tourne 900ms linear infinite;
    }
    @keyframes maj-tourne { to { transform: rotate(360deg); } }
    /* Un mouvement perpétuel peut gêner ; le message porte l'information, pas l'animation. */
    @media (prefers-reduced-motion: reduce) {
      .maj-anneau { animation: none; border-top-color: var(--texte-succes, #34d399); }
    }
    .maj-titre {
      margin: 0; font-size: 19px; font-weight: 700; line-height: 1.25;
      color: var(--fg-primary, #e6edf3);
    }
    .maj-texte {
      margin: 0; font-size: 14px; line-height: 1.55; text-wrap: pretty;
      color: var(--fg-secondary, #9aa7b4);
    }
    .maj-note {
      margin: 0; font-size: 12.5px; line-height: 1.5; text-wrap: pretty;
      color: var(--fg-tertiary, #7b8794);
    }
    .maj-secours {
      margin: 6px 0 0; padding-top: 12px; font-size: 12.5px; line-height: 1.5;
      border-top: 1px solid var(--border-subtle, #2a3340); width: 100%;
      color: var(--fg-secondary, #9aa7b4);
    }
    `,
  ],
})
export class MiseAJourOverlayComponent {
  protected readonly service = inject(MiseAJourEnCoursService);
}
