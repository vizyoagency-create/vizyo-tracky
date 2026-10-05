import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { AlertTriangle, FileText, LucideAngularModule, MessageSquare } from 'lucide-angular';
import { CONTACT_EMAIL, type UrgenceWhatsappEcran } from '@vizyo/tracky-shared';
import { URGENCE_TEL_AFFICHE, urgenceWhatsappLien } from '../../core/config/assistance-urgence';
import { AssistanceApiService } from '../../core/services/assistance.service';

/**
 * ══ LA LIGNE D'URGENCE VÉHICULE ══════════════════════════════════════════════════════════════
 *
 * Née de l'incident CDEF31 du 24/09/2026 : une veilleuse de nuit est restée vingt minutes devant
 * une application qui lui mentait, puis a cherché sur internet comment déverrouiller un véhicule
 * par SMS. Il n'existait aucun numéro en dehors des heures de bureau — elle l'a écrit noir sur
 * blanc. Le numéro a été communiqué à CDEF31 le 30/09 et transmis par eux aux agents de nuit.
 *
 * ── POURQUOI CE BLOC DIT AUSSI CE QU'IL N'EST PAS ────────────────────────────────────────────
 *
 * Une ligne d'astreinte 24 h/24 qui se remplit de questions cesse d'être une ligne d'astreinte :
 * elle devient un standard, et elle ne répond plus à 3 h du matin. La séparation entre
 * « véhicule immobilisé » et « question sur l'application » n'est donc pas une mise en forme,
 * c'est ce qui garde la ligne utile. Elle est écrite en donnant la RAISON — « laissez la ligne
 * libre pour quelqu'un devant une voiture qui ne démarre pas » — parce qu'une interdiction sans
 * raison se contourne, tandis qu'une raison se respecte.
 *
 * ── DEUX FORMES, UN SEUL NUMÉRO ──────────────────────────────────────────────────────────────
 *
 * `complet` : sur l'écran Assistance, en tête, avec ses explications.
 * `bandeau` : sur `/vehicles`, pour le VEILLEUR DE NUIT — qui ne peut atteindre AUCUNE autre
 *   page (`watchmanChildGuard`, allowlist default-deny). Mettre le numéro seulement dans
 *   l'écran Assistance l'aurait privé de la seule chose qui lui servait. C'est exactement
 *   l'erreur de l'incident, refaite un cran plus loin.
 */
@Component({
  selector: 'app-urgence-vehicule',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [LucideAngularModule],
  // `data-no-track` sur les deux liens WhatsApp (01/10/2026) : l'appui est TRACÉ par le serveur
  // (type URGENCE_WHATSAPP, écrit par l'API, impossible à forger depuis un lot du navigateur) et
  // pousse une notification aux super-admins. Laisser aussi la capture automatique des clics
  // l'écrire donnerait deux lignes pour un seul geste — dont une, CLICK, noyée dans le bruit.
  template: `
    @if (variante() === 'bandeau') {
      <a [href]="lienWhatsapp" target="_blank" rel="noopener" class="urg-bandeau"
         data-no-track (click)="signaler('vehicules')">
        <lucide-icon [img]="AlertTriangle" [size]="15" class="shrink-0" />
        <span class="urg-bandeau-t">
          Véhicule bloqué&nbsp;? <strong>WhatsApp {{ tel }}</strong>
          <span class="urg-bandeau-h">— assistance 24&nbsp;h/24</span>
        </span>
      </a>
    } @else {
      <section class="urg-carte" aria-labelledby="urg-titre">
        <div class="urg-tete">
          <span class="urg-ico"><lucide-icon [img]="AlertTriangle" [size]="17" /></span>
          <div>
            <h2 id="urg-titre" class="urg-titre">Véhicule bloqué — urgence 24&nbsp;h/24</h2>
            <p class="urg-sous">
              Un véhicule ne redémarre pas, le rallumage à distance ne passe pas, quelqu'un est
              immobilisé&nbsp;: écrivez sur WhatsApp, à n'importe quelle heure, week-end compris.
            </p>
          </div>
        </div>

        <!--
          UN SEUL CANAL, ET C'EST WHATSAPP. Un bouton « Appeler » a existé ici quelques heures ;
          il a été retiré le 30/09/2026 quand la fiche remise au client a été arrêtée sur
          « WhatsApp uniquement ». Deux promesses différentes pour le même numéro, c'est la
          garantie qu'une des deux sera fausse un jour — et celle qu'on vérifie le moins est
          toujours celle qui est à l'écran.
          WhatsApp laisse en plus une trace écrite, horodatée, avec la plaque : au téléphone,
          à 3 h du matin, la plaque se perd.
        -->
        <a [href]="lienWhatsapp" target="_blank" rel="noopener" class="urg-btn urg-btn-1"
           data-no-track (click)="signaler('assistance')">
          <lucide-icon [img]="MessageSquare" [size]="16" />
          Écrire sur WhatsApp — {{ tel }}
        </a>

        <p class="urg-astuce">
          Indiquez la <strong>plaque</strong>, où vous êtes et ce que vous voyez&nbsp;: c'est ce
          qui permet d'agir tout de suite.
        </p>

        <a class="urg-fiche" href="/fiche-urgence-nuit.html" target="_blank" rel="noopener">
          <lucide-icon [img]="FileText" [size]="14" />
          <span>Lire ou imprimer la fiche d'urgence <span class="urg-fiche-h">— à garder près des clés</span></span>
        </a>

        <!--
          La frontière, avec sa raison. Sans elle, la ligne d'astreinte devient un standard
          et cesse de répondre la nuit — au moment précis où elle est le dernier recours.
        -->
        <p class="urg-limite">
          Cette ligne est réservée aux <strong>véhicules immobilisés</strong>. Pour une question
          sur l'application, passez par l'assistant ci-dessous ou écrivez à
          <a [href]="lienEmail">{{ email }}</a> — et laissez la ligne libre pour quelqu'un debout
          devant une voiture qui ne démarre pas.
        </p>
      </section>
    }
  `,
  styles: [
    `
    /* ── Bandeau (veilleur, liste des véhicules) ───────────────────────────────────────── */
    .urg-bandeau {
      display: flex; align-items: center; gap: 8px; width: 100%;
      min-height: 44px; padding: 8px 12px; border-radius: 10px; text-decoration: none;
      border: 1px solid color-mix(in srgb, var(--texte-danger, #f87171) 30%, transparent);
      background: color-mix(in srgb, var(--texte-danger, #f87171) 8%, transparent);
      color: var(--fg-secondary);
    }
    .urg-bandeau lucide-icon { color: var(--texte-danger, #f87171); }
    .urg-bandeau-t { font-size: 12.5px; line-height: 1.4; text-wrap: pretty; }
    .urg-bandeau-t strong { color: var(--fg-primary); }
    /* Sur un téléphone étroit, la mention d'horaire passe à la ligne plutôt que de tronquer
       le numéro — c'est le numéro qui doit rester lisible en entier. */
    .urg-bandeau-h { color: var(--fg-tertiary); }
    @media (max-width: 380px) { .urg-bandeau-h { display: block; } }

    /* ── Carte complète (écran Assistance) ─────────────────────────────────────────────── */
    .urg-carte {
      display: flex; flex-direction: column; gap: 12px;
      padding: 14px; border-radius: 12px;
      border: 1px solid color-mix(in srgb, var(--texte-danger, #f87171) 32%, transparent);
      background: color-mix(in srgb, var(--texte-danger, #f87171) 7%, transparent);
    }
    .urg-tete { display: flex; gap: 10px; align-items: flex-start; }
    .urg-ico {
      display: inline-flex; align-items: center; justify-content: center; flex: none;
      width: 30px; height: 30px; border-radius: 9px;
      background: color-mix(in srgb, var(--texte-danger, #f87171) 16%, transparent);
      color: var(--texte-danger, #f87171);
    }
    .urg-titre { margin: 0; font-size: 14.5px; font-weight: 650; color: var(--fg-primary); }
    .urg-sous {
      margin: 4px 0 0; font-size: 12.5px; line-height: 1.5;
      color: var(--fg-secondary); text-wrap: pretty;
    }

    /* UNE seule action, donc pleine largeur : il n'y a rien à arbitrer. Un peu plus haut que
       les 44 px réglementaires — c'est le geste utile de l'écran, il doit se toucher sans viser. */
    .urg-btn {
      display: flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 48px; padding: 12px 14px; border-radius: 10px;
      font-size: 14px; font-weight: 700; text-decoration: none; text-align: center;
      transition: background-color 120ms ease;
    }
    .urg-btn-1 {
      background: color-mix(in srgb, var(--texte-danger, #f87171) 20%, transparent);
      border: 1px solid color-mix(in srgb, var(--texte-danger, #f87171) 42%, transparent);
      color: var(--fg-primary);
    }
    .urg-btn-1:hover { background: color-mix(in srgb, var(--texte-danger, #f87171) 30%, transparent); }

    /* La fiche : présente, secondaire. Elle sert AVANT la panne, pas pendant. */
    .urg-fiche {
      display: flex; align-items: center; gap: 7px; min-height: 40px;
      font-size: 12px; line-height: 1.4; text-decoration: none;
      color: var(--fg-secondary);
    }
    .urg-fiche:hover { color: var(--fg-primary); text-decoration: underline; }
    .urg-fiche lucide-icon { flex: none; }
    .urg-fiche-h { color: var(--fg-tertiary); }
    @media (max-width: 400px) { .urg-fiche-h { display: none; } }

    .urg-astuce, .urg-limite {
      margin: 0; font-size: 11.5px; line-height: 1.5; text-wrap: pretty;
      color: var(--fg-tertiary);
    }
    .urg-limite {
      padding-top: 10px; border-top: 1px solid color-mix(in srgb, var(--fg-tertiary) 20%, transparent);
    }
    .urg-astuce strong, .urg-limite strong { color: var(--fg-secondary); }
    .urg-limite a { color: var(--texte-succes); text-decoration: none; }
    .urg-limite a:hover { text-decoration: underline; }
    `,
  ],
})
export class UrgenceVehiculeComponent {
  readonly variante = input<'complet' | 'bandeau'>('complet');
  /** Pré-remplit la plaque dans WhatsApp quand l'écran appelant la connaît. */
  readonly plaque = input<string | undefined>(undefined);

  protected readonly AlertTriangle = AlertTriangle;
  protected readonly MessageSquare = MessageSquare;
  protected readonly FileText = FileText;

  protected readonly tel = URGENCE_TEL_AFFICHE;
  protected readonly email = CONTACT_EMAIL;
  protected readonly lienEmail = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent('Question sur Tracky')}`;
  protected get lienWhatsapp(): string {
    return urgenceWhatsappLien(this.plaque());
  }

  private readonly assistance = inject(AssistanceApiService);

  /**
   * Prévient le serveur qu'on ouvre la ligne d'urgence. Ne retient PAS le clic : pas de
   * `preventDefault`, pas d'attente — WhatsApp s'ouvre dans le même geste, que l'API réponde ou
   * non. Le signalement est un témoin, jamais une étape à franchir avant d'être aidé.
   */
  protected signaler(ecran: UrgenceWhatsappEcran): void {
    this.assistance.signalerUrgenceWhatsapp(ecran, this.plaque());
  }
}
